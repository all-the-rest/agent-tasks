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
