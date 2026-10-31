import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * A real HTTP stand-in for an OpenCode Go endpoint (`{baseUrl}/chat/completions`,
 * `{baseUrl}/models`), including the streaming protocol the Go clients use.
 *
 * It is deliberately strict: requests with a generic SDK User-Agent, without the
 * `x-opencode-session` header, or with a session id that changes mid-conversation
 * are rejected with HTTP 400 and a JSON error. That makes a header regression a
 * failing test instead of a silent pass. Every request is captured so tests can
 * assert the exact wire contract (path, headers, parsed body).
 */

export type OpenCodeGoFailure =
  | 'none'
  | 'unauthorized'
  | 'rate_limited'
  | 'insufficient_balance'
  | 'server_error'
  | 'malformed_json'
  | 'truncated_stream';

export interface ScenarioToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface OpenCodeGoScenario {
  /** `/models` payload; `not_found` simulates a Go endpoint without discovery. */
  models: Array<{ id: string }> | 'not_found';
  content: string;
  toolCalls: ScenarioToolCall[];
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  allowanceUsd: number;
  /** Send `x-opencode-allowance` on completion responses. */
  allowanceHeader: boolean;
  /** Report usage/allowance inside the `opencode` object instead of OpenAI's `usage`. */
  opencodeUsage: boolean;
  /** Status used for the insufficient-balance failure (OpenCode Go uses 402/403). */
  insufficientBalanceStatus: 402 | 403;
  failure: OpenCodeGoFailure;
  /** Value of `retry-after` on a 429. */
  retryAfterSeconds: number;
  /** Delay between SSE chunks, so cancellation can be observed. */
  streamDelayMs: number;
  /** Delay before the completion is answered at all. */
  latencyMs: number;
}

export interface RecordedOpenCodeGoRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
  receivedAt: number;
}

export interface OpenCodeGoServer {
  /** `http://127.0.0.1:<port>` without a path suffix. */
  url: string;
  port: number;
  requests: RecordedOpenCodeGoRequest[];
  scenario: OpenCodeGoScenario;
  reset(): void;
  close(): Promise<void>;
}

const GENERIC_AGENTS = ['node', 'undici', 'axios', 'openai-node', 'python-requests', 'okhttp', 'curl', 'wget', 'go-http-client', 'node-fetch'];
const SESSION_HEADER = 'x-opencode-session';

function collectBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  response.end(body);
}

function sendSse(response: ServerResponse, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentPieces(content: string): string[] {
  const pieces = content.match(/\S+\s*/g);
  return pieces && pieces.length > 0 ? pieces : content ? [content] : [];
}

/** Splits the serialised arguments so the client must concatenate before parsing. */
function argumentPieces(raw: string): string[] {
  if (raw.length < 2) return [raw];
  const middle = Math.ceil(raw.length / 2);
  return [raw.slice(0, middle), raw.slice(middle)];
}

function chunk(message: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: `chatcmpl_${randomUUID()}`,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: message, finish_reason: finishReason }],
  };
}

function usagePayload(scenario: OpenCodeGoScenario): Record<string, unknown> {
  return {
    prompt_tokens: scenario.promptTokens,
    completion_tokens: scenario.completionTokens,
    total_tokens: scenario.totalTokens,
  };
}

function completionMeta(scenario: OpenCodeGoScenario): Record<string, unknown> {
  const usage = usagePayload(scenario);
  const opencode = scenario.opencodeUsage ? { usage, allowance: scenario.allowanceUsd } : { allowance: scenario.allowanceUsd };
  return {
    ...(scenario.opencodeUsage ? {} : { usage }),
    opencode,
  };
}

async function streamCompletion(response: ServerResponse, scenario: OpenCodeGoScenario): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...(scenario.allowanceHeader ? { 'x-opencode-allowance': String(scenario.allowanceUsd) } : {}),
  });

  if (scenario.failure === 'malformed_json') {
    response.write('data: {"choices":[{"delta":{"content":"broken\n\n');
    response.end();
    return;
  }
  if (scenario.failure === 'truncated_stream') {
    sendSse(response, chunk({ content: 'partial answer' }));
    await sleep(5);
    response.destroy();
    return;
  }

  for (const piece of contentPieces(scenario.content)) {
    sendSse(response, chunk({ content: piece }));
    if (scenario.streamDelayMs > 0) await sleep(scenario.streamDelayMs);
    if (response.destroyed) return;
  }

  for (const [index, call] of scenario.toolCalls.entries()) {
    const pieces = argumentPieces(JSON.stringify(call.arguments));
    const [first = '', ...rest] = pieces;
    sendSse(
      response,
      chunk({
        tool_calls: [
          {
            index,
            id: `call_${index}_${randomUUID().slice(0, 8)}`,
            type: 'function',
            function: { name: call.name, arguments: first },
          },
        ],
      }),
    );
    if (scenario.streamDelayMs > 0) await sleep(scenario.streamDelayMs);
    for (const piece of rest) {
      sendSse(response, chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
      if (scenario.streamDelayMs > 0) await sleep(scenario.streamDelayMs);
    }
    if (response.destroyed) return;
  }

  sendSse(response, { ...chunk({}, scenario.finishReason), ...completionMeta(scenario) });
  if (!response.destroyed) response.write('data: [DONE]\n\n');
  response.end();
}

async function nonStreamCompletion(response: ServerResponse, scenario: OpenCodeGoScenario): Promise<void> {
  const headers: Record<string, string> = scenario.allowanceHeader ? { 'x-opencode-allowance': String(scenario.allowanceUsd) } : {};
  if (scenario.failure === 'truncated_stream') {
    response.writeHead(200, { 'content-type': 'application/json', ...headers });
    response.write('{"choices":[{"message":{"content":"partial');
    await sleep(5);
    response.destroy();
    return;
  }
  if (scenario.failure === 'malformed_json') {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(200, { 'content-type': 'application/json', ...headers });
    response.end('{"choices":[{"message":');
    return;
  }
  sendJson(
    response,
    200,
    {
      id: `chatcmpl_${randomUUID()}`,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: scenario.content,
            ...(scenario.toolCalls.length > 0
              ? {
                  tool_calls: scenario.toolCalls.map((call, index) => ({
                    id: `call_${index}_${randomUUID().slice(0, 8)}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  })),
                }
              : {}),
          },
          finish_reason: scenario.finishReason,
        },
      ],
      ...completionMeta(scenario),
    },
    headers,
  );
}

function failureResponse(response: ServerResponse, scenario: OpenCodeGoScenario): void {
  switch (scenario.failure) {
    case 'unauthorized':
      sendJson(response, 401, { error: { message: 'invalid api key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      return;
    case 'rate_limited':
      sendJson(
        response,
        429,
        { error: { message: 'rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' } },
        { 'retry-after': String(scenario.retryAfterSeconds) },
      );
      return;
    case 'insufficient_balance':
      sendJson(response, scenario.insufficientBalanceStatus, {
        error: { message: 'insufficient balance: top up your OpenCode Go account', type: 'insufficient_quota', code: 'insufficient_balance' },
      });
      return;
    case 'server_error':
      sendJson(response, 500, { error: { message: 'internal server error', type: 'server_error' } });
      return;
    default:
      return;
  }
}

function conversationKey(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : [];
  const anchor = messages[0];
  return `${String(body.model ?? '')}|${String(anchor?.content ?? '')}`;
}

export async function createOpenCodeGoServer(options: Partial<OpenCodeGoScenario> = {}): Promise<OpenCodeGoServer> {
  const scenario: OpenCodeGoScenario = {
    models: [{ id: 'opencode-go-heavy' }, { id: 'opencode-go-light' }],
    content: 'Hello from the fake OpenCode Go endpoint.',
    toolCalls: [],
    finishReason: 'stop',
    promptTokens: 41,
    completionTokens: 9,
    totalTokens: 50,
    allowanceUsd: 1.2345,
    allowanceHeader: true,
    opencodeUsage: false,
    insufficientBalanceStatus: 402,
    failure: 'none',
    retryAfterSeconds: 17,
    streamDelayMs: 0,
    latencyMs: 0,
    ...options,
  };
  const requests: RecordedOpenCodeGoRequest[] = [];
  const sessionByConversation = new Map<string, string>();

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const raw = await collectBody(request);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let body: Record<string, unknown> | null = null;
      if (raw.length > 0) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
        } catch {
          body = null;
        }
      }
      requests.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        headers: request.headers,
        body,
        receivedAt: Date.now(),
      });

      /* ---------------------------- wire contract ---------------------------- */
      const userAgent = String(request.headers['user-agent'] ?? '').toLowerCase();
      if (!userAgent || GENERIC_AGENTS.some((agent) => userAgent.startsWith(agent))) {
        sendJson(response, 400, {
          error: {
            message: userAgent ? `generic User-Agent "${userAgent}" is not accepted; identify your client` : 'missing User-Agent',
            type: 'invalid_request_error',
          },
        });
        return;
      }
      const sessionId = request.headers[SESSION_HEADER];
      if (!sessionId || Array.isArray(sessionId)) {
        sendJson(response, 400, { error: { message: `missing ${SESSION_HEADER} header`, type: 'invalid_request_error' } });
        return;
      }

      if (url.pathname.endsWith('/models')) {
        if (scenario.models === 'not_found') {
          sendJson(response, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
          return;
        }
        sendJson(response, 200, {
          object: 'list',
          data: scenario.models.map((model) => ({ id: model.id, object: 'model', owned_by: 'opencode-go-tests' })),
        });
        return;
      }

      if (!url.pathname.endsWith('/chat/completions') || request.method !== 'POST') {
        sendJson(response, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
        return;
      }

      const key = conversationKey(body ?? {});
      const previous = sessionByConversation.get(key);
      if (previous !== undefined && previous !== sessionId) {
        sendJson(response, 400, { error: { message: 'session id changed mid-conversation', type: 'invalid_request_error' } });
        return;
      }
      sessionByConversation.set(key, String(sessionId));

      if (scenario.failure !== 'none' && scenario.failure !== 'malformed_json' && scenario.failure !== 'truncated_stream') {
        failureResponse(response, scenario);
        return;
      }
      if (scenario.latencyMs > 0) await sleep(scenario.latencyMs);
      if (response.destroyed) return;

      if ((body ?? {}).stream === true) await streamCompletion(response, scenario);
      else await nonStreamCompletion(response, scenario);
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: { message: 'fake server failure', type: 'server_error' } });
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake OpenCode Go server did not bind a TCP port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    scenario,
    reset(): void {
      requests.length = 0;
      sessionByConversation.clear();
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
