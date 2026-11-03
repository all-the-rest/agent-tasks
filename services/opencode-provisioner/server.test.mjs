import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeConfig, createProvisionerServer } from './server.mjs';

const token = 'unit-test-provisioner-token-0123456789abcdef';
const lease = { executionId: '123e4567-e89b-42d3-a456-426614174000', ownerId: '123e4567-e89b-42d3-a456-426614174001', workerId: 'unit-worker' };
const input = {
  lease,
  providerKind: 'openai-compatible',
  provider: { baseUrl: 'https://llm.example/v1', models: [{ id: 'model-a', label: 'Model A', supportsTools: true, contextLength: 32_000 }], sessionHeader: 'x-opencode-session', timeoutMs: 60_000 },
  model: { providerID: 'existing-provider', id: 'model-a' },
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
  it('builds a tool-denying provider config without storing credentials', () => {
    const config = runtimeConfig(input, 'egress-token', 'http://opencode-provisioner:4090/provider');
    expect(config.model).toBe('agent_tasks/model-a');
    expect(config.agents['agent-tasks']).toMatchObject({ steps: 9, system: 'Prompt policy goes here' });
    expect(config.providers.agent_tasks.models['model-a'].limit).toEqual({ context: 32_000, output: 2_048 });
    expect(config.providers.agent_tasks).toMatchObject({
      env: ['AGENT_TASKS_API_KEY'],
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'http://opencode-provisioner:4090/provider', timeout: 60_000 },
      headers: { 'x-opencode-session': lease.executionId, 'x-agent-tasks-egress': 'egress-token' },
    });
    expect(config.agents['agent-tasks'].permissions).toEqual([{ action: '*', resource: '*', effect: 'deny' }]);
    expect(config.plugins).toEqual([]);
    expect(config.mcp.servers).toEqual({});
    expect(JSON.stringify(config)).not.toContain(input.apiKey);
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
});
