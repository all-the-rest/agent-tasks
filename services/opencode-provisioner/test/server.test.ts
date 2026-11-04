import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_RUNTIME_LIMITS } from '@agent-tasks/shared';
import {
  runtimeConfig, providerRequestHeaders, createProvisionerServer, allowedOpenCodeRoute, MAX_REQUEST_BYTES, MAX_OUTPUT_BYTES,
} from '../server.mjs';
import { HttpOpenCodeProvisioner } from '../../../apps/worker/src/http-opencode-provisioner.js';

const token = 'unit-test-provisioner-token-0123456789abcdef';
const lease = { executionId: '123e4567-e89b-42d3-a456-426614174000', ownerId: '123e4567-e89b-42d3-a456-426614174001', workerId: 'unit-worker' };
const input = {
  lease,
  providerKind: 'openai-compatible',
  provider: {
    baseUrl: 'https://llm.example/v1',
    models: [{ id: 'model-a', label: 'Model A', supportsTools: true, contextLength: 32_000 }],
    headers: { 'x-tenant-token': 'must-not-persist-header' },
    sessionHeader: 'x-opencode-session', timeoutMs: 60_000,
  },
  model: { id: 'model-a' },
  apiKey: 'must-not-be-persisted',
  systemPrompt: 'Prompt policy goes here', maxAgentSteps: 9, maxOutputBytes: 8_192,
};
const servers = [];

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('isolated OpenCode provisioner service', () => {
  it('accepts the real worker client request including the model and MCP capability', async () => {
    let baseUrl = '';
    const provision = vi.fn(async (request) => ({
      state: { executionId: request.lease.executionId },
      response: {
        baseUrl: `${baseUrl}/v1/runtime/${request.lease.executionId}/`,
        password: 'p'.repeat(64), directory: '/workspace',
        model: { providerID: 'agent_tasks', id: request.model.id, ...(request.model.variant ? { variant: request.model.variant } : {}) },
      },
    }));
    baseUrl = await listen(createProvisionerServer({ token, provision }));
    const client = new HttpOpenCodeProvisioner(baseUrl, token);
    const bridge = { token: 'b'.repeat(43), tools: ['compose_email'] };
    const runtime = await client.open({
      lease, providerKind: 'openai-compatible',
      providerContext: { apiKey: 'fake-key', config: input.provider },
      model: { id: 'model-a' }, systemPrompt: 'test', maxAgentSteps: 4, maxOutputBytes: 8192,
      toolBridge: bridge,
    });
    expect(runtime.model.id).toBe('model-a');
    expect(provision).toHaveBeenCalledOnce();
    expect(provision.mock.calls[0]?.[0]).toMatchObject({
      lease, apiKey: 'fake-key', model: { id: 'model-a' }, toolBridge: bridge,
    });
  });

  it('accepts the shared output budget at the real request boundary', async () => {
    let baseUrl = '';
    const provision = vi.fn(async (request) => ({
      state: { executionId: request.lease.executionId },
      response: {
        baseUrl: `${baseUrl}/v1/runtime/${request.lease.executionId}/`,
        password: 'p'.repeat(64), directory: '/workspace',
        model: { providerID: 'agent_tasks', id: request.model.id },
      },
    }));
    baseUrl = await listen(createProvisionerServer({ token, provision }));
    // The shared default is deliberately larger than the HTTP body cap; the
    // provisioner must validate it against its separate output budget instead.
    expect(AGENT_RUNTIME_LIMITS.maxOutputBytes).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(AGENT_RUNTIME_LIMITS.maxOutputBytes).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    const client = new HttpOpenCodeProvisioner(baseUrl, token);
    await client.open({
      lease, providerKind: 'openai-compatible',
      providerContext: { apiKey: 'fake-key', config: input.provider },
      model: { id: 'model-a' }, systemPrompt: 'test',
      maxAgentSteps: AGENT_RUNTIME_LIMITS.maxAgentSteps,
      maxOutputBytes: AGENT_RUNTIME_LIMITS.maxOutputBytes,
    });
    expect(provision).toHaveBeenCalledOnce();
    expect(provision.mock.calls[0]?.[0].maxOutputBytes).toBe(AGENT_RUNTIME_LIMITS.maxOutputBytes);
  });

  it('keeps the output budget and request body caps separate', async () => {
    const provision = vi.fn();
    const baseUrl = await listen(createProvisionerServer({ token, provision }));
    const post = (body: unknown) => globalThis.fetch(`${baseUrl}/v1/runtimes/open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await post({ ...input, maxOutputBytes: MAX_OUTPUT_BYTES + 1 })).status).toBe(502);
    expect((await post({ ...input, padding: 'x'.repeat(MAX_REQUEST_BYTES) })).status).toBe(502);
    expect(provision).not.toHaveBeenCalled();
  });

  it('carries model#variant as a separate reasoning effort through the real request contract', async () => {
    let baseUrl = '';
    const provision = vi.fn(async (request) => ({
      state: { executionId: request.lease.executionId },
      response: {
        baseUrl: `${baseUrl}/v1/runtime/${request.lease.executionId}/`,
        password: 'p'.repeat(64), directory: '/workspace',
        model: { providerID: 'agent_tasks', id: request.model.id, ...(request.model.variant ? { variant: request.model.variant } : {}) },
      },
    }));
    baseUrl = await listen(createProvisionerServer({ token, provision }));
    const client = new HttpOpenCodeProvisioner(baseUrl, token);
    const runtime = await client.open({
      lease, providerKind: 'openai-compatible',
      providerContext: { apiKey: 'fake-key', config: input.provider },
      model: { id: 'model-a', variant: 'high' }, systemPrompt: 'test', maxAgentSteps: 4, maxOutputBytes: 8192,
    });
    expect(runtime.model).toEqual({ providerID: 'agent_tasks', id: 'model-a', variant: 'high' });
    expect(provision.mock.calls[0]?.[0].model).toEqual({ id: 'model-a', variant: 'high' });
  });

  it('rejects unsplit ids, unknown variants and undeclared models before provisioning', async () => {
    const provision = vi.fn();
    const baseUrl = await listen(createProvisionerServer({ token, provision }));
    const post = (model: unknown) => globalThis.fetch(`${baseUrl}/v1/runtimes/open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, model }),
    });
    expect((await post({ id: 'model-a#high' })).status).toBe(502);
    expect((await post({ id: 'model-a', variant: 'bogus' })).status).toBe(502);
    expect((await post({ id: 'not-configured', variant: 'high' })).status).toBe(502);
    expect(provision).not.toHaveBeenCalled();
  });

  it('declares every supported variant so the runtime maps it to reasoning effort', () => {
    const config = runtimeConfig({ ...input, model: { id: 'model-a', variant: 'high' } }, 'http://opencode-provisioner:4090/provider');
    // The catalog id stays the base model; the variant is a session choice.
    expect(config.model).toBe('agent_tasks/model-a');
    expect(config.providers.agent_tasks.models['model-a'].variants).toEqual([
      { id: 'none', body: { reasoning_effort: 'none' } },
      { id: 'minimal', body: { reasoning_effort: 'minimal' } },
      { id: 'low', body: { reasoning_effort: 'low' } },
      { id: 'medium', body: { reasoning_effort: 'medium' } },
      { id: 'high', body: { reasoning_effort: 'high' } },
      { id: 'xhigh', body: { reasoning_effort: 'xhigh' } },
    ]);
  });
  it('builds a tool-denying provider config without storing credentials', () => {
    const config = runtimeConfig(input, 'http://opencode-provisioner:4090/provider');
    expect(config.model).toBe('agent_tasks/model-a');
    expect(config.agents['agent-tasks']).toMatchObject({ steps: 9, system: 'Prompt policy goes here' });
    expect(config.providers.agent_tasks.models['model-a'].limit).toEqual({ context: 32_000, output: 2_048 });
    // Without tool_call OpenCode offers no tools at all, including MCP tools.
    expect(config.providers.agent_tasks.models['model-a'].tool_call).toBe(true);
    expect(config.providers.agent_tasks).toMatchObject({
      env: ['AGENT_TASKS_API_KEY'],
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'http://opencode-provisioner:4090/provider', timeout: 60_000 },
      headers: {
        'x-tenant-token': '{env:AGENT_TASKS_PROVIDER_HEADER_0}',
        'x-opencode-session': lease.executionId,
        'x-agent-tasks-egress': '{env:AGENT_TASKS_EGRESS_TOKEN}',
      },
    });
    expect(config.agents['agent-tasks'].permissions).toEqual([{ action: '*', resource: '*', effect: 'deny' }]);
    expect(config.policies).toEqual([{ action: 'provider.use', resource: 'agent_tasks', effect: 'allow' }]);
    expect(config.plugins).toEqual([]);
    expect(config.mcp.servers).toEqual({});
    expect(JSON.stringify(config)).not.toContain(input.apiKey);
    expect(JSON.stringify(config)).not.toContain('must-not-persist-header');
    expect(JSON.stringify(config)).not.toContain('egress-token');
  });

  it('sets tool_call only from explicit catalog metadata, never from an absent value', () => {
    const capable = runtimeConfig(input, 'http://opencode-provisioner:4090/provider');
    expect(capable.providers.agent_tasks.models['model-a'].tool_call).toBe(true);
    const toolLess = runtimeConfig({
      ...input,
      provider: { ...input.provider, models: [{ id: 'model-a', label: 'Model A', supportsTools: false }] },
    }, 'http://opencode-provisioner:4090/provider');
    expect(toolLess.providers.agent_tasks.models['model-a'].tool_call).toBe(false);
    const unknown = runtimeConfig({
      ...input,
      provider: { ...input.provider, models: [{ id: 'model-a', label: 'Model A' }] },
    }, 'http://opencode-provisioner:4090/provider');
    expect(unknown.providers.agent_tasks.models['model-a'].tool_call).toBe(false);
  });

  it('refuses a tool bridge for a model that is not explicitly tool-capable', async () => {
    const provision = vi.fn();
    const baseUrl = await listen(createProvisionerServer({ token, provision }));
    for (const supportsTools of [false, undefined]) {
      const response = await globalThis.fetch(`${baseUrl}/v1/runtimes/open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...input,
          provider: { ...input.provider, models: [{ id: 'model-a', label: 'Model A', supportsTools }] },
          toolBridge: { token: 'b'.repeat(43), tools: ['compose_email'] },
        }),
      });
      expect(response.status, `supportsTools=${supportsTools}`).toBe(502);
    }
    expect(provision).not.toHaveBeenCalled();
  });

  it('registers the worker MCP bridge and allows exactly its namespaced tools', () => {    const bridgeToken = 'b'.repeat(43);
    const tools = ['compose_email', 'add_email_block'];
    const config = runtimeConfig({ ...input, toolBridge: { token: bridgeToken, tools } }, 'http://opencode-provisioner:4090/provider');
    expect(config.mcp.servers).toEqual({
      agent_tasks_tools: {
        type: 'remote',
        url: 'http://opencode-provisioner:4090/mcp',
        headers: { authorization: `Bearer ${bridgeToken}` },
        codemode: false,
        timeout: { startup: 10_000, catalog: 10_000, execution: 60_000 },
      },
    });
    // The wildcard deny must stay first; OpenCode evaluates later rules last.
    expect(config.agents['agent-tasks'].permissions).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'agent_tasks_tools_compose_email', resource: '*', effect: 'allow' },
      { action: 'agent_tasks_tools_add_email_block', resource: '*', effect: 'allow' },
    ]);
    expect(config.policies).toEqual([
      { action: 'provider.use', resource: 'agent_tasks', effect: 'allow' },
      { action: 'mcp.use', resource: 'agent_tasks_tools', effect: 'allow' },
    ]);
    expect(JSON.stringify(config)).not.toContain(input.apiKey);
  });

  it('proxies MCP requests to the worker bridge and preserves the bearer token', async () => {
    let received: { authorization?: string; body?: string } = {};
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received = { authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() };
        response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'mcp-test-session' });
        response.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
      });
    });
    const upstreamUrl = await listen(upstream);
    const previous = process.env.TOOL_BRIDGE_URL;
    process.env.TOOL_BRIDGE_URL = upstreamUrl;
    try {
      const baseUrl = await listen(createProvisionerServer({ token, provision: vi.fn() }));
      const response = await globalThis.fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer execution-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBe('mcp-test-session');
      expect(received.authorization).toBe('Bearer execution-token');
      expect(received.body).toContain('tools/list');
    } finally {
      if (previous === undefined) delete process.env.TOOL_BRIDGE_URL;
      else process.env.TOOL_BRIDGE_URL = previous;
    }
  });

  it('forwards only configured provider headers and never leaks the runtime egress capability', () => {
    const headers = providerRequestHeaders({
      authorization: 'Bearer provider-key',
      'content-type': 'application/json',
      'user-agent': 'Agent Tasks Runtime',
      'x-tenant-token': 'tenant-header-secret',
      'x-opencode-session': lease.executionId,
      'x-agent-tasks-egress': 'runtime-egress-secret',
      'x-provisioner-token': 'provisioner-secret',
      cookie: 'not-forwarded',
    }, new Set(['x-tenant-token', 'x-opencode-session', 'x-agent-tasks-egress']));
    expect(headers).toEqual({
      authorization: 'Bearer provider-key',
      'content-type': 'application/json',
      'user-agent': 'Agent Tasks Runtime',
      'x-tenant-token': 'tenant-header-secret',
      'x-opencode-session': lease.executionId,
    });
  });

  it('requires authentication and rejects invalid requests before provisioning', async () => {
    const provision = vi.fn();
    const baseUrl = await listen(createProvisionerServer({ token, provision }));
    const unauthenticated = await globalThis.fetch(`${baseUrl}/v1/runtimes/open`, { method: 'POST', body: JSON.stringify(input) });
    expect(unauthenticated.status).toBe(401);
    const invalid = await globalThis.fetch(`${baseUrl}/v1/runtimes/open`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, providerKind: 'codex' }),
    });
    expect(invalid.status).toBe(502);
    expect(await invalid.json()).toEqual({ error: 'runtime operation failed' });
    expect(provision).not.toHaveBeenCalled();
  });

  it('limits runtime API proxy routes and authenticates before forwarding', async () => {
    const executionHash = 'a'.repeat(32);
    const ownerHash = 'b'.repeat(32);
    const runtimePassword = createHmac('sha256', token).update(`server:${lease.executionId}:${ownerHash}`).digest('hex');
    const runtimeAuthorization = `Basic ${Buffer.from(`opencode:${runtimePassword}`).toString('base64')}`;
    const provision = vi.fn(async () => ({
      state: { executionId: lease.executionId, executionHash, ownerHash, containerName: 'unused', network: 'unused' },
      response: { baseUrl: `http://127.0.0.1:4090/v1/runtime/${lease.executionId}/`, password: 'p'.repeat(64), directory: '/workspace', model: { providerID: 'agent_tasks', id: 'model-a' } },
    }));
    const baseUrl = await listen(createProvisionerServer({ token, provision }));
    const opened = await globalThis.fetch(`${baseUrl}/v1/runtimes/open`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    expect(opened.status).toBe(200);
    const noToken = await globalThis.fetch(`${baseUrl}/v1/runtime/${lease.executionId}/api/session`, { method: 'POST', body: '{}' });
    expect(noToken.status).toBe(401);
    const denied = await globalThis.fetch(`${baseUrl}/v1/runtime/${lease.executionId}/api/shell`, {
      headers: { authorization: runtimeAuthorization, 'x-provisioner-token': token },
    });
    expect(denied.status).toBe(404);
    const wrongBasic = await globalThis.fetch(`${baseUrl}/v1/runtime/${lease.executionId}/api/session`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-provisioner-token': token, 'content-type': 'application/json' }, body: '{}',
    });
    expect(wrongBasic.status).toBe(401);
    const egress = await globalThis.fetch(`${baseUrl}/v1/runtime/${lease.executionId}/provider/models`, {
      headers: { 'x-agent-tasks-egress': 'wrong' },
    });
    expect(egress.status).toBe(403);
  });

  it('allows only reading MCP connection status, not MCP mutations or other routes', () => {
    expect(allowedOpenCodeRoute('GET', 'api/mcp')).toBe(true);
    expect(allowedOpenCodeRoute('POST', 'api/mcp')).toBe(false);
    expect(allowedOpenCodeRoute('DELETE', 'api/mcp')).toBe(false);
    expect(allowedOpenCodeRoute('GET', 'api/mcp/server')).toBe(false);
    expect(allowedOpenCodeRoute('GET', 'api/shell')).toBe(false);
  });
});
