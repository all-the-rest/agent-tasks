import { describe, expect, it, vi } from 'vitest';
import type { AgentStepRecord, RunAgentOptions } from '@agent-tasks/agent-runtime';
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
    allowWebResearch: false, allowForms: false,
    // The real executor always passes the merged persisted catalog; tool tests
    // declare the capability explicitly rather than inferring it.
    providerContext: { apiKey, config: { models: [{ id: 'model', label: 'Model', supportsTools: true }] } },
    limits: AGENT_RUNTIME_LIMITS,
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
      const onStep = vi.fn();
      const result = await runner(
        { ...options('owner-key'), emailNotification: true, onStep },
        { executionId: 'execution-bridge', ownerId: 'owner', workerId: 'worker' },
      );
      expect(result.markdown).toBe('answer');
      expect(result.emailBlocks.map((block) => block.type)).toEqual(['heading', 'paragraph']);
      expect(onStep.mock.calls.map(([step]) => [step.step, step.tool])).toEqual([
        [1, 'compose_email'],
        [2, 'opencode'],
      ]);
      expect(result.steps.map((step) => [step.step, step.tool])).toEqual([
        [1, 'compose_email'],
        [2, 'opencode'],
      ]);
    } finally {
      await hub.close();
    }
  });

  it('numbers parallel MCP calls once each and places the synthetic step after them', async () => {
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
        const token = toolBridge?.token ?? '';
        const call = (id: number, dsl: string) => fetch(hub.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'add_email_block', arguments: { type: 'paragraph', text: dsl } } }),
        });
        // Both requests are in flight before either finishes; the bridge must still
        // give them distinct numbers and emit one record per invocation.
        const responses = await Promise.all([call(1, 'first'), call(2, 'second')]);
        expect(responses.every((response) => response.status === 200)).toBe(true);
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
          const path = (url as URL).pathname;
          const data = path === '/api/mcp' ? [{ name: 'agent_tasks_tools', status: { status: 'connected' } }]
            : path === '/api/session' ? { id: 'ses_parallel' }
              : path.endsWith('/message') ? [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'answer' }] }] : {};
          return new Response(JSON.stringify({ data }));
        });
        return { client: new OpenCodeV2Client({ baseUrl: 'http://test.invalid', password: 'test', fetch: fetchMock }), directory: '/isolated', model: { providerID: 'provider', id: 'model' }, release: vi.fn(async () => undefined) };
      });
      const runner = createIsolatedOpenCodeRunner({ open }, store, hub);
      const onStep = vi.fn();
      const result = await runner(
        { ...options('owner-key'), emailNotification: true, onStep },
        { executionId: 'execution-parallel', ownerId: 'owner', workerId: 'worker' },
      );

      const emitted = (onStep.mock.calls as Array<[AgentStepRecord]>).map(([step]) => [step.step, step.tool]);
      expect([...emitted].sort((left, right) => left[0]! - right[0]!)).toEqual([
        [1, 'add_email_block'],
        [2, 'add_email_block'],
        [3, 'opencode'],
      ]);
      // The terminal summary is emitted after every tool response and carries the
      // highest number, never one that could replace a real call row.
      expect(emitted.at(-1)).toEqual([3, 'opencode']);
      expect(result.emailBlocks).toHaveLength(2);
      expect(result.steps.map((step) => step.step)).toEqual([1, 2, 3]);
      expect(result.steps.at(-1)?.tool).toBe('opencode');
    } finally {
      await hub.close();
    }
  });

  it('forwards the task tool-call budget into the per-execution bridge', async () => {
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
      const call = async (token: string, id: number): Promise<{ result: { isError: boolean; content: Array<{ text: string }> } }> => {
        const response = await fetch(hub.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'compose_email', arguments: { dsl: 'hello' } } }),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
        return JSON.parse(data) as { result: { isError: boolean; content: Array<{ text: string }> } };
      };
      const open = vi.fn<IsolatedOpenCodeProvisioner['open']>(async ({ toolBridge }) => {
        const token = toolBridge?.token ?? '';
        expect((await call(token, 1)).result.isError).toBe(false);
        const refused = await call(token, 2);
        expect(refused.result.isError).toBe(true);
        expect(refused.result.content[0]?.text).toContain('tool call budget exhausted (1)');
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
          const path = (url as URL).pathname;
          const data = path === '/api/mcp' ? [{ name: 'agent_tasks_tools', status: { status: 'connected' } }]
            : path === '/api/session' ? { id: 'ses_limited' }
              : path.endsWith('/message') ? [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'answer' }] }] : {};
          return new Response(JSON.stringify({ data }));
        });
        return { client: new OpenCodeV2Client({ baseUrl: 'http://test.invalid', password: 'test', fetch: fetchMock }), directory: '/isolated', model: { providerID: 'provider', id: 'model' }, release: vi.fn(async () => undefined) };
      });
      const runner = createIsolatedOpenCodeRunner({ open }, store, hub);
      const result = await runner({
        ...options('owner-key'),
        emailNotification: true,
        limits: { ...AGENT_RUNTIME_LIMITS, maxToolCalls: 1 },
      }, { executionId: 'execution-limited', ownerId: 'owner', workerId: 'worker' });
      expect(result.markdown).toBe('answer');
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

  it('splits model#variant and forwards the base id plus reasoning effort', async () => {
    const mappings = new Map<string, OpenCodeSessionMapping>();
    const store = {
      access: vi.fn(async (lease: OpenCodeExecutionLease, candidate?: OpenCodeSessionMapping) => {
        if (candidate && !mappings.has(lease.executionId)) mappings.set(lease.executionId, candidate);
        return mappings.get(lease.executionId) ?? null;
      }),
      claimPrompt: vi.fn(async () => true),
    } as unknown as OpenCodeSessionStore;
    const release = vi.fn(async () => undefined);
    const sessionBodies: Array<Record<string, unknown>> = [];
    const open = vi.fn<IsolatedOpenCodeProvisioner['open']>(async ({ model }) => {
      expect(model).toEqual({ id: 'mock-model', variant: 'high' });
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        const path = (url as URL).pathname;
        if (path === '/api/session') sessionBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const data = path === '/api/session' ? { id: 'ses_variant' }
          : path.endsWith('/message') ? [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'answer' }] }] : {};
        return new Response(JSON.stringify({ data }));
      });
      return {
        client: new OpenCodeV2Client({ baseUrl: 'http://test.invalid', password: 'test', fetch: fetchMock }),
        directory: '/isolated',
        model: { providerID: 'agent_tasks', ...model },
        release,
      };
    });
    const runner = createIsolatedOpenCodeRunner({ open }, store);
    const result = await runner({
      ...options('owner-key'),
      model: 'mock-model#high',
      providerContext: { apiKey: 'owner-key', config: { models: [{ id: 'mock-model', supportsTools: true }] } },
    }, { executionId: 'execution-variant', ownerId: 'owner', workerId: 'worker' });
    expect(result.markdown).toBe('answer');
    expect(open).toHaveBeenCalledOnce();
    expect(sessionBodies[0]?.model).toEqual({ providerID: 'agent_tasks', id: 'mock-model', variant: 'high' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects an unknown variant or an undeclared base model before provisioning', async () => {
    const open = vi.fn<IsolatedOpenCodeProvisioner['open']>();
    const store = { access: vi.fn(async () => null) } as unknown as OpenCodeSessionStore;
    const runner = createIsolatedOpenCodeRunner({ open }, store);
    const lease = { executionId: 'execution-invalid', ownerId: 'owner', workerId: 'worker' };
    await expect(runner({ ...options('key'), model: 'mock-model#bogus' }, lease)).rejects.toThrow('unknown model variant');
    await expect(runner({
      ...options('key'),
      model: 'missing-model#high',
      providerContext: { apiKey: 'key', config: { models: [{ id: 'mock-model' }] } },
    }, lease)).rejects.toThrow('model missing-model is not configured on its provider');
    expect(open).not.toHaveBeenCalled();
  });

  it('fails instead of running when the provisioned runtime drops the requested variant', async () => {
    const mappings = new Map<string, OpenCodeSessionMapping>();
    const store = {
      access: vi.fn(async (lease: OpenCodeExecutionLease, candidate?: OpenCodeSessionMapping) => {
        if (candidate && !mappings.has(lease.executionId)) mappings.set(lease.executionId, candidate);
        return mappings.get(lease.executionId) ?? null;
      }),
    } as unknown as OpenCodeSessionStore;
    const open = vi.fn<IsolatedOpenCodeProvisioner['open']>(async () => ({
      client: new OpenCodeV2Client({ baseUrl: 'http://test.invalid', password: 'test', fetch: vi.fn<typeof fetch>() }),
      directory: '/isolated',
      model: { providerID: 'agent_tasks', id: 'mock-model' },
      release: vi.fn(async () => undefined),
    }));
    const runner = createIsolatedOpenCodeRunner({ open }, store);
    await expect(runner({
      ...options('key'),
      model: 'mock-model#high',
      providerContext: { apiKey: 'key', config: { models: [{ id: 'mock-model', supportsTools: true }] } },
    }, { executionId: 'execution-dropped', ownerId: 'owner', workerId: 'worker' }))
      .rejects.toThrow('OpenCode model does not match the task model');
  });
});
