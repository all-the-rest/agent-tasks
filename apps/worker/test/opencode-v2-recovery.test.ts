import { describe, expect, it, vi } from 'vitest';
import type { RunAgentOptions } from '@agent-tasks/agent-runtime';
import { AgentCancelledError } from '@agent-tasks/agent-runtime';
import { AGENT_RUNTIME_LIMITS } from '@agent-tasks/shared';
import { OpenCodeV2Client } from '../src/opencode-v2-client.js';
import { createOpenCodeV2Runner } from '../src/opencode-v2-runner.js';
import type { OpenCodeExecutionLease, OpenCodeSessionMapping, OpenCodeSessionStore } from '../src/opencode-session-store.js';

const lease: OpenCodeExecutionLease = { executionId: 'execution-1', ownerId: 'owner-1', workerId: 'worker-1' };
const mapping: OpenCodeSessionMapping = { sessionId: 'ses_1', messageId: 'msg_1', promptDispatched: true };

function options(overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
  return {
    provider: { kind: 'openai-compatible' },
    providerContext: { apiKey: 'test', config: {} },
    model: 'model',
    title: 'Task',
    prompt: 'hello',
    timezone: 'UTC',
    allowWebResearch: false,
    allowForms: false,
    limits: AGENT_RUNTIME_LIMITS,
    ...overrides,
  } as RunAgentOptions;
}

function store(overrides: Partial<{ access: unknown; claimPrompt: unknown }> = {}): OpenCodeSessionStore {
  return {
    access: vi.fn(async () => mapping),
    claimPrompt: vi.fn(async () => false),
    ...overrides,
  } as unknown as OpenCodeSessionStore;
}

const completed = {
  type: 'assistant',
  finish: 'stop',
  content: [{ type: 'text', text: 'durable answer' }],
  time: { created: 1_000, completed: 1_500 },
  tokens: { input: 10, output: 5 },
  cost: 0.01,
};

function clientWith(handler: (path: string, init?: RequestInit) => Response): OpenCodeV2Client {
  return new OpenCodeV2Client({
    baseUrl: 'http://test.invalid',
    password: 'test',
    fetch: vi.fn<typeof fetch>(async (url, init) => handler((url as URL).pathname, init)),
  });
}

describe('OpenCode runner recovery', () => {
  it('returns a completed durable message without dispatching the prompt again', async () => {
    const prompt = vi.fn();
    const client = clientWith((path) => {
      if (path.endsWith('/message')) return new Response(JSON.stringify({ data: [completed] }));
      prompt(path);
      return new Response(JSON.stringify({ data: {} }));
    });
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(options(), lease);
    expect(result.markdown).toBe('durable answer');
    expect(result.usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15, allowanceUsd: 0.01 });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('sums usage across tool-calling turns and keeps the final answer', async () => {
    const intermediate = {
      type: 'assistant',
      finish: 'tool_calls',
      content: [{ type: 'tool_call' }],
      time: { created: 900, completed: 950 },
      tokens: { input: 20, output: 3, reasoning: 1 },
      cost: 0.25,
    };
    const final = { ...completed, tokens: { input: 5, output: 2, reasoning: 1 }, cost: 0.5 };
    const client = clientWith((path) => {
      if (path.endsWith('/message')) return new Response(JSON.stringify({ data: [intermediate, final] }));
      return new Response(JSON.stringify({ data: {} }));
    });
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(options(), lease);
    expect(result.markdown).toBe('durable answer');
    expect(result.usage).toEqual({ promptTokens: 25, completionTokens: 7, totalTokens: 32, allowanceUsd: 0.75 });
  });

  it('reports a truthful uncertainty note when web research is disabled', async () => {
    const client = clientWith((path) => path.endsWith('/message')
      ? new Response(JSON.stringify({ data: [completed] }))
      : new Response(JSON.stringify({ data: {} })));
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(
      options({ allowWebResearch: false }),
      lease,
    );
    expect(result.uncertainty).toEqual([
      'Web research was disabled for this task, so the answer was not verified against external sources.',
    ]);
  });

  it('reports that no research happened when web research was allowed but no research tool ran', async () => {
    const client = clientWith((path) => path.endsWith('/message')
      ? new Response(JSON.stringify({ data: [completed] }))
      : new Response(JSON.stringify({ data: {} })));
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(
      options({ allowWebResearch: true }),
      lease,
    );
    expect(result.uncertainty).toEqual(['No web research was performed, so no source was verified.']);
  });

  it('reports a limitation instead of a false no-research claim when a bridge is attached but no tool parts were returned', async () => {
    // test/helpers/fake-opencode.ts invokes bridge tools during prompt dispatch
    // and then emits only the final assistant text, without tool parts.
    const client = clientWith((path) => {
      if (path === '/api/mcp') {
        return new Response(JSON.stringify({ data: [{ name: 'agent_tasks_tools', status: { status: 'connected' } }] }));
      }
      return path.endsWith('/message')
        ? new Response(JSON.stringify({ data: [completed] }))
        : new Response(JSON.stringify({ data: {} }));
    });
    const result = await createOpenCodeV2Runner({
      client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store(), requiresMcp: true,
    })(options({ allowWebResearch: true }), lease);
    expect(result.uncertainty).toEqual([
      'The runtime did not expose tool-call evidence, so it could not be confirmed whether web research was performed.',
    ]);
  });

  it('can still prove that research did not run when the runtime reports other tool parts', async () => {
    const toolTurn = {
      type: 'assistant',
      finish: 'tool-calls',
      content: [{ type: 'tool', name: 'agent_tasks_tools_compose_email', state: { status: 'completed' } }],
      time: { created: 900, completed: 950 },
      tokens: { input: 20, output: 3 },
    };
    const client = clientWith((path) => {
      if (path === '/api/mcp') {
        return new Response(JSON.stringify({ data: [{ name: 'agent_tasks_tools', status: { status: 'connected' } }] }));
      }
      return path.endsWith('/message')
        ? new Response(JSON.stringify({ data: [toolTurn, completed] }))
        : new Response(JSON.stringify({ data: {} }));
    });
    const result = await createOpenCodeV2Runner({
      client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store(), requiresMcp: true,
    })(options({ allowWebResearch: true }), lease);
    expect(result.uncertainty).toEqual(['No web research was performed, so no source was verified.']);
  });

  it('stays silent when a completed page-opening tool call verifies a source', async () => {
    // OpenCode exposes bridged MCP tools under the server name.
    const toolTurn = {
      type: 'assistant',
      finish: 'tool-calls',
      content: [{ type: 'tool', name: 'agent_tasks_tools_open_url', state: { status: 'completed' } }],
      time: { created: 900, completed: 950 },
      tokens: { input: 20, output: 3 },
    };
    const client = clientWith((path) => path.endsWith('/message')
      ? new Response(JSON.stringify({ data: [toolTurn, completed] }))
      : new Response(JSON.stringify({ data: {} })));
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(
      options({ allowWebResearch: true }),
      lease,
    );
    expect(result.uncertainty).toEqual([]);
  });

  it('reports that no page was opened when research stopped at search results', async () => {
    const toolTurn = {
      type: 'assistant',
      finish: 'tool-calls',
      content: [{ type: 'tool', name: 'search_web', state: { status: 'completed' } }],
      time: { created: 900, completed: 950 },
      tokens: { input: 20, output: 3 },
    };
    const client = clientWith((path) => path.endsWith('/message')
      ? new Response(JSON.stringify({ data: [toolTurn, completed] }))
      : new Response(JSON.stringify({ data: {} })));
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(
      options({ allowWebResearch: true }),
      lease,
    );
    expect(result.uncertainty).toEqual(['No web page was opened, so no source was verified.']);
  });

  it('reports a failed page-opening call as missing evidence', async () => {
    const toolTurn = {
      type: 'assistant',
      finish: 'tool-calls',
      content: [{ type: 'tool', name: 'agent_tasks_tools_open_url', state: { status: 'error' } }],
      time: { created: 900, completed: 950 },
      tokens: { input: 20, output: 3 },
    };
    const client = clientWith((path) => path.endsWith('/message')
      ? new Response(JSON.stringify({ data: [toolTurn, completed] }))
      : new Response(JSON.stringify({ data: {} })));
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(
      options({ allowWebResearch: true }),
      lease,
    );
    expect(result.uncertainty).toEqual([
      'No web page could be opened successfully, so no source was verified.',
      'A web research tool call failed during this run: open_url. Evidence from that call may be missing.',
    ]);
  });

  it('reports all failed research tools once, even when another page opened', async () => {
    const toolTurn = {
      type: 'assistant',
      finish: 'tool-calls',
      content: [
        { type: 'tool', name: 'agent_tasks_tools_open_url', state: { status: 'completed' } },
        { type: 'tool', name: 'agent_tasks_tools_open_url', state: { status: 'error' } },
        { type: 'tool', name: 'agent_tasks_tools_search_web', state: { status: 'error' } },
      ],
      time: { created: 900, completed: 950 },
      tokens: { input: 20, output: 3 },
    };
    const client = clientWith((path) => path.endsWith('/message')
      ? new Response(JSON.stringify({ data: [toolTurn, completed] }))
      : new Response(JSON.stringify({ data: {} })));
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(
      options({ allowWebResearch: true }),
      lease,
    );
    expect(result.uncertainty).toEqual([
      'Web research tool calls failed during this run: open_url, search_web. Evidence from those calls may be missing.',
    ]);
  });

  it('does not turn an unreadable tool status into a failed-research claim', async () => {
    const toolTurn = {
      type: 'assistant',
      finish: 'tool-calls',
      content: [{ type: 'tool', name: 'open_url', state: {} }],
      time: { created: 900, completed: 950 },
      tokens: { input: 20, output: 3 },
    };
    const client = clientWith((path) => path.endsWith('/message')
      ? new Response(JSON.stringify({ data: [toolTurn, completed] }))
      : new Response(JSON.stringify({ data: {} })));
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(
      options({ allowWebResearch: true }),
      lease,
    );
    expect(result.uncertainty).toEqual([]);
  });

  it('reports the evidence limitation when a tool-calling turn has no readable tool parts', async () => {
    const toolTurn = {
      type: 'assistant',
      finish: 'tool-calls',
      content: [{ type: 'tool_call' }],
      time: { created: 900, completed: 950 },
      tokens: { input: 20, output: 3 },
    };
    const client = clientWith((path) => path.endsWith('/message')
      ? new Response(JSON.stringify({ data: [toolTurn, completed] }))
      : new Response(JSON.stringify({ data: {} })));
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(
      options({ allowWebResearch: true }),
      lease,
    );
    expect(result.uncertainty).toEqual([
      'The runtime did not expose tool-call evidence, so it could not be confirmed whether web research was performed.',
    ]);
  });

  it('treats a 409 prompt replay as accepted and waits for the durable message', async () => {
    let messages = 0;
    const client = clientWith((path) => {
      if (path.endsWith('/message')) {
        messages += 1;
        return new Response(JSON.stringify({ data: messages === 1 ? [] : [completed] }));
      }
      if (path.endsWith('/prompt')) return new Response(JSON.stringify({ error: { message: 'conflict' } }), { status: 409 });
      return new Response(JSON.stringify({ data: {} }));
    });
    const result = await createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(options(), lease);
    expect(result.markdown).toBe('durable answer');
    expect(messages).toBeGreaterThanOrEqual(2);
  });

  it('fails closed when the very first dispatch is rejected without a durable message', async () => {
    const client = clientWith((path) => {
      if (path.endsWith('/message')) return new Response(JSON.stringify({ data: [] }));
      if (path.endsWith('/prompt')) return new Response(JSON.stringify({ error: { message: 'conflict' } }), { status: 409 });
      return new Response(JSON.stringify({ data: {} }));
    });
    const first = store({ claimPrompt: vi.fn(async () => true) });
    await expect(createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: first })(options(), lease))
      .rejects.toThrow('rejected the prompt without a durable message');
  });

  it('classifies provider rate limits and outages as retryable, other errors as terminal', async () => {
    const clientFor = (error: unknown): OpenCodeV2Client => clientWith((path) => {
      if (path.endsWith('/message')) {
        return new Response(JSON.stringify({ data: [{ ...completed, finish: 'error', content: [], error }] }));
      }
      return new Response(JSON.stringify({ data: {} }));
    });
    const run = (error: unknown) => createOpenCodeV2Runner({
      client: clientFor(error), directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store(),
    })(options(), lease);

    await expect(run({ name: 'ProviderError', data: { message: '429 Too Many Requests' } }))
      .rejects.toMatchObject({ code: 'rate_limited' });
    await expect(run({ name: 'ProviderError', data: { message: '503 Service Unavailable' } }))
      .rejects.toMatchObject({ code: 'unavailable' });
    await expect(run({ name: 'ProviderError', data: { message: 'invalid api key' } }))
      .rejects.toThrow('did not complete successfully');
  });

  it('waits for the MCP bridge to connect before dispatching', async () => {
    let statusReads = 0;
    let messageReads = 0;
    const prompt = vi.fn();
    const client = clientWith((path) => {
      if (path === '/api/mcp') {
        statusReads += 1;
        return new Response(JSON.stringify({ data: [{ name: 'agent_tasks_tools', status: { status: statusReads === 1 ? 'connecting' : 'connected' } }] }));
      }
      if (path.endsWith('/message')) {
        messageReads += 1;
        return new Response(JSON.stringify({ data: messageReads === 1 ? [] : [completed] }));
      }
      if (path.endsWith('/prompt')) {
        prompt();
        return new Response(JSON.stringify({ data: {} }));
      }
      return new Response(JSON.stringify({ data: {} }));
    });
    const result = await createOpenCodeV2Runner({
      client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store(), requiresMcp: true,
    })(options(), lease);
    expect(result.markdown).toBe('durable answer');
    expect(statusReads).toBe(2);
    expect(prompt).toHaveBeenCalled();
  });

  it('interrupts the session and reports cancellation', async () => {
    const controller = new AbortController();
    const interrupt = vi.fn(async () => new Response(JSON.stringify({ data: {} })));
    const client = clientWith((path) => {
      if (path.endsWith('/message')) return new Response(JSON.stringify({ data: [] }));
      if (path.endsWith('/prompt')) {
        controller.abort();
        return new Response(JSON.stringify({ data: {} }));
      }
      if (path.endsWith('/interrupt')) interrupt();
      return new Response(JSON.stringify({ data: {} }));
    });
    await expect(createOpenCodeV2Runner({ client, directory: '/tmp', model: { providerID: 'p', id: 'model' }, store: store() })(options({ signal: controller.signal }), lease))
      .rejects.toBeInstanceOf(AgentCancelledError);
    expect(interrupt).toHaveBeenCalled();
  });
});
