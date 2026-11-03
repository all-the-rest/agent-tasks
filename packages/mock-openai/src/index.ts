import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface RecordedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
  receivedAt: number;
}

export interface MockOpenAiOptions {
  /**
   * Interface to bind. Defaults to `0.0.0.0` so the compose API and worker can
   * reach the mock through the Docker bridge gateway, not only loopback.
   */
  host?: string;
  /** Port to listen on. Defaults to an ephemeral port. */
  port?: number;
  /**
   * Origin advertised in `url`. Use it when the caller reaches the server through
   * a different address than the bind interface (for example a Docker gateway).
   */
  publicOrigin?: string;
  /** Reject requests whose User-Agent looks like a generic SDK instead of a client. */
  requireClientUserAgent?: boolean;
  /** Require a stable conversation id in this header (OpenCode Go: `x-opencode-session`). */
  sessionHeader?: string;
  /** Accept only these bearer tokens; anything else (including no token) gets a 401. */
  acceptedApiKeys?: string[];
  /** Reject a session id that changes mid-conversation (when the client echoes prior ids). */
  requireStableSession?: boolean;
  /** Number of research tool calls before the final answer. */
  researchSteps?: number;
  /** Forces the URL the scripted model opens (used to exercise the SSRF policy). */
  openUrl?: string;
  allowanceUsd?: number;
  /** Deterministic failure injection: requests with this ordinal fail. */
  failAtIndex?: number;
  failWithStatus?: number;
  /** Adds latency so cancellation and timeouts can be exercised. */
  latencyMs?: number;
  /** Emit one add_email_block tool call before the final answer. */
  emailBlock?: Record<string, unknown>;
  /** Emit one compose_email (DSL) tool call before the final answer. */
  emailDsl?: string;
  /** Structured task-memory operations emitted once per conversation. */
  memoryOps?: Array<Record<string, unknown>>;
  /** Structured recommendation operations emitted once per conversation. */
  recommendationOps?: Array<Record<string, unknown>>;
}

const GENERIC_AGENTS = ['node', 'undici', 'axios', 'openai-node', 'python-requests', 'okhttp', 'curl', 'wget', 'go-http-client'];

export interface MockServer {
  url: string;
  close(): Promise<void>;
  requests: RecordedRequest[];
  reset(): void;
}

function collectBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  response.end(body);
}

interface MockUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface MockCompletion {
  stream: boolean;
  model: string;
  content: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  finishReason: string;
  usage: MockUsage;
  allowanceUsd: number;
}

/**
 * Emits either the plain JSON completion (unchanged behaviour) or an OpenAI-style
 * `text/event-stream`. Tool-call arguments are split across chunks on purpose:
 * clients must concatenate fragments before parsing them.
 */
function sendCompletion(response: ServerResponse, completion: MockCompletion): void {
  const headers = { 'x-opencode-allowance': String(completion.allowanceUsd) };
  const toolCalls = completion.toolCalls ?? [];
  if (!completion.stream) {
    json(
      response,
      200,
      {
        id: `chatcmpl_${randomUUID()}`,
        object: 'chat.completion',
        model: completion.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: completion.content,
              ...(toolCalls.length > 0
                ? {
                    tool_calls: toolCalls.map((call, index) => ({
                      id: `call_${index}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                    })),
                  }
                : {}),
            },
            finish_reason: completion.finishReason,
          },
        ],
        usage: completion.usage,
        opencode: { allowance: completion.allowanceUsd },
      },
      headers,
    );
    return;
  }

  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...headers });
  const id = `chatcmpl_${randomUUID()}`;
  const emit = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
    if (response.destroyed || response.writableEnded) return;
    response.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: completion.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
    );
  };
  for (const piece of completion.content.match(/\S+\s*/g) ?? (completion.content ? [completion.content] : [])) {
    emit({ content: piece });
  }
  toolCalls.forEach((call, index) => {
    const raw = JSON.stringify(call.arguments);
    const middle = Math.ceil(raw.length / 2);
    emit({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: raw.slice(0, middle) } }] });
    emit({ tool_calls: [{ index, function: { arguments: raw.slice(middle) } }] });
  });
  emit({}, completion.finishReason);
  if (!response.destroyed && !response.writableEnded) {
    response.end(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: completion.model, choices: [], usage: completion.usage, opencode: { allowance: completion.allowanceUsd } })}\n\ndata: [DONE]\n\n`,
    );
  }
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
  return [...new Set(matches)];
}

function toolContent(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content ?? ''))
    .join('\n');
}

/**
 * A deterministic OpenAI-compatible endpoint used by integration and E2E tests.
 *
 * It is not a stub inside production code: it is a real HTTP server, and the
 * production adapter talks to it exactly like it talks to OpenAI or OpenCode Go.
 * It enforces the two extra requirements those endpoints publish (honest client
 * User-Agent, stable `x-opencode-session` header), so a regression in the adapter
 * fails the test instead of passing silently.
 */
export function createMockOpenAiServer(options: MockOpenAiOptions = {}): Promise<MockServer> {
  const sessionHeader = (options.sessionHeader ?? 'x-opencode-session').toLowerCase();
  const requireClientUserAgent = options.requireClientUserAgent ?? true;
  const requireStableSession = options.requireStableSession ?? true;
  const researchSteps = options.researchSteps ?? 2;
  const allowanceUsd = options.allowanceUsd ?? 0.0021;
  const requests: RecordedRequest[] = [];
  const sessionByConversation = new Map<string, string>();

  const server: Server = createServer(async (request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const raw = await collectBody(request).catch(() => '');
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    requests.push({ path, headers: request.headers, body: parsed, receivedAt: Date.now() });

    if (options.acceptedApiKeys
      && !options.acceptedApiKeys.some((key) => request.headers.authorization === `Bearer ${key}`)) {
      // A revoked credential must look like a revoked credential, not like an
      // anonymous request: the endpoint rejects it before any work happens.
      json(response, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });
      return;
    }

    const ordinal = requests.length - 1;
    if (options.failAtIndex !== undefined && ordinal === options.failAtIndex) {
      json(response, options.failWithStatus ?? 500, { error: { message: 'injected failure', type: 'server_error' } });
      return;
    }
    if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));

    const userAgent = String(request.headers['user-agent'] ?? '').toLowerCase();
    if (requireClientUserAgent) {
      if (!userAgent) {
        json(response, 400, { error: { message: 'missing User-Agent', type: 'invalid_request_error' } });
        return;
      }
      if (GENERIC_AGENTS.some((agent) => userAgent.startsWith(agent))) {
        json(response, 400, {
          error: { message: `generic User-Agent "${userAgent}" is not accepted; identify your client`, type: 'invalid_request_error' },
        });
        return;
      }
    }

    const sessionId = request.headers[sessionHeader];
    if (!sessionId || Array.isArray(sessionId)) {
      json(response, 400, { error: { message: `missing ${sessionHeader} header`, type: 'invalid_request_error' } });
      return;
    }

    if (path.endsWith('/models')) {
      json(response, 200, {
        object: 'list',
        data: [
          { id: 'mock-researcher', object: 'model', owned_by: 'agent-tasks-tests' },
          { id: 'mock-text-only', object: 'model', owned_by: 'agent-tasks-tests' },
        ],
      });
      return;
    }

    if (!path.endsWith('/chat/completions')) {
      json(response, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
      return;
    }

    const body = parsed ?? {};
    const stream = body.stream === true;
    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown; tool_call_id?: string }>) : [];
    const conversation = messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content ?? ''))
      .join('|');
    const previous = sessionByConversation.get(conversation);
    if (requireStableSession && previous && previous !== sessionId) {
      json(response, 409, { error: { message: 'session id changed mid-conversation', type: 'invalid_request_error' } });
      return;
    }
    sessionByConversation.set(conversation, String(sessionId));

    const toolMessages = messages.filter((message) => message.role === 'tool');
    const emailBlockRequested = messages.some(
      (message) =>
        Array.isArray((message as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls) &&
        (message as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls?.some(
          (call) => call.function?.name === 'add_email_block' || call.function?.name === 'compose_email',
        ),
    );
    const taskMemoryRequested = messages.some(
      (message) =>
        Array.isArray((message as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls) &&
        (message as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls?.some(
          (call) => call.function?.name === 'record_task_memory' || call.function?.name === 'track_recommendation',
        ),
    );
    const systemPrompt = messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content ?? ''))
      .join('\n');
    const sawTaskMemory = /TASK MEMORY/.test(systemPrompt) && /\[task:/.test(systemPrompt);
    const sawRecommendations = /PREVIOUS RECOMMENDATIONS/.test(systemPrompt) && /\bkey=/.test(systemPrompt);
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const research = toolContent(messages);
    const urls = extractUrls(research);
    const model = String(body.model ?? 'mock-researcher');

    if (model === 'mock-text-only') {
      sendCompletion(response, {
        stream,
        model,
        content: 'I cannot browse the web.',
        finishReason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
        allowanceUsd,
      });
      return;
    }

    if (toolMessages.length < researchSteps) {
      const step = toolMessages.length;
      const toolCall =
        step === 0
          ? { name: 'search_web', arguments: { query: String(lastUser?.content ?? 'current events').slice(0, 120) } }
          : {
              name: 'open_url',
              arguments: { url: options.openUrl ?? urls[Math.min(step - 1, Math.max(urls.length - 1, 0))] ?? 'https://example.com' },
            };
      sendCompletion(response, {
        stream,
        model,
        content: step === 0 ? 'I will search for current sources.' : 'I will open the next source.',
        toolCalls: [toolCall],
        finishReason: 'tool_calls',
        usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
        allowanceUsd,
      });
      return;
    }

    if (!taskMemoryRequested && ((options.memoryOps?.length ?? 0) > 0 || (options.recommendationOps?.length ?? 0) > 0)) {
      const toolCalls = [
        ...(options.memoryOps ?? []).map((arguments_) => ({ name: 'record_task_memory', arguments: arguments_ })),
        ...(options.recommendationOps ?? []).map((arguments_) => ({ name: 'track_recommendation', arguments: arguments_ })),
      ];
      sendCompletion(response, {
        stream,
        model,
        content: 'I will record structured task memory and recommendation state for the next run.',
        toolCalls,
        finishReason: 'tool_calls',
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        allowanceUsd,
      });
      return;
    }

    if (options.emailDsl && !emailBlockRequested) {
      sendCompletion(response, {
        stream,
        model,
        content: 'I will compose the notification e-mail from the DSL.',
        toolCalls: [{ name: 'compose_email', arguments: { dsl: options.emailDsl } }],
        finishReason: 'tool_calls',
        usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
        allowanceUsd,
      });
      return;
    }

    if (options.emailBlock && !emailBlockRequested) {
      sendCompletion(response, {
        stream,
        model,
        content: 'I will add an image block to the notification e-mail.',
        toolCalls: [{ name: 'add_email_block', arguments: options.emailBlock }],
        finishReason: 'tool_calls',
        usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
        allowanceUsd,
      });
      return;
    }

    const cited = urls.slice(0, 5);
    const citations = cited.map((url, index) => `${index + 1}. ${url}`).join('\n');
    const answer = [
      '## Findings',
      '',
      `Researched sources for: ${String(lastUser?.content ?? '').slice(0, 200)}`,
      '',
      cited.length > 0 ? 'Verified against the pages below.' : 'No page content was available.',
      '',
      ...(sawTaskMemory ? ['Previous task memory was provided to this run.'] : []),
      ...(sawRecommendations ? ['Existing tracked recommendations were recognized; unchanged items are not reported as new.'] : []),
      ...(sawTaskMemory || sawRecommendations ? [''] : []),
      '## Sources',
      '',
      citations || '- none',
    ].join('\n');

    sendCompletion(response, {
      stream,
      model,
      content: answer,
      finishReason: 'stop',
      usage: { prompt_tokens: 300, completion_tokens: 180, total_tokens: 480 },
      allowanceUsd,
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port ?? 0, options.host ?? '0.0.0.0', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        reject(new Error('could not determine mock server port'));
        return;
      }
      const origin = (options.publicOrigin ?? `http://127.0.0.1:${address.port}`).replace(/\/+$/, '');
      resolve({
        url: `${origin}/v1`,
        requests,
        reset() {
          requests.length = 0;
          sessionByConversation.clear();
        },
        close() {
          return new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          });
        },
      });
    });
  });
}
