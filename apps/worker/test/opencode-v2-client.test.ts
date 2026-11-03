import { describe, expect, it, vi } from 'vitest';
import { OpenCodeV2Client, OpenCodeV2Error } from '../src/opencode-v2-client.js';

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

describe('OpenCode V2 HTTP adapter spike', () => {
  it('creates a location-scoped session with model and restrictive permissions', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ data: { id: 'ses_1' } }));
    const client = new OpenCodeV2Client({ baseUrl: 'http://opencode.test/', password: 'secret', fetch: fetchMock });
    await expect(client.createSession({ directory: '/workspace', model: { providerID: 'openai', id: 'gpt-test' } })).resolves.toEqual({ id: 'ses_1' });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/session');
    expect(new Headers(init.headers).get('authorization')).toBe(`Basic ${btoa('opencode:secret')}`);
    expect(JSON.parse(String(init.body))).toEqual({
      location: { directory: '/workspace' },
      model: { providerID: 'openai', id: 'gpt-test' },
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
      ],
    });
  });

  it('sends stable caller IDs and keeps server details out of errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ data: { id: 'msg_abc' } }));
    const client = new OpenCodeV2Client({ baseUrl: 'http://opencode.test', password: 'never-leak', fetch: fetchMock });
    await client.prompt('ses_1', 'msg_abc', 'hello');
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ id: 'msg_abc', text: 'hello' });
    fetchMock.mockResolvedValueOnce(response({ error: { message: 'secret never-leak' } }, 500));
    await expect(client.getSession('ses_1')).rejects.toMatchObject({ status: 500 });
    await expect(client.getSession('ses_1')).rejects.not.toThrow('never-leak');
    await expect(client.prompt('ses_1', 'wrong-id', 'hello')).rejects.toThrow('must start with msg_');
  });

  it('supports session, context, messages, and interrupt paths', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => response({ data: [] }));
    const client = new OpenCodeV2Client({ baseUrl: 'http://opencode.test', password: 'secret', fetch: fetchMock });
    await client.getSession('ses/a');
    await client.getContext('ses/a');
    await client.getMessages('ses/a');
    await client.interrupt('ses/a');
    expect(fetchMock.mock.calls.map(([url, init]) => `${(url as URL).pathname}:${(init as RequestInit).method ?? 'GET'}`)).toEqual([
      '/api/session/ses%2Fa:GET', '/api/session/ses%2Fa/context:GET', '/api/session/ses%2Fa/message:GET', '/api/session/ses%2Fa/interrupt:POST',
    ]);
  });

  it('propagates cancellation to prompt and message requests', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.signal?.aborted) throw new Error('aborted');
      return response({ data: [] });
    });
    const client = new OpenCodeV2Client({ baseUrl: 'http://opencode.test', password: 'secret', fetch: fetchMock });
    const controller = new AbortController();
    await client.prompt('ses_1', 'msg_1', 'hello', controller.signal);
    await client.getMessages('ses_1', controller.signal);
    expect(fetchMock.mock.calls.map(([, init]) => init?.signal)).toEqual([controller.signal, controller.signal]);
    controller.abort();
    await expect(client.getMessages('ses_1', controller.signal)).rejects.toBeInstanceOf(OpenCodeV2Error);
  });

  it('streams only matching session events and ignores malformed frames', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: nope\n\n',
          'data: {"type":"session.text.delta","data":{"sessionID":"ses_other"}}\n\n',
          'data: {"type":"session.execution.succeeded","data":{"sessionID":"ses_1"}}\n\n',
        ].join('')));
        controller.close();
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const client = new OpenCodeV2Client({ baseUrl: 'http://opencode.test', password: 'secret', fetch: fetchMock });
    const collected = [];
    for await (const event of client.events('ses_1')) collected.push(event.type);
    expect(collected).toEqual(['session.execution.succeeded']);
    expect((fetchMock.mock.calls[0]?.[0] as URL).pathname).toBe('/api/event');
    expect((fetchMock.mock.calls[0]?.[0] as URL).searchParams.getAll('types')).toContain('session.status');
  });

  it('does not surface network or response secrets', async () => {
    const client = new OpenCodeV2Client({ baseUrl: 'http://opencode.test', password: 'secret', fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('secret')) });
    await expect(client.getSession('ses_1')).rejects.toBeInstanceOf(OpenCodeV2Error);
    await expect(client.getSession('ses_1')).rejects.not.toThrow('secret');
  });
});
