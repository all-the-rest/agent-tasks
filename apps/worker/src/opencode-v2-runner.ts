import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentCancelledError } from '@agent-tasks/agent-runtime';
import type { AgentRunResult, RunAgentOptions } from '@agent-tasks/agent-runtime';
import { OpenCodeV2Client, OpenCodeV2Error } from './opencode-v2-client.js';
import type { OpenCodeV2Model } from './opencode-v2-client.js';
import type { OpenCodeExecutionLease, OpenCodeSessionStore } from './opencode-session-store.js';

const MESSAGE_POLL_MS = 100;

/**
 * Text-only OpenCode runner. The caller must supply a dedicated, isolated
 * OpenCode server. Tool calls, memory, e-mail and browser work are rejected
 * until the MCP bridge exists (see #23).
 *
 * Recovery is idempotent: the message ID is persisted before the first dispatch,
 * replayed prompts are rejected by OpenCode with HTTP 409, and a completed
 * assistant message is the only terminal state we accept.
 */
export function createOpenCodeV2Runner(config: { client: OpenCodeV2Client; directory: string; model: OpenCodeV2Model; store?: OpenCodeSessionStore }) {
  return async (options: RunAgentOptions, lease?: OpenCodeExecutionLease): Promise<AgentRunResult> => {
    if (options.model !== config.model.id) throw new Error('OpenCode spike model does not match the task model');
    if (options.allowWebResearch || options.memoryEnabled || options.memoryContext || options.emailNotification) {
      throw new Error('OpenCode spike only supports text-only tasks without memory or email');
    }
    const timeoutSignal = AbortSignal.timeout(options.limits.maxDurationSec * 1_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const cancellation = (): AgentCancelledError => new AgentCancelledError(timeoutSignal.aborted ? 'timeout' : 'cancelled');
    if (signal.aborted) throw cancellation();
    if (config.store && !lease) throw new Error('OpenCode execution lease required');
    let mapping = config.store && lease ? await config.store.access(lease) : null;
    if (!mapping) {
      const session = await config.client.createSession({ directory: config.directory, model: config.model }, signal);
      const candidate = { sessionId: session.id, messageId: `msg_${randomUUID().replaceAll('-', '')}`, promptDispatched: false };
      mapping = config.store && lease ? await config.store.access(lease, candidate) : candidate;
      if (!mapping) throw new Error('OpenCode session mapping unavailable');
    }

    const readTerminal = async (): Promise<AgentRunResult | undefined> => {
      const response = await config.client.getMessages(mapping.sessionId, signal);
      if (typeof response !== 'object' || response === null || !('data' in response) || !Array.isArray(response.data)) {
        throw new Error('Invalid OpenCode messages response');
      }
      for (const message of response.data) {
        if (typeof message !== 'object' || message === null || message.type !== 'assistant' || !message.finish) continue;
        if (message.finish !== 'stop' || message.error || !Array.isArray(message.content)) {
          throw new Error('OpenCode execution did not complete successfully');
        }
        return await resultFromMessage(message, options, config);
      }
      return undefined;
    };

    try {
      // A worker may die after OpenCode accepted the prompt. The durable assistant
      // message is authoritative, so recover it before dispatching anything.
      const recovered = await readTerminal();
      if (recovered) return recovered;

      const dispatch = config.store && lease ? await config.store.claimPrompt(lease) : true;
      try {
        await config.client.prompt(mapping.sessionId, mapping.messageId, options.prompt, signal);
      } catch (error) {
        // A replayed prompt ID is a 409. It means an earlier attempt already
        // accepted this exact message, so waiting for its result is safe.
        if (!(error instanceof OpenCodeV2Error && error.status === 409)) throw error;
        if (dispatch && !(await readTerminal())) throw new Error('OpenCode rejected the prompt without a durable message');
      }

      for (;;) {
        if (signal.aborted) throw cancellation();
        const result = await readTerminal();
        if (result) return result;
        await delay(MESSAGE_POLL_MS, undefined, { signal }).catch(() => { throw cancellation(); });
      }
    } catch (error) {
      if (signal.aborted) {
        await config.client.interrupt(mapping.sessionId, AbortSignal.timeout(5_000)).catch(() => undefined);
        throw cancellation();
      }
      throw error;
    }
  };
}

type AssistantMessage = {
  content: unknown[];
  finish: string;
  error?: unknown;
  time?: { created?: unknown; completed?: unknown };
  tokens?: unknown;
  cost?: unknown;
};

async function resultFromMessage(
  message: AssistantMessage,
  options: RunAgentOptions,
  config: { model: OpenCodeV2Model },
): Promise<AgentRunResult> {
  const markdown = message.content
    .filter((part: unknown): part is { type: 'text'; text: string } => typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string')
    .map((part: { text: string }) => part.text).join('');
  if (!markdown || Buffer.byteLength(markdown) > options.limits.maxOutputBytes) throw new Error('Invalid OpenCode output');
  const startedAt = typeof message.time?.created === 'number' ? message.time.created : Date.now();
  const finishedAt = typeof message.time?.completed === 'number' ? message.time.completed : Date.now();
  const durationMs = Math.max(0, finishedAt - startedAt);
  const step = {
    step: 1,
    tool: 'opencode',
    arguments: { model: config.model.id },
    ok: true,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs,
    resultPreview: markdown.slice(0, 300),
  };
  await options.onStep?.(step);
  const tokens: Record<string, unknown> = typeof message.tokens === 'object' && message.tokens !== null
    ? (message.tokens as Record<string, unknown>)
    : {};
  const promptTokens = tokenCount(tokens.input);
  const completionTokens = tokenCount(tokens.output) + tokenCount(tokens.reasoning);
  const cost = typeof message.cost === 'number' && Number.isFinite(message.cost) && message.cost >= 0 ? message.cost : undefined;
  return {
    markdown,
    summary: markdown.replace(/\s+/g, ' ').trim().slice(0, 400),
    sources: [],
    uncertainty: [],
    steps: [step],
    usage: {
      ...(promptTokens > 0 ? { promptTokens } : {}),
      ...(completionTokens > 0 ? { completionTokens } : {}),
      ...(promptTokens + completionTokens > 0 ? { totalTokens: promptTokens + completionTokens } : {}),
      ...(cost !== undefined ? { allowanceUsd: cost } : {}),
    },
    emailBlocks: [],
    memoryOps: [],
    recommendationOps: [],
    stopReason: 'completed',
  };
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
