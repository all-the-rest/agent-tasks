import { describe, expect, it, vi } from 'vitest';
import type { RunAgentOptions } from '@agent-tasks/agent-runtime';
import type { BrowserRunnerClient, SearchProvider } from '@agent-tasks/browser-tools';
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
        expect(toolBridge?.tools).toEqual(['compose_email', 'add_email_block']);
        const response = await fetch(hub.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${toolBridge?.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'compose_email', arguments: { dsl: '# Done\n\nAll good.' } } }),
        });
        expect(response.status).toBe(200);
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
          const path = (url as URL).pathname;
          const data = path === '/api/mcp' ? [{ name: 'agent_tasks_tools', status: { status: 'connected' } }]
            : path === '/api/session' ? { id: 'ses_bridge' }
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

  it('offers research and memory tools and merges their validated results', async () => {
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
      const browser = {
        act: vi.fn(async () => ({ ok: true, url: 'https://example.com/report', title: 'Report', text: 'Verified page text.' })),
      } as unknown as BrowserRunnerClient;
      const search = {
        search: vi.fn(async () => [{ title: 'Report', url: 'https://example.com/report', snippet: 'Snippet' }]),
      } as unknown as SearchProvider;
      const call = async (token: string, id: number, name: string, args: unknown): Promise<Record<string, unknown>> => {
        const response = await fetch(hub.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
        return JSON.parse(data) as Record<string, unknown>;
      };
      const open = vi.fn<IsolatedOpenCodeProvisioner['open']>(async ({ toolBridge }) => {
        expect(toolBridge?.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
        expect(toolBridge?.tools).toEqual([
          'search_web',
          'open_url',
          'extract_page_text',
          'inspect_page',
          'click_element',
          'navigate_back',
          'get_page_title',
          'get_current_url',
          'extract_links',
          'record_task_memory',
          'track_recommendation',
        ]);
        const token = toolBridge?.token ?? '';
        expect(((await call(token, 1, 'search_web', { query: 'agent tasks' })).result as { isError: boolean }).isError).toBe(false);
        expect(((await call(token, 2, 'open_url', { url: 'https://example.com/report' })).result as { isError: boolean }).isError).toBe(false);
        expect(((await call(token, 3, 'record_task_memory', { category: 'finding', content: 'The report is verified.' })).result as { isError: boolean }).isError).toBe(false);
        expect(((await call(token, 4, 'track_recommendation', { stableKey: 'report/example', title: 'Example report' })).result as { isError: boolean }).isError).toBe(false);
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
          const path = (url as URL).pathname;
          const data = path === '/api/mcp' ? [{ name: 'agent_tasks_tools', status: { status: 'connected' } }]
            : path === '/api/session' ? { id: 'ses_research' }
              : path.endsWith('/message') ? [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'answer' }] }] : {};
          return new Response(JSON.stringify({ data }));
        });
        return { client: new OpenCodeV2Client({ baseUrl: 'http://test.invalid', password: 'test', fetch: fetchMock }), directory: '/isolated', model: { providerID: 'provider', id: 'model' }, release: vi.fn(async () => undefined) };
      });
      const runner = createIsolatedOpenCodeRunner({ open }, store, hub);
      const result = await runner({
        ...options('owner-key'),
        allowWebResearch: true,
        memoryEnabled: true,
        memoryContext: 'Known fact: the report exists.',
        browser,
        search,
        sessionId: 'browser-session',
      } as RunAgentOptions, { executionId: 'execution-research', ownerId: 'owner', workerId: 'worker' });
      expect(result.markdown).toBe('answer');
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]).toMatchObject({ url: 'https://example.com/report', title: 'Report', confidence: 'verified' });
      expect(result.memoryOps).toEqual([expect.objectContaining({ category: 'finding', content: 'The report is verified.' })]);
      expect(result.recommendationOps).toEqual([expect.objectContaining({ stableKey: 'report/example', title: 'Example report' })]);
      expect(browser.act).toHaveBeenCalledWith('browser-session', { action: 'open_url', url: 'https://example.com/report' });
      expect(search.search).toHaveBeenCalledWith('agent tasks', 5);
    } finally {
      await hub.close();
    }
  });

  it('refuses to expose a research tool without an execution context', async () => {
    const hub = await createToolBridgeHub({ port: 0 });
    try {
      expect(() => hub.open({ tools: ['open_url'] })).toThrow('requires a tool context');
    } finally {
      await hub.close();
    }
  });

  it('requires a tool bridge when the task asks for tools', async () => {
    const open = vi.fn<IsolatedOpenCodeProvisioner['open']>();
    const store = { access: vi.fn(async () => null) } as unknown as OpenCodeSessionStore;
    const runner = createIsolatedOpenCodeRunner({ open }, store);
    await expect(runner({ ...options('secret'), allowWebResearch: true }, { executionId: 'id', ownerId: 'owner', workerId: 'worker' }))
      .rejects.toThrow('tool bridge is not configured');
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
