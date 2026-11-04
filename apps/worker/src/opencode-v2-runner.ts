import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentCancelledError } from '@agent-tasks/agent-runtime';
import { parseModelVariant, ProviderError } from '@agent-tasks/ai-providers';
import type { AgentRunResult, RunAgentOptions } from '@agent-tasks/agent-runtime';
import { OpenCodeV2Client, OpenCodeV2Error } from './opencode-v2-client.js';
import type { OpenCodeV2Model } from './opencode-v2-client.js';
import type { OpenCodeExecutionLease, OpenCodeSessionStore } from './opencode-session-store.js';

const MESSAGE_POLL_MS = 100;

/**
 * OpenCode runner for a dedicated, isolated server. Structured output (sources,
 * e-mail blocks, memory proposals) is produced by worker-hosted MCP tools and
 * merged by the isolated-runtime wrapper; this runner only owns the session,
 * prompt dispatch, recovery and durable-message parsing.
 *
 * Recovery is idempotent: the message ID is persisted before the first dispatch,
 * replayed prompts are rejected by OpenCode with HTTP 409, and a completed
 * assistant message is the only terminal state we accept.
 */
export function createOpenCodeV2Runner(config: { client: OpenCodeV2Client; directory: string; model: OpenCodeV2Model; store?: OpenCodeSessionStore; requiresMcp?: boolean }) {
  return async (options: RunAgentOptions, lease?: OpenCodeExecutionLease): Promise<AgentRunResult> => {
    // `options.model` may carry the `#variant` suffix; the runtime knows only the
    // base catalog id and receives the variant separately. Re-check both here so a
    // provisioner that drops or rewrites either value can never run silently.
    const requested = parseModelVariant(options.model);
    if (requested.model !== config.model.id || requested.variant !== config.model.variant) {
      throw new Error('OpenCode model does not match the task model');
    }
    const timeoutSignal = AbortSignal.timeout(options.limits.maxDurationSec * 1_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const cancellation = (): AgentCancelledError => new AgentCancelledError(timeoutSignal.aborted ? 'timeout' : 'cancelled');
    if (signal.aborted) throw cancellation();
    // OpenCode connects MCP servers lazily and snapshots the tool catalog when a
    // session is created. Wait for the bridge before creating the session, or the
    // model never sees the tool.
    if (config.requiresMcp) {
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (signal.aborted) throw cancellation();
        const status = await config.client.getMcpStatus(signal).catch(() => undefined);
        const servers = status && typeof status === 'object' && 'data' in status ? status.data : undefined;
        const connected = Array.isArray(servers) && servers.some((server: unknown) => {
          const state = typeof server === 'object' && server !== null && 'status' in server ? server.status : undefined;
          return typeof state === 'object' && state !== null && 'status' in state && state.status === 'connected';
        });
        if (connected) {
          // `connected` precedes the catalog import; give tools/list a moment to land.
          await delay(250, undefined, { signal }).catch(() => { throw cancellation(); });
          break;
        }
        if (Date.now() >= deadline) throw new Error('OpenCode MCP bridge did not connect');
        await delay(MESSAGE_POLL_MS, undefined, { signal }).catch(() => { throw cancellation(); });
      }
    }
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
      const assistants = response.data.filter(
        (message: unknown): message is AssistantMessage => typeof message === 'object' && message !== null && 'type' in message && message.type === 'assistant',
      );
      // OpenCode emits one assistant message per model turn (a tool-calling turn
      // then the final answer). Only `stop` is terminal; tool-call turns mean the
      // run is still in progress, and any other finish is a failure.
      const failed = assistants.find(
        (message) => message.error || (typeof message.finish === 'string' && !['stop', 'tool-calls', 'tool_calls'].includes(message.finish)),
      );
      if (failed) throw classifyFailure(failed.error ?? failed.finish);
      const terminal = assistants.find((message) => message.finish === 'stop');
      if (!terminal) return undefined;
      if (!Array.isArray(terminal.content)) throw new Error('OpenCode execution did not complete successfully');
      return await resultFromMessage(terminal, assistants, options, config);
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
  assistants: AssistantMessage[],
  options: RunAgentOptions,
  config: { model: OpenCodeV2Model; requiresMcp?: boolean },
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
  // A tool-using run returns one assistant message per model turn. The final
  // message carries the answer, but every turn consumed tokens and allowance,
  // so usage must be summed over the whole session response.
  const totals = assistants.reduce(
    (accumulator, assistant) => {
      const turnTokens: Record<string, unknown> = typeof assistant.tokens === 'object' && assistant.tokens !== null
        ? (assistant.tokens as Record<string, unknown>)
        : {};
      accumulator.promptTokens += tokenCount(turnTokens.input);
      accumulator.completionTokens += tokenCount(turnTokens.output) + tokenCount(turnTokens.reasoning);
      if (typeof assistant.cost === 'number' && Number.isFinite(assistant.cost) && assistant.cost >= 0) {
        accumulator.allowanceUsd += assistant.cost;
      }
      return accumulator;
    },
    { promptTokens: 0, completionTokens: 0, allowanceUsd: 0 },
  );
  return {
    markdown,
    summary: markdown.replace(/\s+/g, ' ').trim().slice(0, 400),
    sources: [],
    uncertainty: uncertaintyFromExecution(assistants, options, config.requiresMcp === true),
    steps: [step],
    usage: {
      ...(totals.promptTokens > 0 ? { promptTokens: totals.promptTokens } : {}),
      ...(totals.completionTokens > 0 ? { completionTokens: totals.completionTokens } : {}),
      ...(totals.promptTokens + totals.completionTokens > 0 ? { totalTokens: totals.promptTokens + totals.completionTokens } : {}),
      ...(totals.allowanceUsd > 0 ? { allowanceUsd: totals.allowanceUsd } : {}),
    },
    emailBlocks: [],
    memoryOps: [],
    recommendationOps: [],
    stopReason: 'completed',
  };
}

/** Tools the isolated runtime offers when the task allows web research. */
const RESEARCH_TOOLS = new Set([
  'search_web',
  'open_url',
  'extract_page_text',
  'inspect_page',
  'click_element',
  'fill_form',
  'navigate_back',
  'get_page_title',
  'get_current_url',
  'extract_links',
]);

/**
 * Only these tool calls can produce a persisted source in the tool bridge:
 * `open_url` always records the opened page, `click_element` records the target
 * when navigation returns a URL.
 */
const SOURCE_TOOLS = new Set(['open_url', 'click_element']);

type ToolPart = { name: string; status: string | undefined };

/**
 * OpenCode namespaces MCP tools with their server (for example
 * `agent_tasks_tools_open_url`). The server name is provisioner-controlled, so
 * match the canonical tool as a suffix instead of hard-coding one prefix.
 */
function canonicalToolName(name: string): string | undefined {
  if (RESEARCH_TOOLS.has(name)) return name;
  for (const tool of RESEARCH_TOOLS) {
    if (name.endsWith(`_${tool}`)) return tool;
  }
  return undefined;
}

/**
 * Read the durable tool parts OpenCode emits for a tool-calling assistant turn.
 * The message content is already the contract used for the final text; tool
 * parts add the tool name and its terminal status (`completed` or `error`).
 *
 * This deliberately does not inspect the model's prose. OpenCode has no
 * structured uncertainty field, so a model-written "Uncertainty" section stays
 * part of the Markdown report and is not copied into the structured report as
 * if it were machine-readable data.
 */
function toolPartsFrom(assistants: AssistantMessage[]): ToolPart[] {
  const parts: ToolPart[] = [];
  for (const assistant of assistants) {
    if (!Array.isArray(assistant.content)) continue;
    for (const part of assistant.content) {
      if (typeof part !== 'object' || part === null || !('type' in part) || part.type !== 'tool') continue;
      if (!('name' in part) || typeof part.name !== 'string' || part.name.length === 0) continue;
      const state = 'state' in part && typeof part.state === 'object' && part.state !== null
        ? (part.state as Record<string, unknown>)
        : undefined;
      parts.push({
        name: canonicalToolName(part.name) ?? part.name,
        status: state && typeof state.status === 'string' ? state.status : undefined,
      });
    }
  }
  return parts;
}

/**
 * Uncertainty notes derived only from facts this runner can verify:
 * the task's research permission and the durable tool calls OpenCode recorded.
 * An empty result means the run had verified pages and no failed research call;
 * it never means "the model declared no uncertainty", which is why model prose
 * is not used here.
 */
function uncertaintyFromExecution(
  assistants: AssistantMessage[],
  options: RunAgentOptions,
  requiresMcp: boolean,
): string[] {
  if (!options.allowWebResearch) {
    return ['Web research was disabled for this task, so the answer was not verified against external sources.'];
  }
  const parts = toolPartsFrom(assistants);
  // Every tool call creates a tool-calling assistant turn. If such a turn exists
  // but its parts are unreadable, the schema changed: report the limitation
  // rather than claiming research did not happen.
  const toolTurn = assistants.some((assistant) => assistant.finish === 'tool-calls' || assistant.finish === 'tool_calls');
  if (toolTurn && parts.length === 0) {
    return ['The runtime did not expose tool-call evidence, so it could not be confirmed whether web research was performed.'];
  }

  if (parts.length === 0) {
    // No tool call was reported. A tool-less client proves that no research ran.
    // With a bridge attached, the runtime may have invoked tools without
    // returning durable tool parts (the test fake does exactly that), so the
    // bridge could know about research this runner cannot see.
    if (requiresMcp) {
      return ['The runtime did not expose tool-call evidence, so it could not be confirmed whether web research was performed.'];
    }
    return ['No web research was performed, so no source was verified.'];
  }

  const research = parts.filter((part) => RESEARCH_TOOLS.has(part.name));
  if (research.length === 0) {
    return ['No web research was performed, so no source was verified.'];
  }

  const notes: string[] = [];
  const sourceCalls = research.filter((part) => SOURCE_TOOLS.has(part.name));
  if (sourceCalls.length === 0) {
    notes.push('No web page was opened, so no source was verified.');
  } else {
    const statusesKnown = sourceCalls.every((part) => part.status === 'completed' || part.status === 'error');
    // Do not turn an unreadable status into a claim that a page failed to open.
    if (statusesKnown && !sourceCalls.some((part) => part.status === 'completed')) {
      notes.push('No web page could be opened successfully, so no source was verified.');
    }
  }

  const failed = [...new Set(research.filter((part) => part.status === 'error').map((part) => part.name))];
  if (failed.length === 1) {
    notes.push(`A web research tool call failed during this run: ${failed[0]}. Evidence from that call may be missing.`);
  } else if (failed.length > 1) {
    notes.push(`Web research tool calls failed during this run: ${failed.join(', ')}. Evidence from those calls may be missing.`);
  }
  return notes;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Map a runtime-reported failure to the retry classes the Executor understands.
 * The provider response is produced inside the isolated runtime, so only its
 * terminal error payload is available here. Anything not clearly transient stays
 * a plain error (terminal), which is the safe default.
 */
function classifyFailure(error: unknown): Error {
  let text = '';
  try {
    text = typeof error === 'string' ? error : JSON.stringify(error) ?? '';
  } catch {
    text = '';
  }
  if (/\b429\b|rate[ _-]?limit/i.test(text)) {
    return new ProviderError('rate_limited', 'the model provider rate-limited the request');
  }
  if (/\b(502|503|504)\b|timed? ?out|timeout|overloaded|temporarily unavailable/i.test(text)) {
    return new ProviderError('unavailable', 'the model provider was temporarily unavailable');
  }
  return new Error('OpenCode execution did not complete successfully');
}
