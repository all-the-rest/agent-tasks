import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { clearTimeout, setTimeout } from 'node:timers';

const PORT = Number(process.env.PORT ?? 4090);
const TOKEN = process.env.OPENCODE_PROVISIONER_TOKEN ?? '';
const DELAY_MS = Number(process.env.FAKE_RUNTIME_DELAY_MS ?? 0);
// E2E-only: emit one deterministic memory/recommendation pair per session so the
// worker's learning, injection and tombstone paths stay covered without a model.
const MEMORY_OPS = process.env.FAKE_RUNTIME_MEMORY_OPS === '1';
const TOOL_BRIDGE_URL = process.env.TOOL_BRIDGE_URL ?? 'http://worker:4091/mcp';
// Kept in sync with the real provisioner; the worker never sends the composed id.
const MODEL_VARIANTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const MAX_BODY_BYTES = 1_000_000;
const E2E_MEMORY = {
  category: 'finding',
  content: 'E2E finding: the alpha launch price is 42 units at the observed source.',
  semanticKey: 'e2e.finding.alpha-price',
};
const E2E_RECOMMENDATION = {
  stableKey: 'e2e/alpha-offer',
  title: 'Alpha offer',
  description: 'The deterministic E2E recommendation with a stable key.',
  sourceUrl: 'https://example.com/alpha',
  status: 'recommended',
  metadata: { price: 42 },
};
const runtimes = new Map();

if (TOKEN.length < 32) throw new Error('A fake provisioner token of at least 32 characters is required');
if (!Number.isSafeInteger(DELAY_MS) || DELAY_MS < 0 || DELAY_MS > 60_000) throw new Error('Invalid fake runtime delay');

const server = createServer((request, response) => {
  void route(request, response).catch(() => {
    if (!response.headersSent) send(response, 400, { error: 'bad request' });
    else response.destroy();
  });
});

async function route(request, response) {
  const url = new URL(request.url ?? '/', 'http://fake-provisioner.invalid');
  if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, { ok: true });

  if (request.method === 'POST' && url.pathname === '/v1/runtimes/open') {
    if (!bearerMatches(request.headers.authorization, TOKEN)) return send(response, 401, { error: 'unauthorized' });
    const input = await readJson(request);
    if (!input?.lease?.executionId || input.providerKind !== 'openai-compatible' || typeof input.model?.id !== 'string'
      || input.model.id.includes('#')
      || (input.model.variant !== undefined && !MODEL_VARIANTS.includes(input.model.variant))) {
      return send(response, 400, { error: 'unsupported fake runtime request' });
    }
    // Mirror the real provisioner's catalog contract so the worker cannot pass a
    // model the catalog does not contain, or a tool bridge for a tool-less model.
    const catalog = Array.isArray(input.provider?.models) ? input.provider.models : [];
    const selected = catalog.find((model) => model?.id === input.model.id);
    if (!selected) return send(response, 400, { error: 'Task model is not configured on its provider' });
    if (input.toolBridge && selected.supportsTools !== true) {
      return send(response, 400, { error: 'Task model is not declared tool-capable' });
    }
    const executionId = input.lease.executionId;
    let runtime = runtimes.get(executionId);
    if (!runtime) {
      runtime = {
        sessionId: `ses_${randomBytes(16).toString('hex')}`,
        messages: [],
        timer: null,
        password: runtimePassword(executionId),
        systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : '',
        bridge: input.toolBridge,
        memoryEmitted: false,
      };
      runtimes.set(executionId, runtime);
    }
    const origin = `http://${request.headers.host}`;
    // Deliberately discard provider config and credentials. This test-only fake
    // never performs model inference or connects to the configured endpoint.
    return send(response, 200, {
      baseUrl: `${origin}/v1/runtime/${executionId}/`,
      password: runtime.password,
      directory: '/fake-workspace',
      model: { providerID: 'agent_tasks', id: input.model.id, ...(input.model.variant ? { variant: input.model.variant } : {}) },
    });
  }

  const match = /^\/v1\/runtime\/([0-9a-f-]{36})\/(.*)$/.exec(url.pathname);
  if (!match) return send(response, 404, { error: 'not found' });
  const runtime = runtimes.get(match[1]);
  if (!runtime) return send(response, 401, { error: 'unauthorized' });

  if (match[2] === 'release' && request.method === 'POST') {
    // The worker releases with the provisioner token plus the derived runtime
    // password (the real provisioner ignores Basic auth here). Keep fake state
    // available for the same execution's worker-recovery path.
    if (!constantTimeEqual(request.headers['x-provisioner-token'] ?? '', TOKEN)) return send(response, 401, { error: 'unauthorized' });
    if (!constantTimeEqual(request.headers['x-runtime-password'] ?? '', runtime.password)) return send(response, 401, { error: 'unauthorized' });
    return send(response, 200, { released: true });
  }

  if (!authorizedRuntime(request, runtime)) return send(response, 401, { error: 'unauthorized' });
  if (match[2] === 'api/mcp' && request.method === 'GET') {
    // The worker waits for a connected MCP server before it creates the session
    // and dispatches the prompt, exactly as it does against the real runtime.
    const data = runtime.bridge?.token
      ? [{ name: 'agent-tasks-tools', status: { status: 'connected' } }]
      : [];
    return send(response, 200, { data });
  }
  if (match[2] === 'api/session' && request.method === 'POST') return send(response, 200, { data: { id: runtime.sessionId } });
  if (match[2] === `api/session/${runtime.sessionId}/message` && request.method === 'GET') {
    return send(response, 200, { data: runtime.messages });
  }
  if (match[2] === `api/session/${runtime.sessionId}/prompt` && request.method === 'POST') {
    await readJson(request);
    if (!runtime.messages.length && !runtime.timer) {
      if (MEMORY_OPS && !runtime.memoryEmitted && runtime.bridge?.token) {
        runtime.memoryEmitted = true;
        await emitMemoryOps(runtime.bridge.token);
      }
      const answer = fakeAnswer(runtime.systemPrompt);
      runtime.timer = setTimeout(() => {
        runtime.messages = [{
          type: 'assistant',
          finish: 'stop',
          content: [{ type: 'text', text: answer }],
          time: { created: Date.now() - 1, completed: Date.now() },
          tokens: { input: 10, output: 5 },
          cost: 0.001,
        }];
        runtime.timer = null;
      }, DELAY_MS);
      runtime.timer.unref?.();
    }
    return send(response, 200, { data: {} });
  }
  if (match[2] === `api/session/${runtime.sessionId}/interrupt` && request.method === 'POST') {
    await readJson(request);
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = null;
    return send(response, 200, { data: {} });
  }
  return send(response, 404, { error: 'not found' });
}

const FAKE_BANNER = '> **Simulated execution.** The test-only fake OpenCode provisioner produced this report; no model provider was called.\n\n';

function fakeAnswer(systemPrompt) {
  const parts = [];
  if (systemPrompt.includes('TASK MEMORY')) parts.push('Previous task memory was provided to this run.');
  if (systemPrompt.includes('PREVIOUS RECOMMENDATIONS')) parts.push('Existing tracked recommendations were recognized.');
  return FAKE_BANNER + (parts.length > 0
    ? parts.join(' ')
    : 'Findings\n\nA deterministic fake OpenCode report for the integration test.');
}

async function callBridge(token, name, args) {
  const response = await globalThis.fetch(TOOL_BRIDGE_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  await response.text();
}

async function emitMemoryOps(token) {
  // Failure stays harmless: the run still completes with a deterministic answer.
  await callBridge(token, 'record_task_memory', E2E_MEMORY).catch(() => undefined);
  await callBridge(token, 'track_recommendation', E2E_RECOMMENDATION).catch(() => undefined);
}

function runtimePassword(executionId) {
  return createHmac('sha256', TOKEN).update(`fake-runtime:${executionId}`).digest('hex');
}

function authorizedRuntime(request, runtime) {
  // The worker forwards its raw provisioner token as a header (not a Bearer value).
  if (!constantTimeEqual(request.headers['x-provisioner-token'] ?? '', TOKEN)) return false;
  const expected = `Basic ${Buffer.from(`opencode:${runtime.password}`).toString('base64')}`;
  const actual = request.headers.authorization ?? '';
  return constantTimeEqual(actual, expected);
}

function bearerMatches(actual, expected) {
  if (typeof actual !== 'string' || !actual.startsWith('Bearer ')) return false;
  return constantTimeEqual(actual.slice(7), expected);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

server.listen(PORT, '0.0.0.0', () => console.log(`FAKE_OPENCODE_PROVISIONER_READY (TEST-ONLY, reports are simulated) port=${PORT}`));
