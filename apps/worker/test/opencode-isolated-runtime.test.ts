import { describe, expect, it, vi } from 'vitest';
import type { RunAgentOptions } from '@agent-tasks/agent-runtime';
import { AGENT_RUNTIME_LIMITS } from '@agent-tasks/shared';
import { createIsolatedOpenCodeRunner } from '../src/opencode-isolated-runtime.js';
import type { IsolatedOpenCodeProvisioner } from '../src/opencode-isolated-runtime.js';
import { createToolBridgeHub } from '../src/opencode-tool-bridge.js';
import type { OpenCodeExecutionLease, OpenCodeSessionMapping, OpenCodeSessionStore } from '../src/opencode-session-store.js';
import { OpenCodeV2Client } from '../src/opencode-v2-client.js';

function options(apiKey: string): RunAgentOptions {
  return {
    provider: { kind: 'openai-compatible' }, model: 'model', title: 'Research task', prompt: 'hello', timezone: 'UTC',
    allowWebResearch: false, allowForms: false, providerContext: { apiKey, config: {} }, limits: AGENT_RUNTIME_LIMITS,
  } as RunAgentOptions;
}

describe('isolated OpenCode runtime integration', () => {
  it('passes each execution only its owner-resolved credentials and releases each runtime', async () => {
    const mappings = new Map<string, OpenCodeSessionMapping>();
    const store = {
      access: vi.fn(async (lease: OpenCodeExecutionLease, candidate?: OpenCodeSessionMapping) => {
        if (candidate && !mappings.has(lease.executionId)) mappings.set(lease.executionId, candidate);
        return mappings.get(lease.executionId) ?? null;
      }),
      claimPrompt: vi.fn(async () => true),
    } as unknown as OpenCodeSessionStore;
    const release = vi.fn(async () => undefined);
    const open = vi.fn<IsolatedOpenCodeProvisioner['open']>(async ({ lease }) => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        const path = (url as URL).pathname;
        const data = path === '/api/session' ? { id: `ses_${lease.ownerId}` }
          : path.endsWith('/message') ? [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: lease.ownerId }] }] : {};
        return new Response(JSON.stringify({ data }));
      });
      return { client: new OpenCodeV2Client({ baseUrl: 'http://test.invalid', password: 'test', fetch: fetchMock }), directory: '/isolated', model: { providerID: 'provider', id: 'model' }, release };
    });
    const runner = createIsolatedOpenCodeRunner({ open }, store);
    const alice = { executionId: 'execution-a', ownerId: 'alice', workerId: 'worker' };
    const bob = { executionId: 'execution-b', ownerId: 'bob', workerId: 'worker' };
    const results = await Promise.all([runner(options('alice-key'), alice), runner(options('bob-key'), bob)]);
    expect(results.map((result) => result.markdown)).toEqual(['alice', 'bob']);
    expect(open.mock.calls.map(([input]) => [input.lease.ownerId, input.providerContext.apiKey])).toEqual([['alice', 'alice-key'], ['bob', 'bob-key']]);
    expect(open.mock.calls.map(([input]) => [input.maxAgentSteps, input.maxOutputBytes, input.systemPrompt.includes('Task title: Research task')]))
      .toEqual([[AGENT_RUNTIME_LIMITS.maxAgentSteps, AGENT_RUNTIME_LIMITS.maxOutputBytes, true], [AGENT_RUNTIME_LIMITS.maxAgentSteps, AGENT_RUNTIME_LIMITS.maxOutputBytes, true]]);
    expect(mappings.get('execution-a')?.sessionId).toBe('ses_alice');
    expect(mappings.get('execution-b')?.sessionId).toBe('ses_bob');
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('opens a per-execution tool bridge and returns its validated e-mail blocks', async () => {
    const hub = await createToolBridgeHub({ port: 0 });
    try {
      const mappings = new Map<string, OpenCodeSessionMapping>();
      const store = {
        access: vi.fn(async (lease: OpenCodeExecutionLease, candidate?: OpenCodeSessionMapping) => {
          if (candidate && !mappings.has(lease.executionId)) mappings.set(lease.executionId, candidate);
          return mappings.get(lease.executionId) ?? null;
        }),
        claimPrompt: vi.fn(async () => true),
      } as unknown as OpenCodeSessionStore;
      const open = vi.fn<IsolatedOpenCodeProvisioner['open']>(async ({ toolBridge }) => {
        expect(toolBridge?.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
        const response = await fetch(hub.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${toolBridge?.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'compose_email', arguments: { dsl: '# Done\n\nAll good.' } } }),
        });
        expect(response.status).toBe(200);
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
          const path = (url as URL).pathname;
          const data = path === '/api/session' ? { id: 'ses_bridge' }
            : path.endsWith('/message') ? [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'answer' }] }] : {};
          return new Response(JSON.stringify({ data }));
        });
        return { client: new OpenCodeV2Client({ baseUrl: 'http://test.invalid', password: 'test', fetch: fetchMock }), directory: '/isolated', model: { providerID: 'provider', id: 'model' }, release: vi.fn(async () => undefined) };
      });
      const runner = createIsolatedOpenCodeRunner({ open }, store, hub);
      const result = await runner({ ...options('owner-key'), emailNotification: true }, { executionId: 'execution-bridge', ownerId: 'owner', workerId: 'worker' });
      expect(result.markdown).toBe('answer');
      expect(result.emailBlocks.map((block) => block.type)).toEqual(['heading', 'paragraph']);
    } finally {
      await hub.close();
    }
  });

  it('rejects unsupported tasks before provisioning or exposing credentials', async () => {
    const open = vi.fn<IsolatedOpenCodeProvisioner['open']>();
    const runner = createIsolatedOpenCodeRunner({ open }, {} as OpenCodeSessionStore);
    await expect(runner({ ...options('secret'), allowWebResearch: true }, { executionId: 'id', ownerId: 'owner', workerId: 'worker' })).rejects.toThrow('without web research');
    expect(open).not.toHaveBeenCalled();
  });

  it('does not expose secrets in provisioning failures', async () => {
    const open = vi.fn<IsolatedOpenCodeProvisioner['open']>().mockRejectedValue(new Error('secret'));
    const store = { access: vi.fn().mockResolvedValue(null) } as unknown as OpenCodeSessionStore;
    const runner = createIsolatedOpenCodeRunner({ open }, store);
    await expect(runner(options('secret'), { executionId: 'id', ownerId: 'owner', workerId: 'worker' })).rejects.toThrow('Unable to open isolated OpenCode runtime');
  });

  it('does not pass credentials to the provisioner when the owner or lease check fails', async () => {
    const open = vi.fn<IsolatedOpenCodeProvisioner['open']>();
    const store = { access: vi.fn().mockRejectedValue(new Error('OpenCode execution lease unavailable')) } as unknown as OpenCodeSessionStore;
    const runner = createIsolatedOpenCodeRunner({ open }, store);
    await expect(runner(options('secret'), { executionId: 'id', ownerId: 'other-owner', workerId: 'worker' })).rejects.toThrow('lease unavailable');
    expect(open).not.toHaveBeenCalled();
  });
});
