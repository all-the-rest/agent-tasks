import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A deterministic stand-in for the Ollama HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md).
 *
 * It is a real HTTP server on `127.0.0.1:0`, not a module stub: the production
 * adapter talks to it over fetch exactly like it talks to a real Ollama daemon.
 * The route shapes below follow the documented API (`/api/tags`, `/api/show`,
 * `/api/chat` with `stream:false` JSON or `stream:true` NDJSON), so a regression
 * in the adapter's wire handling fails a test instead of silently passing.
 */

const CREATED_AT = '2026-01-01T00:00:00.000Z';

export type FakeOllamaFailure = 'none' | 'model_not_found' | 'server_error' | 'destroy_mid_body';

export interface FakeOllamaToolCall {
  name: string;
  /** Ollama sends arguments as a JSON object, never as a JSON string. */
  arguments: Record<string, unknown>;
}

/** Mutable per-server behaviour; tests adjust it without rebinding the server. */
export interface FakeOllamaScenario {
  model: string;
  content: string;
  toolCalls: FakeOllamaToolCall[];
  promptEvalCount: number;
  evalCount: number;
  doneReason: string;
  /** Values returned by `POST /api/show` and used by the adapter's capability probe. */
  capabilities: string[];
  failure: FakeOllamaFailure;
  /** Delay between NDJSON chunks when the client asks for `stream: true`. */
  streamDelayMs: number;
  /** Delay before answering `/api/chat`, so cancellation can be exercised. */
  chatDelayMs: number;
}

export interface RecordedOllamaRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
  receivedAt: number;
}

export interface FakeOllamaServer {
  url: string;
  port: number;
  /** Every request the adapter actually sent, in arrival order. */
  requests: RecordedOllamaRequest[];
  scenario: FakeOllamaScenario;
  reset(): void;
  close(): Promise<void>;
}

function collectBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function sendNdjsonChunk(response: ServerResponse, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`${JSON.stringify(payload)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatPayload(scenario: FakeOllamaScenario, content: string, done: boolean, withToolCalls = false): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (withToolCalls && scenario.toolCalls.length > 0) {
    // Ollama attaches tool calls to the assistant message, arguments as objects.
    message.tool_calls = scenario.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }));
  }
  return {
    model: scenario.model,
    created_at: CREATED_AT,
    message,
    done,
    ...(done
      ? {
          done_reason: scenario.doneReason,
          total_duration: 1_000_000,
          load_duration: 500_000,
          prompt_eval_count: scenario.promptEvalCount,
          prompt_eval_duration: 200_000,
          eval_count: scenario.evalCount,
          eval_duration: 300_000,
        }
      : {}),
  };
}

/** Splits text into stream-sized pieces, the way a token stream would arrive. */
function contentChunks(content: string): string[] {
  const pieces = content.match(/\S+\s*/g);
  return pieces && pieces.length > 0 ? pieces : [''];
}

async function handleChat(response: ServerResponse, scenario: FakeOllamaScenario, body: Record<string, unknown>): Promise<void> {
  if (scenario.failure === 'model_not_found') {
    sendJson(response, 404, { error: `model "${String(body.model ?? scenario.model)}" not found` });
    return;
  }
  if (scenario.failure === 'server_error') {
    sendJson(response, 500, { error: 'fake internal server error' });
    return;
  }
  if (scenario.chatDelayMs > 0) await sleep(scenario.chatDelayMs);
  if (response.destroyed) return;

  const stream = body.stream === true;
  const content = scenario.toolCalls.length > 0 ? '' : scenario.content;

  if (!stream) {
    if (scenario.failure === 'destroy_mid_body') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(JSON.stringify(chatPayload(scenario, content, false)).slice(0, 40));
      setTimeout(() => response.destroy(), 5);
      return;
    }
    sendJson(response, 200, chatPayload(scenario, content, true, scenario.toolCalls.length > 0));
    return;
  }

  response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
  if (scenario.failure === 'destroy_mid_body') {
    sendNdjsonChunk(response, chatPayload(scenario, contentChunks(content)[0] ?? '', false));
    setTimeout(() => response.destroy(), 5);
    return;
  }
  for (const piece of contentChunks(content)) {
    sendNdjsonChunk(response, chatPayload(scenario, piece, false));
    await sleep(scenario.streamDelayMs);
  }
  if (response.destroyed) return;
  // Tool calls arrive in their own non-final chunk, exactly like the documented stream.
  if (scenario.toolCalls.length > 0) sendNdjsonChunk(response, chatPayload(scenario, '', false, true));
  sendNdjsonChunk(response, chatPayload(scenario, '', true));
  response.end();
}

export async function createFakeOllamaServer(options: Partial<FakeOllamaScenario> = {}): Promise<FakeOllamaServer> {
  const scenario: FakeOllamaScenario = {
    model: 'fake:latest',
    content: 'Hello from the fake Ollama server.',
    toolCalls: [],
    promptEvalCount: 18,
    evalCount: 7,
    doneReason: 'stop',
    capabilities: ['completion', 'tools'],
    failure: 'none',
    streamDelayMs: 5,
    chatDelayMs: 0,
    ...options,
  };
  const requests: RecordedOllamaRequest[] = [];

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const raw = await collectBody(request);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let parsedBody: Record<string, unknown> | null = null;
      if (raw.length > 0) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          parsedBody = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
        } catch {
          parsedBody = null;
        }
      }
      requests.push({ method: request.method ?? 'GET', path: url.pathname, headers: request.headers, body: parsedBody, receivedAt: Date.now() });

      switch (`${request.method ?? 'GET'} ${url.pathname}`) {
        case 'GET /api/tags':
          sendJson(response, 200, {
            models: [
              {
                name: scenario.model,
                model: scenario.model,
                modified_at: CREATED_AT,
                size: 4_000_000_000,
                digest: 'sha256:fake',
                details: { parent_model: '', format: 'gguf', family: 'llama', families: ['llama'], parameter_size: '7B', quantization_level: 'Q4_K_M' },
              },
            ],
          });
          return;
        case 'POST /api/show':
          sendJson(response, 200, {
            model: scenario.model,
            modified_at: CREATED_AT,
            details: { parent_model: '', format: 'gguf', family: 'llama', families: ['llama'], parameter_size: '7B', quantization_level: 'Q4_K_M' },
            capabilities: [...scenario.capabilities],
          });
          return;
        case 'POST /api/chat':
          await handleChat(response, scenario, parsedBody ?? {});
          return;
        default:
          sendJson(response, 404, { error: 'not found' });
      }
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'fake server failure' });
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
  if (address === null || typeof address === 'string') throw new Error('fake Ollama server did not bind a TCP port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    scenario,
    reset(): void {
      requests.length = 0;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
