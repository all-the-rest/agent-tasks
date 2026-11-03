import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { findTool, toolDefinitions } from '@agent-tasks/agent-runtime';
import type { AgentSource, ToolContext } from '@agent-tasks/agent-runtime';
import type { BrowserRunnerClient, SearchProvider } from '@agent-tasks/browser-tools';
import type { AgentMemoryOp, AgentRecommendationOp, EmailBlock } from '@agent-tasks/shared';

/**
 * Worker-hosted MCP endpoint for OpenCode executions.
 *
 * OpenCode speaks JSON-RPC over HTTP with an SSE response envelope. One worker
 * process hosts one hub; each execution registers a session with its own
 * per-execution bearer token, tool allowlist and call budget. The token is
 * useless after the session closes, and session metadata from OpenCode is never
 * treated as authentication.
 *
 * The hub is a trusted boundary: it returns no stack traces, configuration or
 * credentials to the model, and only exposes explicitly registered tools.
 */
const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_MAX_CALLS = 40;
const DEFAULT_PORT = 4091;
const MCP_PATH = '/mcp';

export interface ToolBridgeContext {
  browser: BrowserRunnerClient;
  search: SearchProvider;
  sessionId: string;
  allowForms: boolean;
  limits: { maxPageVisits: number; maxSearchQueries: number; maxOutputBytes: number };
}

export interface ToolBridgeOpenOptions {
  token?: string;
  tools?: string[];
  maxCalls?: number;
  /**
   * Execution-scoped capabilities. Research tools require it; e-mail and memory
   * tools work without it. Without a context the bridge refuses to offer a
   * research tool rather than exposing a handler that cannot run.
   */
  context?: ToolBridgeContext;
}

export interface ToolBridgeSession {
  token: string;
  emailBlocks: EmailBlock[];
  sources: AgentSource[];
  memoryOps: AgentMemoryOp[];
  recommendationOps: AgentRecommendationOp[];
  calls: number;
  close(): void;
}

export interface ToolBridgeHub {
  url: string;
  open(options?: ToolBridgeOpenOptions): ToolBridgeSession;
  close(): Promise<void>;
}

export interface ToolBridge extends ToolBridgeSession {
  url: string;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface Session {
  id: string;
  token: string;
  allowed: Set<string>;
  maxCalls: number;
  calls: number;
  emailBlocks: EmailBlock[];
  sources: AgentSource[];
  memoryOps: AgentMemoryOp[];
  recommendationOps: AgentRecommendationOp[];
  definitions: Array<{ name: string; description: string; inputSchema: unknown }>;
  context: ToolContext;
}

/** Tools that need the execution's browser/search capability. */
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeEqual(value: string, expected: string): boolean {
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function tokenFrom(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

function sse(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createSession(options: ToolBridgeOpenOptions): Session {
  const allowed = new Set(options.tools ?? ['compose_email', 'add_email_block']);
  if (!options.context) {
    const missing = [...allowed].find((tool) => RESEARCH_TOOLS.has(tool));
    if (missing) throw new Error(`tool ${missing} requires a tool context`);
  }
  const emailBlocks: EmailBlock[] = [];
  const sources: AgentSource[] = [];
  const memoryOps: AgentMemoryOp[] = [];
  const recommendationOps: AgentRecommendationOp[] = [];
  // Collect validated tool output only. The worker persists these after a
  // successful execution, exactly like the native runtime.
  const context: ToolContext = options.context
    ? {
        browser: options.context.browser,
        search: options.context.search,
        sessionId: options.context.sessionId,
        allowForms: options.context.allowForms,
        visited: new Set<string>(),
        pageVisits: 0,
        queries: [],
        emailBlocks,
        memoryOps,
        recommendationOps,
        limits: options.context.limits,
        onSource(source) {
          // Deduplicate by URL: reopening a page must not create a second row.
          const index = sources.findIndex((candidate) => candidate.url === source.url);
          if (index >= 0) sources[index] = source;
          else sources.push(source);
        },
      }
    : ({
        emailBlocks,
        memoryOps,
        recommendationOps,
        visited: new Set<string>(),
        queries: [],
        pageVisits: 0,
      } as unknown as ToolContext);
  return {
    id: `mcp_${randomBytes(16).toString('hex')}`,
    token: options.token ?? randomBytes(32).toString('base64url'),
    allowed,
    maxCalls: options.maxCalls ?? DEFAULT_MAX_CALLS,
    calls: 0,
    emailBlocks,
    sources,
    memoryOps,
    recommendationOps,
    definitions: toolDefinitions([...allowed]).map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.parameters,
    })),
    context,
  };
}

export async function createToolBridgeHub(options: { host?: string; port?: number } = {}): Promise<ToolBridgeHub> {
  const sessions = new Map<string, Session>();
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (new URL(request.url ?? '/', 'http://bridge.invalid').pathname !== MCP_PATH) {
      response.writeHead(404).end();
      return;
    }
    const token = tokenFrom(request);
    const session = token ? sessions.get(token) : undefined;
    if (!token || !session || !safeEqual(token, session.token)) {
      response.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
      return;
    }
    // The MCP HTTP transport correlates a session across requests with this
    // header; omitting it makes some clients treat the transport as stateless.
    response.setHeader('mcp-session-id', session.id);
    if (request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'GET') {
      // OpenCode 2.2.5 tolerates an unsupported server-initiated stream and
      // still imports the catalog from POST responses. Keeping an empty SSE
      // stream open instead can stall that import.
      response.writeHead(405, { allow: 'POST, DELETE' }).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }

    let message: JsonRpcRequest;
    try {
      const parsed = JSON.parse(await readBody(request));
      const record = asRecord(parsed);
      if (!record) throw new Error('not an object');
      message = record;
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }),
      );
      return;
    }

    const id = message.id ?? null;
    const method = typeof message.method === 'string' ? message.method : '';
    if (method.startsWith('notifications/')) {
      response.writeHead(202).end();
      return;
    }
    if (method === 'initialize') {
      sse(response, {
        jsonrpc: '2.0',
        id,
        result: {
          // OpenCode 2.2.5 negotiates this revision; a newer value connects but
          // may leave the tool catalog empty.
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-tasks-tools', version: '0.1.0' },
        },
      });
      return;
    }
    if (method === 'ping') {
      sse(response, { jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      sse(response, { jsonrpc: '2.0', id, result: { tools: session.definitions } });
      return;
    }
    if (method === 'tools/call') {
      sse(response, { jsonrpc: '2.0', id, result: await callTool(session, message.params) });
      return;
    }
    sse(response, { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;

  return {
    url: `http://${host}:${address.port}${MCP_PATH}`,
    open(sessionOptions = {}) {
      const session = createSession(sessionOptions);
      sessions.set(session.token, session);
      return {
        token: session.token,
        emailBlocks: session.emailBlocks,
        sources: session.sources,
        memoryOps: session.memoryOps,
        recommendationOps: session.recommendationOps,
        get calls() {
          return session.calls;
        },
        close() {
          sessions.delete(session.token);
        },
      };
    },
    async close() {
      sessions.clear();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** Convenience wrapper for one isolated session (tests, single-execution hosts). */
export async function startToolBridge(options: ToolBridgeOpenOptions & { host?: string; port?: number } = {}): Promise<ToolBridge> {
  const hub = await createToolBridgeHub({ host: options.host, port: options.port });
  const session = hub.open(options);
  return {
    token: session.token,
    emailBlocks: session.emailBlocks,
    sources: session.sources,
    memoryOps: session.memoryOps,
    recommendationOps: session.recommendationOps,
    get calls() {
      return session.calls;
    },
    url: hub.url,
    async close() {
      session.close();
      await hub.close();
    },
  };
}

async function callTool(session: Session, params: unknown): Promise<unknown> {
  const record = asRecord(params);
  const name = typeof record?.name === 'string' ? record.name : '';
  if (!session.allowed.has(name)) {
    return { content: [{ type: 'text', text: `tool not allowed: ${name || '(missing)'}` }], isError: true };
  }
  if (session.calls >= session.maxCalls) {
    return { content: [{ type: 'text', text: `tool call budget exhausted (${session.maxCalls})` }], isError: true };
  }
  session.calls += 1;
  const tool = findTool(name);
  if (!tool) return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  try {
    const outcome = await tool.run(record?.arguments ?? {}, session.context);
    return {
      content: [{ type: 'text', text: outcome.ok ? outcome.content : `error: ${outcome.content}` }],
      isError: !outcome.ok,
    };
  } catch {
    return { content: [{ type: 'text', text: 'tool execution failed' }], isError: true };
  }
}
