import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OllamaProvider, ProviderError } from '../src/index.js';
import type { ChatMessage, ProviderContext, ToolDefinition } from '../src/index.js';
import { createFakeOllamaServer } from './fake-ollama.js';
import type { FakeOllamaServer, RecordedOllamaRequest } from './fake-ollama.js';

let server: FakeOllamaServer;
const provider = new OllamaProvider();

function context(extra: Record<string, unknown> = {}): ProviderContext {
  return {
    config: {
      baseUrl: server.url,
      timeoutMs: 5_000,
      requireToolSupport: true,
      ...extra,
    },
  };
}

function chatRequests(): RecordedOllamaRequest[] {
  return server.requests.filter((request) => request.path === '/api/chat');
}

const SEARCH_TOOL: ToolDefinition = {
  name: 'search_web',
  description: 'search the web',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'search terms' } },
    required: ['query'],
  },
};

beforeEach(async () => {
  server = await createFakeOllamaServer();
});

afterEach(async () => {
  await server.close();
});

describe('ollama adapter wire protocol', () => {
  it('reports health from GET /api/tags', async () => {
    await expect(provider.health(context())).resolves.toEqual({ ok: true, message: 'reachable' });
    expect(server.requests.at(-1)?.path).toBe('/api/tags');
  });

  it('lists models from /api/tags and tool support from /api/show', async () => {
    const models = await provider.listModels(context());
    expect(models).toEqual([{ id: 'fake:latest', label: 'fake:latest', supportsTools: true }]);
    expect(server.requests.filter((request) => request.path === '/api/show').at(-1)?.body).toEqual({ model: 'fake:latest' });
  });

  it('does not claim tool support the capability probe did not confirm', async () => {
    server.scenario.capabilities = ['completion'];
    const models = await provider.listModels(context());
    expect(models[0]?.supportsTools).toBe(false);
  });

  it('assembles content, finish reason and usage from the documented chat response', async () => {
    const response = await provider.chat(context(), {
      model: 'fake:latest',
      sessionId: 'conv-1',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(response).toEqual({
      content: 'Hello from the fake Ollama server.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 18, completionTokens: 7, totalTokens: 25 },
    });

    const body = chatRequests().at(-1)?.body;
    expect(body).toMatchObject({
      model: 'fake:latest',
      stream: false,
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' },
      ],
      options: { temperature: 0.2 },
    });
    expect(body?.options).not.toHaveProperty('num_predict');
  });

  it('posts the full request contract and normalises a trailing-slash base URL', async () => {
    await provider.chat(context({ baseUrl: `${server.url}/`, requireToolSupport: false }), {
      model: 'fake:latest',
      sessionId: 'conv-2',
      temperature: 0.9,
      maxTokens: 128,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [SEARCH_TOOL],
    });

    const request = chatRequests().at(-1);
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/api/chat');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.body).toEqual({
      model: 'fake:latest',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      options: { temperature: 0.9, num_predict: 128 },
      tools: [
        {
          type: 'function',
          function: { name: 'search_web', description: 'search the web', parameters: SEARCH_TOOL.parameters },
        },
      ],
    });

    // A base URL without a trailing slash must hit the same path (all other tests use that form).
    await provider.chat(context({ requireToolSupport: false }), {
      model: 'fake:latest',
      sessionId: 'conv-2b',
      messages: [{ role: 'user', content: 'hi again' }],
    });
    expect(chatRequests().at(-1)?.path).toBe('/api/chat');
  });

  it('parses Ollama tool calls with arguments as an object, not a JSON string', async () => {
    server.scenario.content = '';
    server.scenario.toolCalls = [{ name: 'search_web', arguments: { query: 'vienna transport', limit: 3 } }];

    const response = await provider.chat(context(), {
      model: 'fake:latest',
      sessionId: 'conv-3',
      messages: [{ role: 'user', content: 'latest vienna transport news' }],
      tools: [SEARCH_TOOL],
    });

    expect(response.content).toBe('');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toMatchObject({ name: 'search_web', arguments: { query: 'vienna transport', limit: 3 } });
    expect(typeof response.toolCalls[0]?.arguments).toBe('object');
    expect(response.toolCalls[0]?.id).toMatch(/^ollama_0_\d+$/);

    // The capability probe runs before the chat request when tools are offered.
    expect(server.requests.filter((request) => request.path === '/api/show')).toHaveLength(1);
    expect(chatRequests().at(-1)?.body?.tools).toEqual([
      {
        type: 'function',
        function: { name: 'search_web', description: 'search the web', parameters: SEARCH_TOOL.parameters },
      },
    ]);
  });

  it('refuses a model whose capability probe omits tools', async () => {
    server.scenario.capabilities = ['completion'];
    await expect(
      provider.chat(context(), {
        model: 'fake:latest',
        sessionId: 'conv-3b',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [SEARCH_TOOL],
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(chatRequests()).toHaveLength(0);
  });

  it('refuses tool calling when the capability probe fails closed', async () => {
    server.scenario.capabilityProbeFailure = true;
    await expect(
      provider.chat(context(), {
        model: 'fake:latest',
        sessionId: 'conv-3c',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [SEARCH_TOOL],
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(chatRequests()).toHaveLength(0);
  });

  it('round-trips assistant tool calls and a tool-role result in the follow-up request', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'weather in vienna?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'ollama_0_1', name: 'search_web', arguments: { query: 'vienna weather' } }] },
      { role: 'tool', toolCallId: 'ollama_0_1', content: '{"ok":true,"summary":"sunny"}' },
    ];

    await provider.chat(context({ requireToolSupport: false }), { model: 'fake:latest', sessionId: 'conv-4', messages });

    const body = chatRequests().at(-1)?.body;
    expect(body?.messages).toEqual([
      { role: 'user', content: 'weather in vienna?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'search_web', arguments: { query: 'vienna weather' } } }],
      },
      { role: 'tool', content: '{"ok":true,"summary":"sunny"}' },
    ]);
    // NOTE: Ollama documents `tool_name` on tool-role messages; the adapter currently drops it (see report).
  });

  it('maps a model-not-found response to the typed model_missing error', async () => {
    server.scenario.failure = 'model_not_found';

    const error: unknown = await provider
      .chat(context(), { model: 'ghost:latest', sessionId: 'conv-5', messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'model_missing', status: 404 });
    expect((error as Error).message).toContain('ghost:latest');
    expect((error as Error).message).toContain('not found');
  });

  it('maps a 500 response to the typed bad_response error', async () => {
    server.scenario.failure = 'server_error';

    const error: unknown = await provider
      .chat(context(), { model: 'fake:latest', sessionId: 'conv-6', messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'bad_response', status: 500 });
    expect((error as Error).message).toContain('fake internal server error');
  });

  it('surfaces a connection destroyed mid-body instead of hanging', async () => {
    server.scenario.failure = 'destroy_mid_body';
    const startedAt = Date.now();

    const error: unknown = await provider
      .chat(context(), { model: 'fake:latest', sessionId: 'conv-7', messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('maps a mid-body connection destroy to the typed unavailable error', async () => {
    server.scenario.failure = 'destroy_mid_body';

    const error: unknown = await provider
      .chat(context(), { model: 'fake:latest', sessionId: 'conv-7b', messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'unavailable' });
  });

  it('cancels an in-flight request through AbortSignal without an unhandled rejection', async () => {
    server.scenario.chatDelayMs = 500;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const controller = new AbortController();
    try {
      const pending = provider.chat(context(), {
        model: 'fake:latest',
        sessionId: 'conv-8',
        messages: [{ role: 'user', content: 'wait forever' }],
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 25);

      const error: unknown = await pending.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code: 'timeout' });

      // Give Node one turn to report any orphaned rejection before asserting none occurred.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      if (!controller.signal.aborted) controller.abort();
    }
  });

  it('speaks the documented NDJSON stream when a client asks for stream:true', async () => {
    server.scenario.content = 'one two three';

    const response = await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake:latest', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });

    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await response.text())
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { message?: { content?: string; tool_calls?: unknown[] }; done?: boolean });
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.at(-1)).toMatchObject({ done: true, done_reason: 'stop', prompt_eval_count: 18, eval_count: 7 });
    expect(lines.slice(0, -1).every((line) => line.done === false)).toBe(true);
    expect(lines.map((line) => line.message?.content ?? '').join('')).toBe('one two three');

    // Tool calls arrive the same way: one chunk with `message.tool_calls`, arguments as objects.
    server.scenario.content = '';
    server.scenario.toolCalls = [{ name: 'search_web', arguments: { query: 'x' } }];
    const toolResponse = await fetch(`${server.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake:latest', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const toolLines = (await toolResponse.text())
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> }; done?: boolean });
    const callLine = toolLines.find((line) => (line.message?.tool_calls?.length ?? 0) > 0);
    expect(callLine?.done).toBe(false);
    expect(callLine?.message?.tool_calls?.[0]?.function).toEqual({ name: 'search_web', arguments: { query: 'x' } });
    expect(toolLines.at(-1)?.done).toBe(true);

    // The adapter itself sends `stream:false`; this proves the fake matches the documented API.
    expect(server.requests.at(-1)?.body?.stream).toBe(true);
  });
});
