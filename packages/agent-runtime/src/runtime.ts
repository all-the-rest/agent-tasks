import { randomUUID } from 'node:crypto';
import { sanitizeText } from '@agent-tasks/shared';
import type { EmailBlock } from '@agent-tasks/shared';
import type { ChatMessage, ChatResponse, ToolDefinition, Usage } from '@agent-tasks/ai-providers';
import type { AiProvider, ProviderContext } from '@agent-tasks/ai-providers';
import type { BrowserRunnerClient, SearchProvider } from '@agent-tasks/browser-tools';
import { findTool, toolDefinitions } from './tools.js';
import type { ToolContext, ToolOutcome } from './tools.js';
import { buildSystemPrompt, buildUserMessage, wrapErrorResult, wrapToolResult } from './prompt.js';

export class AgentCancelledError extends Error {
  constructor(readonly reason: 'cancelled' | 'timeout' | 'step_limit' = 'cancelled') {
    super(reason === 'timeout' ? 'execution timed out' : reason === 'step_limit' ? 'agent step limit reached' : 'execution cancelled');
    this.name = 'AgentCancelledError';
  }
}

export interface AgentLimits {
  maxDurationSec: number;
  maxAgentSteps: number;
  maxPageVisits: number;
  maxOutputBytes: number;
  maxToolCalls: number;
  maxSearchQueries: number;
}

export interface AgentSource {
  url: string;
  title?: string;
  retrievedAt: string;
  confidence: 'verified' | 'secondary' | 'unknown';
  excerpt?: string;
}

export interface AgentStepRecord {
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: string;
  resultPreview?: string;
}

export interface AgentRunResult {
  markdown: string;
  summary: string;
  sources: AgentSource[];
  uncertainty: string[];
  steps: AgentStepRecord[];
  usage: Usage;
  emailBlocks: EmailBlock[];
  stopReason: 'completed' | 'step_limit';
}

export interface RunAgentOptions {
  provider: AiProvider;
  providerContext: ProviderContext;
  model: string;
  title: string;
  prompt: string;
  systemInstructions?: string | null;
  timezone: string;
  allowWebResearch: boolean;
  allowForms: boolean;
  /** Offer the e-mail block tool; the task notifies the owner by e-mail. */
  emailNotification?: boolean;
  limits: AgentLimits;
  browser: BrowserRunnerClient;
  sessionId: string;
  search: SearchProvider;
  signal?: AbortSignal;
  onStep?: (step: AgentStepRecord) => void | Promise<void>;
  now?: () => Date;
}

const MAX_MESSAGES = 60;

/**
 * Trim an old conversation without ever dropping the system prompt or splitting a turn.
 *
 * A turn is an assistant message plus every tool result that answers its `toolCalls`.
 * Dropping the assistant but keeping its tool results (or the reverse) leaves the model
 * with an invalid conversation; `slice(-MAX_MESSAGES)` could do exactly that. The leading
 * system/user head is fixed, and whole turns are removed oldest-first until the budget is
 * met. The newest turn is always kept whole, even if it alone exceeds the budget.
 */
export function trimConversation(messages: ChatMessage[], maxMessages: number = MAX_MESSAGES): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;

  let headEnd = 0;
  while (headEnd < messages.length && (messages[headEnd]?.role === 'system' || messages[headEnd]?.role === 'user')) headEnd += 1;
  const head = messages.slice(0, headEnd);
  const turns: ChatMessage[][] = [];
  for (const message of messages.slice(headEnd)) {
    if (message.role === 'assistant' || turns.length === 0) turns.push([message]);
    else turns[turns.length - 1]?.push(message);
  }

  let total = head.length + turns.reduce((sum, turn) => sum + turn.length, 0);
  while (total > maxMessages && turns.length > 1) {
    const dropped = turns.shift();
    total -= dropped?.length ?? 0;
  }
  return [...head, ...turns.flat()];
}

function dedupeSources(sources: AgentSource[]): AgentSource[] {
  const seen = new Map<string, AgentSource>();
  for (const source of sources) {
    const existing = seen.get(source.url);
    if (!existing || (source.title && !existing.title)) seen.set(source.url, source);
  }
  return [...seen.values()].slice(0, 50);
}

function summarise(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, 400);
}

/**
 * The real agent loop: model → validated tool call → tool → observation → model.
 * Every step is bounded by the task's limits and by the caller's abort signal.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const now = options.now ?? (() => new Date());
  const deadline = now().getTime() + options.limits.maxDurationSec * 1_000;
  const controller = new AbortController();

  // The controller can be aborted by the caller or by our own duration deadline. The
  // reason is remembered so the two cases never collapse into one: a provider adapter
  // maps an aborted request onto `ProviderError('timeout')`, which the worker would
  // otherwise retry as transient. Whichever fires first wins.
  let abortReason: 'timeout' | 'cancelled' | null = null;
  const abortWith = (reason: 'timeout' | 'cancelled'): void => {
    abortReason ??= reason;
    if (!controller.signal.aborted) controller.abort();
  };
  const onAbort = (): void => abortWith('cancelled');
  if (options.signal?.aborted) abortWith('cancelled');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => abortWith('timeout'), options.limits.maxDurationSec * 1_000);

  const cancelledError = (): AgentCancelledError => new AgentCancelledError(abortReason === 'timeout' ? 'timeout' : 'cancelled');
  const throwIfAborted = (): void => {
    if (abortReason !== null) throw cancelledError();
  };
  const throwIfPastDeadline = (): void => {
    if (now().getTime() > deadline) {
      abortWith('timeout');
      throw new AgentCancelledError('timeout');
    }
  };

  const sources: AgentSource[] = [];
  const steps: AgentStepRecord[] = [];
  const uncertainty: string[] = [];
  const queries: string[] = [];
  const visited = new Set<string>();
  const usage: Usage = {};
  let toolCallCount = 0;
  let index = 0;

  const allowedTools = [
    ...(options.emailNotification ? ['compose_email', 'add_email_block'] : []),
    ...(options.allowWebResearch
      ? ['search_web', 'open_url', 'extract_page_text', 'inspect_page', 'click_element', 'navigate_back', 'get_page_title', 'get_current_url', 'extract_links', ...(options.allowForms ? ['fill_form'] : [])]
      : []),
  ];
  const definitions: ToolDefinition[] = toolDefinitions(allowedTools);

  const toolContext: ToolContext = {
    browser: options.browser,
    sessionId: options.sessionId,
    search: options.search,
    allowForms: options.allowForms,
    visited,
    pageVisits: 0,
    queries,
    emailBlocks: [],
    limits: options.limits,
    onSource(source) {
      sources.push(source);
    },
  };

  const system = buildSystemPrompt({
    title: options.title,
    prompt: options.prompt,
    systemInstructions: options.systemInstructions ?? null,
    timezone: options.timezone,
    today: now().toISOString().slice(0, 10),
    allowWebResearch: options.allowWebResearch,
    emailNotification: options.emailNotification === true,
    toolNames: allowedTools,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    buildUserMessage(options.prompt),
  ];

  let finalText = '';
  let stopReason: AgentRunResult['stopReason'] = 'step_limit';

  try {
    for (let step = 1; step <= options.limits.maxAgentSteps; step += 1) {
      throwIfAborted();
      throwIfPastDeadline();
      let response: ChatResponse;
      try {
        response = await options.provider.chat(options.providerContext, {
          model: options.model,
          messages: trimConversation(messages, MAX_MESSAGES),
          tools: definitions,
          sessionId: options.sessionId,
          signal: controller.signal,
        });
      } catch (error) {
        // An abort-induced adapter failure (usually `ProviderError('timeout')`) is a
        // runtime cancellation, not a provider failure: the worker must not retry it.
        throwIfAborted();
        throw error;
      }
      // The provider may resolve a response after the abort was signalled; do not use it.
      throwIfAborted();
      usage.promptTokens = (usage.promptTokens ?? 0) + (response.usage?.promptTokens ?? 0) || undefined;
      usage.completionTokens = (usage.completionTokens ?? 0) + (response.usage?.completionTokens ?? 0) || undefined;
      usage.totalTokens = (usage.totalTokens ?? 0) + (response.usage?.totalTokens ?? 0) || undefined;
      usage.allowanceUsd = (usage.allowanceUsd ?? 0) + (response.usage?.allowanceUsd ?? 0) || undefined;

      if (response.toolCalls.length === 0) {
        finalText = response.content;
        stopReason = 'completed';
        break;
      }

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      };
      messages.push(assistantMessage);

      for (const call of response.toolCalls) {
        throwIfAborted();
        throwIfPastDeadline();
        toolCallCount += 1;
        if (toolCallCount > options.limits.maxToolCalls) throw new AgentCancelledError('step_limit');
        const tool = findTool(call.name);
        const startedAt = now().toISOString();
        const startMs = Date.now();
        let outcome: ToolOutcome;
        if (!tool || !allowedTools.includes(call.name)) {
          outcome = { ok: false, content: `unknown or forbidden tool ${call.name}`, preview: 'forbidden tool', error: 'forbidden_tool' };
        } else {
          try {
            outcome = await tool.run(call.arguments, toolContext);
          } catch (error) {
            outcome = { ok: false, content: (error as Error).message, preview: 'tool failed', error: (error as Error).message };
          }
        }
        index += 1;
        const record: AgentStepRecord = {
          step: index,
          tool: call.name,
          arguments: call.arguments,
          ok: outcome.ok,
          startedAt,
          finishedAt: now().toISOString(),
          durationMs: Date.now() - startMs,
          error: outcome.error,
          resultPreview: sanitizeText(outcome.preview, 500),
        };
        steps.push(record);
        await options.onStep?.(record);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: outcome.ok ? wrapToolResult(call.name, outcome.content) : wrapErrorResult(call.name, outcome.content),
        });
      }
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (stopReason === 'step_limit') {
    uncertainty.push('The agent step limit was reached before the model produced a final answer.');
  }
  if (queries.length === 0 && options.allowWebResearch) {
    uncertainty.push('No web search was performed, so no source was verified.');
  }
  const markdown = sanitizeText(finalText.trim() || 'No final answer was produced within the configured limits.', options.limits.maxOutputBytes);
  return {
    markdown,
    summary: summarise(markdown),
    sources: dedupeSources(sources),
    uncertainty,
    steps,
    usage,
    emailBlocks: toolContext.emailBlocks,
    stopReason,
  };
}

export function newSessionId(): string {
  return randomUUID();
}
