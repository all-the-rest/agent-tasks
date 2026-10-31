import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockOpenAiServer } from '@agent-tasks/mock-openai';
import type { MockServer } from '@agent-tasks/mock-openai';
import { OpenAiCompatibleProvider, ProviderError, buildHeaders, chatCompletionsUrl, modelsUrl } from '../src/index.js';
import type { ProviderContext } from '../src/index.js';

let server: MockServer;
const provider = new OpenAiCompatibleProvider();

function context(extra: Record<string, unknown> = {}): ProviderContext {
  return {
    apiKey: 'test-key',
    config: {
      baseUrl: server.url,
      headers: { 'x-client-name': 'agent-tasks-tests' },
      userAgent: 'agent-tasks/0.1.0 (tests)',
      sessionHeader: 'x-opencode-session',
      models: [{ id: 'mock-researcher', supportsTools: true }],
      timeoutMs: 5_000,
      ...extra,
    },
  };
}

beforeAll(async () => {
  server = await createMockOpenAiServer({ researchSteps: 2 });
});

afterAll(async () => {
  await server.close();
});

describe('openai-compatible adapter', () => {
  it('derives the completions and models urls', () => {
    expect(chatCompletionsUrl('https://opencode.ai/inference/go/openai/v1')).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(modelsUrl('https://opencode.ai/inference/go/openai/v1')).toBe('https://opencode.ai/inference/go/openai/v1/models');
    expect(chatCompletionsUrl('https://host/v1/chat/completions')).toBe('https://host/v1/chat/completions');
  });

  it('sends the required client headers', () => {
    const headers = buildHeaders(
      { baseUrl: 'https://x/v1', headers: { 'x-extra': '1' }, userAgent: 'agent-tasks/0.1.0', sessionHeader: 'x-opencode-session', timeoutMs: 1_000 },
      'sk-test',
      'session-abc',
    );
    expect(headers['user-agent']).toBe('agent-tasks/0.1.0');
    expect(headers['x-opencode-session']).toBe('session-abc');
    expect(headers['x-extra']).toBe('1');
    expect(headers.authorization).toBe('Bearer sk-test');
  });

  it('parses tool calls and usage from a real HTTP response', async () => {
    const response = await provider.chat(context(), {
      model: 'mock-researcher',
      sessionId: 'conv-1',
      messages: [
        { role: 'system', content: 'research system prompt' },
        { role: 'user', content: 'latest news about vienna transport' },
      ],
      tools: [{ name: 'search_web', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
    });
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]?.name).toBe('search_web');
    expect(response.usage?.totalTokens).toBeGreaterThan(0);
    expect(response.usage?.allowanceUsd).toBeCloseTo(0.0021);
    const last = server.requests.at(-1);
    expect(last?.headers['x-opencode-session']).toBe('conv-1');
    expect(String(last?.headers['user-agent'])).toContain('agent-tasks');
  });

  it('refuses a model that is declared as not tool-capable', async () => {
    await expect(
      provider.chat(context({ models: [{ id: 'mock-text-only', supportsTools: false }] }), {
        model: 'mock-text-only',
        sessionId: 'conv-2',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'search_web', description: 'search', parameters: { type: 'object', properties: {} } }],
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('discovers models and does not claim tool support it cannot verify', async () => {
    const models = await provider.listModels(context());
    expect(models.map((model) => model.id)).toContain('mock-researcher');
    expect(models.find((model) => model.id === 'mock-text-only')?.supportsTools).toBe(false);
  });

  it('surfaces authentication failures as ProviderError auth', async () => {
    const failing = await createMockOpenAiServer({ failAtIndex: 0, failWithStatus: 401 });
    try {
      await expect(
        provider.chat({ apiKey: 'bad', config: { baseUrl: failing.url, headers: {}, userAgent: 'agent-tasks/0.1.0', sessionHeader: 'x-opencode-session', timeoutMs: 5_000 } }, {
          model: 'mock-researcher',
          sessionId: 's',
          messages: [{ role: 'user', content: 'x' }],
        }),
      ).rejects.toMatchObject({ code: 'auth' });
    } finally {
      await failing.close();
    }
  });

  it('rejects a generic SDK user agent at the endpoint', async () => {
    const response = await fetch(`${server.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'undici', 'x-opencode-session': 'x' },
      body: JSON.stringify({ model: 'mock-researcher', messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects a missing session header at the endpoint', async () => {
    const response = await fetch(`${server.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'agent-tasks/0.1.0' },
      body: JSON.stringify({ model: 'mock-researcher', messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(response.status).toBe(400);
  });
});
