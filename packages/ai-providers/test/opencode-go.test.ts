import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider, ProviderError, buildHeaders, chatCompletionsUrl, modelsUrl } from '../src/index.js';
import type { ProviderContext, ToolCallRequest } from '../src/index.js';
import { createOpenCodeGoServer } from './fixtures/opencode-go-server.js';
import type { OpenCodeGoScenario, OpenCodeGoServer, RecordedOpenCodeGoRequest } from './fixtures/opencode-go-server.js';

const provider = new OpenAiCompatibleProvider();
let servers: OpenCodeGoServer[] = [];

async function start(options: Partial<OpenCodeGoScenario> = {}): Promise<OpenCodeGoServer> {
  const server = await createOpenCodeGoServer(options);
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.map(async (server) => server.close()));
  servers = [];
});

function context(server: OpenCodeGoServer, extra: Record<string, unknown> = {}): ProviderContext {
  return {
    apiKey: 'sk-opencode-go-test',
    config: {
      baseUrl: `${server.url}/v1`,
      headers: { 'x-client-name': 'agent-tasks-tests' },
      userAgent: 'agent-tasks/0.1.0 (opencode-go tests)',
      sessionHeader: 'x-opencode-session',
      timeoutMs: 5_000,
      ...extra,
    },
  };
}

function lastRequest(server: OpenCodeGoServer): RecordedOpenCodeGoRequest {
  const request = server.requests.at(-1);
  if (!request) throw new Error('expected the adapter to send a request');
  return request;
}

function bodyOf(server: OpenCodeGoServer): Record<string, unknown> {
  const body = lastRequest(server).body;
  if (!body) throw new Error('expected a JSON request body');
  return body;
}

interface RecordedMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
}

function messagesOf(server: OpenCodeGoServer): RecordedMessage[] {
  return (bodyOf(server).messages ?? []) as RecordedMessage[];
}

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(TypeError);
    return error as ProviderError;
  }
  throw new Error('expected the provider call to reject');
}

const tools = [
  {
    name: 'search_web',
    description: 'Search the web',
    parameters: { type: 'object' as const, properties: { query: { type: 'string' as const } }, required: ['query'] },
  },
];

describe('OpenCode Go streaming adapter', () => {
  it('streams a plain completion and concatenates content in order', async () => {
    const server = await start({ content: 'Streamed answer in exactly this order.' });
    const response = await provider.chat(context(server), {
      model: 'opencode-go-heavy',
      sessionId: 'conv-stream',
      messages: [
        { role: 'system', content: 'system prompt for streaming' },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(response.content).toBe('Streamed answer in exactly this order.');
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe('stop');
    expect(response.usage?.promptTokens).toBe(41);
    expect(response.usage?.completionTokens).toBe(9);
    expect(response.usage?.totalTokens).toBe(50);
    expect(response.usage?.allowanceUsd).toBeCloseTo(1.2345);

    const request = lastRequest(server);
    expect(request.path).toBe('/v1/chat/completions');
    expect(bodyOf(server).stream).toBe(true);
    expect(request.headers.accept).toBe('text/event-stream');
  });

  it('still supports the non-streaming JSON path when stream is disabled', async () => {
    const server = await start({ content: 'Plain JSON answer.' });
    const response = await provider.chat(context(server, { stream: false }), {
      model: 'opencode-go-heavy',
      sessionId: 'conv-json',
      messages: [
        { role: 'system', content: 'system prompt for json' },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(response.content).toBe('Plain JSON answer.');
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe('stop');
    expect(response.usage?.totalTokens).toBe(50);
    expect(response.usage?.allowanceUsd).toBeCloseTo(1.2345);
    expect(bodyOf(server).stream).toBe(false);
    expect(lastRequest(server).headers.accept).toBe('application/json');
  });

  it('assembles streamed tool-call fragments into parsed arguments', async () => {
    const server = await start({
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ name: 'search_web', arguments: { query: 'vienna transport', limit: 3 } }],
    });
    const response = await provider.chat(context(server), {
      model: 'opencode-go-heavy',
      sessionId: 'conv-tools',
      messages: [
        { role: 'system', content: 'system prompt for tools' },
        { role: 'user', content: 'find vienna transport news' },
      ],
      tools,
    });

    expect(response.toolCalls).toHaveLength(1);
    const call = response.toolCalls[0] as ToolCallRequest;
    expect(call.name).toBe('search_web');
    expect(call.id).toMatch(/^call_0_/);
    expect(call.arguments).toEqual({ query: 'vienna transport', limit: 3 });
    expect(response.finishReason).toBe('tool_calls');
    expect(bodyOf(server).tool_choice).toBe('auto');
  });

  it('round-trips an assistant tool call and its tool result in the next request', async () => {
    const server = await start({
      toolCalls: [{ name: 'search_web', arguments: { query: 'first turn' } }],
      finishReason: 'tool_calls',
    });
    const first = await provider.chat(context(server), {
      model: 'opencode-go-heavy',
      sessionId: 'conv-loop',
      messages: [
        { role: 'system', content: 'system prompt for the tool loop' },
        { role: 'user', content: 'start the loop' },
      ],
      tools,
    });
    const call = first.toolCalls[0] as ToolCallRequest;

    server.scenario.toolCalls = [];
    server.scenario.content = 'Final answer after the tool result.';
    server.scenario.finishReason = 'stop';

    const second = await provider.chat(context(server), {
      model: 'opencode-go-heavy',
      sessionId: 'conv-loop',
      messages: [
        { role: 'system', content: 'system prompt for the tool loop' },
        { role: 'user', content: 'start the loop' },
        { role: 'assistant', content: first.content, toolCalls: first.toolCalls },
        { role: 'tool', toolCallId: call.id, content: 'search result body' },
      ],
      tools,
    });

    expect(second.content).toBe('Final answer after the tool result.');
    expect(second.toolCalls).toEqual([]);

    const sent = messagesOf(server);
    expect(sent[2]?.role).toBe('assistant');
    expect(sent[2]?.tool_calls?.[0]?.id).toBe(call.id);
    expect(sent[2]?.tool_calls?.[0]?.function?.name).toBe('search_web');
    expect(JSON.parse(sent[2]?.tool_calls?.[0]?.function?.arguments ?? '{}')).toEqual({ query: 'first turn' });
    expect(sent[3]?.role).toBe('tool');
    expect(sent[3]?.tool_call_id).toBe(call.id);
    expect(sent[3]?.content).toBe('search result body');
    expect(lastRequest(server).headers['x-opencode-session']).toBe('conv-loop');
  });

  it('reads usage and allowance from a separate opencode object', async () => {
    const server = await start({ opencodeUsage: true, allowanceHeader: false, allowanceUsd: 7.5 });
    const response = await provider.chat(context(server), {
      model: 'opencode-go-light',
      sessionId: 'conv-opencode-object',
      messages: [
        { role: 'system', content: 'system prompt for opencode usage' },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(response.usage).toMatchObject({ promptTokens: 41, completionTokens: 9, totalTokens: 50, allowanceUsd: 7.5 });
  });

  it('keeps the session id stable across turns and distinct between conversations', async () => {
    const server = await start({ content: 'ok' });
    const send = async (sessionId: string, system: string): Promise<void> => {
      await provider.chat(context(server), {
        model: 'opencode-go-heavy',
        sessionId,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: 'turn' },
        ],
      });
    };

    await send('session-alpha', 'conversation alpha');
    await send('session-alpha', 'conversation alpha');
    await send('session-beta', 'conversation beta');

    const sessions = server.requests.map((request) => request.headers['x-opencode-session']);
    expect(sessions).toEqual(['session-alpha', 'session-alpha', 'session-beta']);
    // The server rejects a rotated session with 400, so reaching this line proves stability was accepted.
    expect(server.requests).toHaveLength(3);
  });

  it('sends the configured client headers, with the contract headers winning over extras', async () => {
    const server = await start({ content: 'headers' });
    const responder = await provider.chat(
      context(server, {
        userAgent: 'agent-tasks/0.1.0 (opencode-go tests)',
        headers: { 'x-client-name': 'agent-tasks-tests', 'user-agent': 'agent-tasks/custom (tests)' },
      }),
      {
        model: 'opencode-go-heavy',
        sessionId: 'conv-headers',
        messages: [
          { role: 'system', content: 'system prompt for headers' },
          { role: 'user', content: 'hi' },
        ],
      },
    );
    expect(responder.content).toBe('headers');

    const request = lastRequest(server);
    // OpenCode Go requires the tool's own agent string; an extra header cannot spoof it.
    expect(request.headers['user-agent']).toBe('agent-tasks/0.1.0 (opencode-go tests)');
    expect(request.headers['x-client-name']).toBe('agent-tasks-tests');
    expect(request.headers.authorization).toBe('Bearer sk-opencode-go-test');
    expect(request.headers['x-opencode-session']).toBe('conv-headers');

    const anonymous = context(server);
    await provider.chat({ config: anonymous.config }, {
      model: 'opencode-go-heavy',
      sessionId: 'conv-headers-anonymous',
      messages: [
        { role: 'system', content: 'system prompt for headers without key' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(lastRequest(server).headers.authorization).toBeUndefined();
  });
  it('sends both official contract headers on chat, model discovery and health', async () => {
    const server = await start({ content: 'contract' });
    const ctx = context(server);
    await provider.listModels(ctx);
    await provider.health(ctx);
    await provider.chat(ctx, {
      model: 'opencode-go-heavy',
      sessionId: 'conv-contract',
      messages: [
        { role: 'system', content: 'contract conversation' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(server.requests.map((request) => request.path)).toEqual(['/v1/models', '/v1/models', '/v1/chat/completions']);
    for (const request of server.requests) {
      const userAgent = String(request.headers['user-agent'] ?? '').toLowerCase();
      expect(userAgent).not.toBe('');
      for (const generic of ['node', 'undici', 'axios', 'openai-node', 'python-requests', 'okhttp', 'curl', 'wget', 'go-http-client', 'node-fetch']) {
        expect(userAgent.startsWith(generic), `${request.path} sent generic UA ${userAgent}`).toBe(false);
      }
      const session = request.headers['x-opencode-session'];
      expect(typeof session, `${request.path} is missing x-opencode-session`).toBe('string');
      expect(String(session).length).toBeGreaterThan(0);
    }
    expect(lastRequest(server).headers['x-opencode-session']).toBe('conv-contract');
  });

  it('never lets extra headers replace the contract user agent or session id', async () => {
    const server = await start({ content: 'spoof' });
    await provider.chat(
      context(server, { headers: { 'user-agent': 'undici', 'x-opencode-session': 'spoofed-session' } }),
      {
        model: 'opencode-go-heavy',
        sessionId: 'conv-real-session',
        messages: [
          { role: 'system', content: 'spoof conversation' },
          { role: 'user', content: 'hi' },
        ],
      },
    );
    const request = lastRequest(server);
    expect(request.headers['user-agent']).toBe('agent-tasks/0.1.0 (opencode-go tests)');
    expect(request.headers['x-opencode-session']).toBe('conv-real-session');
  });

  it('maps a model#variant suffix to reasoning_effort', async () => {
    const server = await start({ content: 'variant' });
    const responder = await provider.chat(context(server), {
      model: 'opencode-go-heavy#high',
      sessionId: 'conv-variant',
      messages: [
        { role: 'system', content: 'variant conversation' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(responder.content).toBe('variant');
    const request = lastRequest(server);
    expect(request.body?.model).toBe('opencode-go-heavy');
    expect(request.body?.reasoning_effort).toBe('high');
  });

  it('rejects an unknown model variant before sending a request', async () => {
    const server = await start({ content: 'never' });
    await expect(
      provider.chat(context(server), {
        model: 'opencode-go-heavy#turbo',
        sessionId: 'conv-bad-variant',
        messages: [
          { role: 'system', content: 'bad variant' },
          { role: 'user', content: 'hi' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(server.requests).toHaveLength(0);
  });

  it('refuses to build headers without a session id', () => {
    expect(() => buildHeaders({ stream: true, userAgent: 'agent-tasks/0.1.0', sessionHeader: 'x-opencode-session', headers: {} }, undefined, '')).toThrow(/session id/i);
    expect(() => buildHeaders({ stream: true, userAgent: 'agent-tasks/0.1.0', sessionHeader: 'x-opencode-session', headers: {} }, undefined, '   ')).toThrow(/session id/i);
  });

  it('rejects contract violations at the endpoint itself', async () => {
    const server = await start({ content: 'guard' });
    const body = JSON.stringify({
      model: 'opencode-go-heavy',
      stream: false,
      messages: [
        { role: 'system', content: 'guard conversation' },
        { role: 'user', content: 'hi' },
      ],
    });
    const post = async (headers: Record<string, string>): Promise<Response> =>
      fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });

    const generic = await post({ 'user-agent': 'undici', 'x-opencode-session': 'session-guard' });
    expect(generic.status).toBe(400);
    await generic.text();

    const missingSession = await post({ 'user-agent': 'agent-tasks/tests' });
    expect(missingSession.status).toBe(400);
    await missingSession.text();

    const first = await post({ 'user-agent': 'agent-tasks/tests', 'x-opencode-session': 'session-guard' });
    expect(first.status).toBe(200);
    await first.text();

    const rotated = await post({ 'user-agent': 'agent-tasks/tests', 'x-opencode-session': 'session-other' });
    expect(rotated.status).toBe(400);
    expect(await rotated.text()).toContain('session id changed');
    expect(server.requests).toHaveLength(4);
  });
});

describe('OpenCode Go error mapping', () => {
  it('maps 401 to auth', async () => {
    const server = await start({ failure: 'unauthorized' });
    const error = await rejection(
      provider.chat(context(server), {
        model: 'opencode-go-heavy',
        sessionId: 'conv-401',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(error.code).toBe('auth');
    expect(error.status).toBe(401);
  });

  it('maps 429 to rate_limited and reports retry-after seconds', async () => {
    const server = await start({ failure: 'rate_limited', retryAfterSeconds: 17 });
    const error = await rejection(
      provider.chat(context(server), {
        model: 'opencode-go-heavy',
        sessionId: 'conv-429',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.message).toContain('retry after 17s');
  });

  it('maps an exhausted balance (402) to auth with an explicit message', async () => {
    const server = await start({ failure: 'insufficient_balance', insufficientBalanceStatus: 402 });
    const error = await rejection(
      provider.chat(context(server), {
        model: 'opencode-go-heavy',
        sessionId: 'conv-402',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(error.code).toBe('auth');
    expect(error.status).toBe(402);
    expect(error.message).toMatch(/insufficient balance/i);
  });

  it('maps a 403 insufficient-balance body to auth with an explicit message', async () => {
    const server = await start({ failure: 'insufficient_balance', insufficientBalanceStatus: 403 });
    const error = await rejection(
      provider.chat(context(server), {
        model: 'opencode-go-heavy',
        sessionId: 'conv-403',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(error.code).toBe('auth');
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/insufficient balance/i);
  });

  it('maps 5xx to unavailable', async () => {
    const server = await start({ failure: 'server_error' });
    const error = await rejection(
      provider.chat(context(server), {
        model: 'opencode-go-heavy',
        sessionId: 'conv-500',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(error.code).toBe('unavailable');
    expect(error.status).toBe(500);
  });

  it('maps malformed JSON in a non-streaming response to bad_response', async () => {
    const server = await start({ failure: 'malformed_json' });
    const error = await rejection(
      provider.chat(context(server, { stream: false }), {
        model: 'opencode-go-heavy',
        sessionId: 'conv-bad-json',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(error.code).toBe('bad_response');
  });

  it('maps a malformed SSE event to bad_response', async () => {
    const server = await start({ failure: 'malformed_json' });
    const error = await rejection(
      provider.chat(context(server), {
        model: 'opencode-go-heavy',
        sessionId: 'conv-bad-sse',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(error.code).toBe('bad_response');
    expect(error.message).toMatch(/malformed stream event/);
  });

  it('maps a truncated SSE body to bad_response without leaking a TypeError', async () => {
    const server = await start({ failure: 'truncated_stream', content: 'a long answer that never finishes' });
    const error = await rejection(
      provider.chat(context(server), {
        model: 'opencode-go-heavy',
        sessionId: 'conv-truncated',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(error.code).toBe('bad_response');
    expect(error.message).toMatch(/stream/);
  });

  it('aborts mid-stream promptly with a typed timeout error', async () => {
    const server = await start({
      content: 'one two three four five six seven eight nine ten eleven twelve',
      streamDelayMs: 25,
    });
    const controller = new AbortController();
    const started = Date.now();
    const pending = provider.chat(context(server), {
      model: 'opencode-go-heavy',
      sessionId: 'conv-abort',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 40);
    const error = await rejection(pending);
    clearTimeout(timer);

    expect(error.code).toBe('timeout');
    expect(error.message).toMatch(/abort/i);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('OpenCode Go URL and discovery contract', () => {
  it('normalises base urls with and without /v1 and accepts a full completions url', async () => {
    const server = await start({ content: 'normalised' });
    const cases: Array<{ baseUrl: string; path: string }> = [
      { baseUrl: server.url, path: '/chat/completions' },
      { baseUrl: `${server.url}/v1`, path: '/v1/chat/completions' },
      { baseUrl: `${server.url}/v1/`, path: '/v1/chat/completions' },
      { baseUrl: `${server.url}/v1/chat/completions`, path: '/v1/chat/completions' },
    ];

    for (const [index, testCase] of cases.entries()) {
      const response = await provider.chat(context(server, { baseUrl: testCase.baseUrl }), {
        model: 'opencode-go-heavy',
        sessionId: `conv-url-${index}`,
        messages: [
          { role: 'system', content: `url case ${index}` },
          { role: 'user', content: 'hi' },
        ],
      });
      expect(response.content).toBe('normalised');
      expect(lastRequest(server).path).toBe(testCase.path);
    }

    expect(chatCompletionsUrl('http://localhost:9000')).toBe('http://localhost:9000/chat/completions');
    expect(modelsUrl('http://localhost:9000/v1/chat/completions')).toBe('http://localhost:9000/v1/models');
    expect(modelsUrl(`${server.url}/v1/`)).toBe(`${server.url}/v1/models`);
  });

  it('discovers models and refuses to assume tool support for undeclared ids', async () => {
    const server = await start();
    const models = await provider.listModels(
      context(server, { models: [{ id: 'opencode-go-heavy', label: 'Go Heavy', supportsTools: true }] }),
    );

    expect(models).toEqual([
      { id: 'opencode-go-heavy', label: 'Go Heavy', supportsTools: true, contextLength: undefined },
      { id: 'opencode-go-light', label: 'opencode-go-light', supportsTools: false, contextLength: undefined },
    ]);
    expect(lastRequest(server).path).toBe('/v1/models');
  });

  it('falls back to the configured models when /models returns 404', async () => {
    const server = await start({ models: 'not_found' });
    const models = await provider.listModels(
      context(server, { models: [{ id: 'declared-model', label: 'Declared', supportsTools: true, contextLength: 128_000 }] }),
    );

    expect(models).toEqual([{ id: 'declared-model', label: 'Declared', supportsTools: true, contextLength: 128_000 }]);
  });

  it('reports unavailable when /models is missing and nothing is declared', async () => {
    const server = await start({ models: 'not_found' });
    const error = await rejection(provider.listModels(context(server)));
    expect(error.code).toBe('unavailable');
    expect(error.status).toBe(404);
  });

  it('builds the contract headers directly', () => {
    const headers = buildHeaders(
      {
        headers: { 'x-extra': '1', 'user-agent': 'custom-client/9.0' },
        userAgent: 'agent-tasks/0.1.0',
        sessionHeader: 'x-opencode-session',
        stream: true,
      },
      'sk-direct',
      'session-direct',
    );

    // The official client identity comes from `userAgent`; extra headers cannot spoof it.
    expect(headers['user-agent']).toBe('agent-tasks/0.1.0');
    expect(headers.accept).toBe('text/event-stream');
    expect(headers['x-extra']).toBe('1');
    expect(headers['x-opencode-session']).toBe('session-direct');
    expect(headers.authorization).toBe('Bearer sk-direct');
  });
});
