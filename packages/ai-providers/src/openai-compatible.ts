import { normalizeArguments } from './ollama.js';
import { ProviderError } from './types.js';
import type { AiProvider, ChatMessage, ChatRequest, ChatResponse, ModelInfo, ProviderContext, ToolCallRequest, Usage } from './types.js';

interface ConfiguredModel {
  id: string;
  label?: string;
  supportsTools?: boolean;
  contextLength?: number;
}

/** Headers shared by every request; separated from the full config so tests can build them directly. */
export interface HeaderConfig {
  headers: Record<string, string>;
  userAgent: string;
  sessionHeader: string;
  organization?: string;
  /** Advertise `accept: text/event-stream`; only relevant for chat completions. */
  stream?: boolean;
}

interface CompatibleConfig extends HeaderConfig {
  baseUrl: string;
  timeoutMs: number;
  /**
   * Ask for a server-sent-events stream. Defaults to true because OpenCode Go
   * clients stream every completion; `stream: false` keeps the JSON path reachable.
   */
  stream: boolean;
  /** IDs of models this endpoint serves; used when the endpoint has no /models route. */
  models?: ConfiguredModel[];
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface CompletionToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface CompletionMessage {
  content?: string | null;
  tool_calls?: CompletionToolCall[];
}

interface StreamToolCallFragment {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface CompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: StreamToolCallFragment[] };
    message?: CompletionMessage;
    finish_reason?: string | null;
  }>;
  usage?: RawUsage;
  /** OpenCode Go may report usage and the remaining allowance on a side channel. */
  opencode?: { allowance?: number; usage?: RawUsage };
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  /** Arguments arrive as JSON fragments and are only parseable once concatenated. */
  arguments: string;
}

function readConfig(context: ProviderContext): CompatibleConfig {
  const raw = context.config as Partial<CompatibleConfig>;
  return {
    baseUrl: String(raw.baseUrl ?? 'http://localhost:8080/v1').replace(/\/+$/, ''),
    headers: raw.headers ?? {},
    userAgent: raw.userAgent ?? 'agent-tasks/0.1.0',
    sessionHeader: raw.sessionHeader ?? 'x-opencode-session',
    organization: raw.organization,
    timeoutMs: Number(raw.timeoutMs ?? 120_000),
    stream: raw.stream !== false,
    models: raw.models,
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')}/models`;
}

/**
 * The headers every OpenAI-compatible endpoint gets.
 *
 * OpenCode Go (https://opencode.ai/docs/go, "Where can I use it?") asks clients to
 * identify themselves with their own User-Agent instead of a generic SDK name and
 * to send a stable per-conversation id in `x-opencode-session`; both are part of
 * this adapter's contract and are covered by packages/mock-openai and this
 * package's opencode-go tests.
 *
 * Precedence: built-in defaults < provider `headers` < `authorization`,
 * `openai-organization` and the session header. A custom header may therefore
 * override `content-type`, `accept` or `user-agent`, but cannot silently replace
 * the credential or the conversation id the contract depends on.
 */
export function buildHeaders(config: HeaderConfig, apiKey: string | undefined, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: config.stream ? 'text/event-stream' : 'application/json',
    'user-agent': config.userAgent,
    ...config.headers,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (config.organization) headers['openai-organization'] = config.organization;
  if (config.sessionHeader) headers[config.sessionHeader] = sessionId;
  return headers;
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId ?? 'unknown' };
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function headerNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `retry-after` is either delta-seconds or an HTTP date; both are reduced to seconds. */
function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}

function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

const INSUFFICIENT_BALANCE = /insufficient|balance|credit|quota|payment|billing/i;

/**
 * Maps a non-2xx response onto the provider failure taxonomy. Always throws, so
 * callers never see a raw fetch/HTTP error.
 */
async function throwForStatus(response: Response): Promise<never> {
  const status = response.status;
  if (status === 429) {
    const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
    const message = retryAfter === undefined ? 'provider rate limit reached' : `provider rate limit reached; retry after ${retryAfter}s`;
    throw new ProviderError('rate_limited', message, status);
  }
  const text = await safeText(response);
  if (status === 401) {
    throw new ProviderError('auth', `provider rejected the credential: ${snippet(text) || 'no body'}`, status);
  }
  if (status === 402 || status === 403) {
    // OpenCode Go answers an exhausted account with 402/403 and an explicit body.
    // The failure union has no dedicated "insufficient_balance" code, so it is
    // reported as `auth` with a message that can be surfaced verbatim.
    if (status === 402 || INSUFFICIENT_BALANCE.test(text)) {
      throw new ProviderError('auth', `provider reports insufficient balance (HTTP ${status}): ${snippet(text) || 'no body'}`, status);
    }
    throw new ProviderError('auth', 'provider rejected the credential', status);
  }
  if (status >= 500) {
    throw new ProviderError('unavailable', `provider unavailable (HTTP ${status}): ${snippet(text) || 'no body'}`, status);
  }
  throw new ProviderError('bad_response', `provider HTTP ${status}: ${snippet(text)}`, status);
}

function applyUsage(target: Usage, raw: RawUsage | undefined): void {
  if (!raw) return;
  if (typeof raw.prompt_tokens === 'number') target.promptTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === 'number') target.completionTokens = raw.completion_tokens;
  if (typeof raw.total_tokens === 'number') target.totalTokens = raw.total_tokens;
}

function toToolCalls(
  calls: Array<{ index?: number; id?: string; name?: string; arguments: unknown }>,
  fallbackIds = true,
): ToolCallRequest[] {
  return calls.map((call, index) => ({
    id: call.id ?? (fallbackIds ? `call_${index}_${Date.now()}` : `call_${index}`),
    name: call.name ?? 'unknown',
    arguments: normalizeArguments(call.arguments),
  }));
}

/**
 * Incremental SSE parser. Events are separated by blank lines and `data:` lines
 * are concatenated per the SSE specification. The parser keeps no state beyond a
 * text buffer, so chunk boundaries may fall anywhere.
 */
function nextEvent(buffer: string): { event: string; rest: string } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match || match.index === undefined) return undefined;
  return { event: buffer.slice(0, match.index), rest: buffer.slice(match.index + match[0].length) };
}

function eventData(event: string): string | undefined {
  const lines = event.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length > 0 ? data.join('\n') : undefined;
}

async function readStream(response: Response, callerSignal: AbortSignal | undefined): Promise<ChatResponse> {
  if (!response.body) throw new ProviderError('bad_response', 'provider returned an empty stream', response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason: string | undefined;
  let sawDone = false;
  const usage: Usage = {};
  let allowance = headerNumber(response.headers.get('x-opencode-allowance'));
  const calls = new Map<number, ToolCallAccumulator>();

  const consume = (data: string): void => {
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    let chunk: CompletionChunk;
    try {
      chunk = JSON.parse(data) as CompletionChunk;
    } catch {
      throw new ProviderError('bad_response', `provider sent malformed stream event: ${snippet(data)}`, response.status);
    }
    const choice = chunk.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    const fragments = choice?.delta?.tool_calls ?? [];
    fragments.forEach((fragment, position) => {
      const index = typeof fragment.index === 'number' ? fragment.index : position;
      const current = calls.get(index) ?? { arguments: '' };
      if (fragment.id) current.id = fragment.id;
      if (fragment.function?.name) current.name = fragment.function.name;
      if (typeof fragment.function?.arguments === 'string') current.arguments += fragment.function.arguments;
      calls.set(index, current);
    });
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    applyUsage(usage, chunk.usage);
    applyUsage(usage, chunk.opencode?.usage);
    if (typeof chunk.opencode?.allowance === 'number' && Number.isFinite(chunk.opencode.allowance)) {
      allowance = chunk.opencode.allowance;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let next = nextEvent(buffer);
      while (next) {
        const data = eventData(next.event);
        if (data !== undefined) consume(data);
        buffer = next.rest;
        next = nextEvent(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      // Some servers omit the trailing blank line after the last event.
      const data = eventData(buffer);
      if (data !== undefined) consume(data);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ProviderError) throw error;
    const name = (error as Error).name;
    if (callerSignal?.aborted === true || name === 'AbortError' || name === 'TimeoutError') {
      throw new ProviderError('timeout', callerSignal?.aborted ? 'provider request aborted' : 'provider request timed out');
    }
    throw new ProviderError('bad_response', `provider stream failed: ${(error as Error).message}`, response.status);
  }

  const terminal = sawDone || finishReason !== undefined;
  if (!terminal) throw new ProviderError('bad_response', 'provider stream ended before a terminal event', response.status);

  const ordered = [...calls.entries()].sort((left, right) => left[0] - right[0]).map(([, value]) => value);
  usage.allowanceUsd = Number.isFinite(allowance) ? allowance : undefined;
  return {
    content,
    toolCalls: toToolCalls(ordered),
    finishReason,
    usage,
  };
}

function parseCompletion(payload: CompletionChunk, response: Response): ChatResponse {
  const choice = payload.choices?.[0];
  const usage: Usage = {};
  applyUsage(usage, payload.usage);
  applyUsage(usage, payload.opencode?.usage);
  const headerAllowance = headerNumber(response.headers.get('x-opencode-allowance'));
  const allowance = typeof payload.opencode?.allowance === 'number' ? payload.opencode.allowance : headerAllowance;
  usage.allowanceUsd = Number.isFinite(allowance) ? allowance : undefined;
  return {
    content: choice?.message?.content ?? '',
    toolCalls: toToolCalls(
      (choice?.message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments,
      })),
    ),
    finishReason: choice?.finish_reason ?? undefined,
    usage,
  };
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly kind = 'openai-compatible';

  async health(context: ProviderContext): Promise<{ ok: boolean; message: string }> {
    const config = readConfig(context);
    try {
      const response = await fetch(modelsUrl(config.baseUrl), {
        headers: buildHeaders({ ...config, stream: false }, context.apiKey, 'health'),
        signal: AbortSignal.timeout(Math.min(config.timeoutMs, 10_000)),
      });
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
      return { ok: true, message: 'reachable' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  async listModels(context: ProviderContext): Promise<ModelInfo[]> {
    const config = readConfig(context);
    const configured = config.models ?? [];
    try {
      const response = await fetch(modelsUrl(config.baseUrl), {
        headers: buildHeaders({ ...config, stream: false }, context.apiKey, 'discovery'),
        signal: AbortSignal.timeout(Math.min(config.timeoutMs, 15_000)),
      });
      if (!response.ok) {
        if (configured.length > 0) return configured.map((model) => this.toModelInfo(model));
        throw new ProviderError('unavailable', `model discovery failed: HTTP ${response.status}`, response.status);
      }
      const payload = (await response.json()) as { data?: Array<{ id?: string; name?: string }> };
      const discovered = (Array.isArray(payload.data) ? payload.data : [])
        .map((entry) => entry.id ?? entry.name)
        .filter((id): id is string => Boolean(id));
      if (discovered.length === 0 && configured.length > 0) return configured.map((model) => this.toModelInfo(model));
      return discovered.map((id) => {
        const declared = configured.find((model) => model.id === id);
        return {
          id,
          label: declared?.label ?? id,
          // Unknown is not the same as supported: only a declaration may claim tool support.
          supportsTools: declared?.supportsTools ?? false,
          contextLength: declared?.contextLength,
        };
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (configured.length > 0) return configured.map((model) => this.toModelInfo(model));
      throw new ProviderError('unavailable', `model discovery failed: ${(error as Error).message}`);
    }
  }

  private toModelInfo(model: ConfiguredModel): ModelInfo {
    return {
      id: model.id,
      label: model.label ?? model.id,
      supportsTools: model.supportsTools ?? false,
      contextLength: model.contextLength,
    };
  }

  async chat(context: ProviderContext, request: ChatRequest): Promise<ChatResponse> {
    const config = readConfig(context);
    const declared = config.models?.find((model) => model.id === request.model);
    if (request.tools && request.tools.length > 0 && declared && declared.supportsTools === false) {
      throw new ProviderError('unsupported', `model ${request.model} is not declared as tool-capable`);
    }
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOpenAiMessage),
      temperature: request.temperature ?? 0.2,
      stream: config.stream,
    };
    if (config.stream) body.stream_options = { include_usage: true };
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs)])
      : AbortSignal.timeout(config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(chatCompletionsUrl(config.baseUrl), {
        method: 'POST',
        headers: buildHeaders(config, context.apiKey, request.sessionId),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new ProviderError('timeout', request.signal?.aborted ? 'provider request aborted' : 'provider request timed out');
      }
      throw new ProviderError('unavailable', `provider unreachable: ${(error as Error).message}`);
    }
    if (!response.ok) await throwForStatus(response);

    const contentType = response.headers.get('content-type') ?? '';
    if (config.stream && contentType.includes('text/event-stream')) {
      return readStream(response, request.signal);
    }

    let payload: CompletionChunk;
    try {
      payload = (await response.json()) as CompletionChunk;
    } catch (error) {
      throw new ProviderError('bad_response', `provider returned malformed JSON: ${(error as Error).message}`, response.status);
    }
    return parseCompletion(payload, response);
  }
}
