import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { findTool, toolDefinitions, truncateToBytes } from '@agent-tasks/agent-runtime';
import type { AgentSource, AgentStepRecord, ToolContext } from '@agent-tasks/agent-runtime';
import type { BrowserRunnerClient, SearchProvider } from '@agent-tasks/browser-tools';
import { sanitizeText } from '@agent-tasks/shared';
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
/** A bridge is only useful for one execution; the token dies with the run. */
const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_PORT = 4091;
const MCP_PATH = '/mcp';

export interface ToolBridgeLimits {
  maxPageVisits: number;
  maxSearchQueries: number;
  maxOutputBytes: number;
  /**
   * Per-execution tool-call budget. When absent, the bridge keeps its own hard
   * cap (`DEFAULT_MAX_CALLS`); callers should forward the task limit.
   */
  maxToolCalls?: number;
}

export interface ToolBridgeContext {
  browser: BrowserRunnerClient;
  search: SearchProvider;
  sessionId: string;
  allowForms: boolean;
  limits: ToolBridgeLimits;
}

/**
 * One observed `tools/call`, numbered per bridge session in receipt order.
 *
 * The bridge is the only place that sees both the model's raw arguments and the
 * tool's validated outcome, so it is the source of truth for the execution
 * timeline. The executor still treats every field as untrusted: it redacts and
 * caps the values before they become durable.
 */
export type ToolBridgeCallRecord = AgentStepRecord;

export type ToolBridgeBudgetCounter = 'calls' | 'pages' | 'searches' | 'outputBytes';
export interface ToolBridgeBudgetReservation {
  status: 'reserved' | 'exhausted' | 'denied';
  counter?: ToolBridgeBudgetCounter;
  remaining?: { outputBytes: number | null };
}

export interface ToolBridgeOpenOptions {
  token?: string;
  tools?: string[];
  maxCalls?: number;
  /** Absolute session lifetime from `open()`; expired tokens are rejected. */
  ttlMs?: number;
  /**
   * Execution-scoped capabilities. Research tools require it; e-mail and memory
   * tools work without it. Without a context the bridge refuses to offer a
   * research tool rather than exposing a handler that cannot run.
   */
  context?: ToolBridgeContext;
  /**
   * Called once per budgeted `tools/call` after the tool (or its refusal)
   * finished. Calls refused after the budget is exhausted are not reported: a
   * fixed budget must never expand into an unbounded timeline. A callback
   * failure must never turn the tool response into a model-visible failure, so
   * the bridge contains it.
   */
  onCall?: (call: ToolBridgeCallRecord) => void | Promise<void>;
  /** Durable execution-ledger reservation. If provided, errors fail closed. */
  reserveBudget?: (counters: Partial<Record<ToolBridgeBudgetCounter, number>>) => Promise<ToolBridgeBudgetReservation>;
}

export interface ToolBridgeSession {
  token: string;
  emailBlocks: EmailBlock[];
  sources: AgentSource[];
  memoryOps: AgentMemoryOp[];
  recommendationOps: AgentRecommendationOp[];
  calls: number;
  /** Highest timeline number handed out; bounded by `calls` and the budget. */
  sequence: number;
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
  limits?: ToolBridgeLimits;
  maxOutputBytes?: number;
  budgetLock: AsyncLock;
  /** Monotonic timeline counter; allocated synchronously at call receipt. */
  sequence: number;
  onCall?: (call: ToolBridgeCallRecord) => void | Promise<void>;
  reserveBudget?: ToolBridgeOpenOptions['reserveBudget'];
  expiresAt: number;
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

/** Tools that consume the execution's page-visit budget. */
const PAGE_VISIT_TOOLS = new Set(['open_url', 'click_element', 'navigate_back']);
/** Tools that consume the execution's search-query budget. */
const SEARCH_QUERY_TOOLS = new Set(['search_web']);

/**
 * Page visits are incremented by the tool *after* the browser action resolves,
 * so two parallel calls could both pass the tool's pre-check and overshoot the
 * budget. Budgeted tools therefore run one at a time per session at the bridge.
 */
const BUDGETED_TOOLS = new Set([...PAGE_VISIT_TOOLS, ...SEARCH_QUERY_TOOLS]);

/** Small promise-chain mutex; `tail` never rejects. */
class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function normalizedMaxCalls(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CALLS;
  return Math.max(0, Math.floor(value));
}

function normalizedOutputBytes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

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
    // The task limit wins over the bridge default; an explicit open() value
    // wins over both so tests and single-execution hosts stay deterministic.
    maxCalls: normalizedMaxCalls(options.maxCalls ?? options.context?.limits.maxToolCalls),
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
    limits: options.context?.limits,
    maxOutputBytes: normalizedOutputBytes(options.context?.limits.maxOutputBytes),
    budgetLock: new AsyncLock(),
    sequence: 0,
    ...(options.onCall ? { onCall: options.onCall } : {}),
    ...(options.reserveBudget ? { reserveBudget: options.reserveBudget } : {}),
    expiresAt: Date.now() + (options.ttlMs ?? DEFAULT_TTL_MS),
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
    if (session.expiresAt <= Date.now()) {
      // An execution that never closed its bridge (worker lost) must not leave a
      // usable token behind; expiry is enforced on every request.
      sessions.delete(session.token);
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
        get sequence() {
          return session.sequence;
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
    get sequence() {
      return session.sequence;
    },
    url: hub.url,
    async close() {
      session.close();
      await hub.close();
    },
  };
}

function textResult(session: Session, text: string, isError: boolean): unknown {
  // The tool handlers already cap most payloads, but the bridge is the last
  // boundary before the model. Applying the execution's byte budget here covers
  // every tool (including future ones) and error text as well.
  const capped = session.maxOutputBytes === undefined ? text : truncateToBytes(text, session.maxOutputBytes);
  return { content: [{ type: 'text', text: capped }], isError };
}

function budgetRefusal(session: Session, name: string): string | undefined {
  const limits = session.limits;
  if (!limits) return undefined;
  if (PAGE_VISIT_TOOLS.has(name) && session.context.pageVisits >= limits.maxPageVisits) {
    return 'page visit budget exhausted';
  }
  if (SEARCH_QUERY_TOOLS.has(name) && session.context.queries.length >= limits.maxSearchQueries) {
    return 'search budget exhausted';
  }
  return undefined;
}

interface CallResult {
  reply: unknown;
  ok: boolean;
  /** Short internal reason, never raw tool output. */
  error?: string;
  /** Human-facing preview from the tool outcome, already capped for storage. */
  preview?: string;
}

function callRecord(
  step: number,
  name: string,
  argumentsValue: Record<string, unknown>,
  outcome: CallResult,
  startedAt: number,
): ToolBridgeCallRecord {
  const finishedAt = Date.now();
  // The model sees the full tool reply (bounded by its execution output budget).
  // The timeline only needs a short, control-character-free preview; the executor
  // redacts and caps it again before persistence.
  const preview = outcome.preview ? sanitizeText(outcome.preview, 500) : undefined;
  return {
    step,
    tool: name || '(missing)',
    arguments: argumentsValue,
    ok: outcome.ok,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: Math.max(0, finishedAt - startedAt),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(preview ? { resultPreview: preview } : {}),
  };
}

function refusedCall(session: Session, message: string): CallResult {
  return { reply: textResult(session, message, true), ok: false, error: message };
}

function textFromReply(reply: unknown): string {
  const record = asRecord(reply);
  const content = Array.isArray(record?.content) ? record.content : [];
  return content
    .map((item) => asRecord(item))
    .map((item) => typeof item?.text === 'string' ? item.text : '')
    .join('');
}

async function runToolCall(session: Session, name: string, rawArguments: unknown): Promise<CallResult> {
  if (!session.allowed.has(name)) {
    return refusedCall(session, `tool not allowed: ${name || '(missing)'}`);
  }
  const tool = findTool(name);
  if (!tool) return refusedCall(session, `unknown tool: ${name}`);

  const execute = async (): Promise<CallResult> => {
    // Budgeted tools run under the per-session lock: page visits are recorded
    // after the browser action, so a parallel call could otherwise overshoot
    // maxPageVisits between the tool's check and its increment.
    const refusal = budgetRefusal(session, name);
    if (refusal) return { reply: textResult(session, refusal, true), ok: false, error: refusal };
    const actionCounter = PAGE_VISIT_TOOLS.has(name) ? 'pages' : SEARCH_QUERY_TOOLS.has(name) ? 'searches' : undefined;
    if (actionCounter && session.reserveBudget) {
      const reservation = await session.reserveBudget({ [actionCounter]: 1 });
      if (reservation.status === 'denied') {
        return { reply: textResult(session, 'execution lease unavailable', true), ok: false, error: 'execution lease unavailable' };
      }
      if (reservation.status === 'exhausted') {
        const message = `${actionCounter === 'pages' ? 'page visit' : 'search'} budget exhausted`;
        return { reply: textResult(session, message, true), ok: false, error: message };
      }
    }
    try {
      const outcome = await tool.run(rawArguments ?? {}, session.context);
      const replyText = outcome.ok ? outcome.content : `error: ${outcome.content}`;
      const reply = textResult(session, replyText, !outcome.ok);
      return {
        reply,
        ok: outcome.ok,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.preview ? { preview: outcome.preview } : {}),
      };
    } catch {
      return {
        reply: textResult(session, 'tool execution failed', true),
        ok: false,
        error: 'tool execution failed',
        preview: 'tool failed',
      };
    }
  };

  return BUDGETED_TOOLS.has(name) ? session.budgetLock.run(execute) : execute();
}

async function emitCall(session: Session, call: ToolBridgeCallRecord): Promise<void> {
  try {
    await session.onCall?.(call);
  } catch {
    // Timeline persistence must never change what the model observes. A failed
    // write is dropped here rather than being reported as a tool failure.
  }
}

async function callTool(session: Session, params: unknown): Promise<unknown> {
  const record = asRecord(params);
  const name = typeof record?.name === 'string' ? record.name : '';
  // Every authenticated tools/call consumes the budget, even when the tool is
  // not allowlisted or its arguments are malformed. Once the budget is spent a
  // call is refused without a timeline row, so an untrusted runtime cannot
  // amplify a fixed budget into unlimited execution_steps rows.
  if (session.calls >= session.maxCalls) {
    return textResult(session, `tool call budget exhausted (${session.maxCalls})`, true);
  }
  session.calls += 1;
  if (session.reserveBudget) {
    try {
      const reservation = await session.reserveBudget({ calls: 1 });
      if (reservation.status !== 'reserved') {
        return textResult(
          session,
          reservation.status === 'exhausted' ? 'tool call budget exhausted' : 'execution lease unavailable',
          true,
        );
      }
    } catch {
      // A database failure is never permission to proceed. No timeline row is
      // emitted because this request did not obtain a durable call reservation.
      return textResult(session, 'execution budget unavailable', true);
    }
  }
  // Number at receipt, before any await, so parallel calls keep the order in
  // which the model issued them even when they finish out of order.
  session.sequence += 1;
  const step = session.sequence;
  const startedAt = Date.now();
  // Only a plain object is a valid tool-argument bag. Anything else is refused
  // by the tool schemas anyway; never copy a model-chosen shape into the timeline.
  const argumentsValue = asRecord(record?.arguments) ?? {};

  let outcome: CallResult;
  try {
    outcome = await runToolCall(session, name, record?.arguments);
  } catch {
    // runToolCall contains tool failures itself; this is the last-resort guard so
    // a bridge bug cannot leave a numbered call without its matching response.
    outcome = { reply: textResult(session, 'execution budget unavailable', true), ok: false, error: 'execution budget unavailable', preview: 'tool failed' };
  }
  if (session.reserveBudget) {
    const outputBytes = Buffer.byteLength(textFromReply(outcome.reply), 'utf8');
    if (outputBytes > 0) {
      try {
        const reservation = await session.reserveBudget({ outputBytes });
        if (reservation.status !== 'reserved') {
          const message = reservation.status === 'exhausted'
            ? 'execution output budget exhausted'
            : 'execution lease unavailable';
          outcome = { reply: textResult(session, message, true), ok: false, error: message };
        }
      } catch {
        outcome = { reply: textResult(session, 'execution budget unavailable', true), ok: false, error: 'execution budget unavailable' };
      }
    }
  }
  await emitCall(session, callRecord(step, name, argumentsValue, outcome, startedAt));
  return outcome.reply;
}
