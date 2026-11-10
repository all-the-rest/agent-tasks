/* global Request */
import { describe, expect, it, mock } from 'bun:test';
import { connectConfiguredMcp, createRuntimeHandler } from './host.mjs';

const password = 'p'.repeat(48);
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

function request(path, { method = 'GET', body, auth = authorization } = {}) {
  return new Request(`http://runtime${path}`, {
    method,
    headers: auth ? { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function fakeHost() {
  return {
    sessions: {
      create: mock(async (input) => ({ id: 'ses_123', input })),
      prompt: mock(async (input) => ({ id: input.id })),
      interrupt: mock(async ({ sessionID }) => ({ sessionID })),
    },
    message: { list: mock(async ({ sessionID }) => ({ data: [{ sessionID }], cursor: {} })) },
    mcp: {
      add: mock(async () => undefined),
      connect: mock(async () => undefined),
      list: mock(async () => ({ data: [{ name: 'bridge', status: { status: 'connected' } }] })),
    },
  };
}

describe('SDK runtime HTTP compatibility layer', () => {
  it('requires Basic auth before invoking the SDK', async () => {
    const host = fakeHost();
    const response = await createRuntimeHandler({ host, password })(request('/api/mcp', { auth: '' }));
    expect(response.status).toBe(401);
    expect(host.mcp.list).not.toHaveBeenCalled();
  });

  it('creates sessions only in the execution workspace', async () => {
    const host = fakeHost();
    const handler = createRuntimeHandler({ host, password });
    const invalid = await handler(request('/api/session', { method: 'POST', body: { location: { directory: '/' } } }));
    expect(invalid.status).toBe(400);
    expect(host.sessions.create).not.toHaveBeenCalled();

    const created = await handler(request('/api/session', { method: 'POST', body: { location: { directory: '/workspace' } } }));
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ data: { id: 'ses_123' } });
  });

  it('maps only the existing prompt, interrupt, message, and MCP routes', async () => {
    const host = fakeHost();
    const handler = createRuntimeHandler({ host, password });
    const prompt = await handler(request('/api/session/ses_123/prompt', { method: 'POST', body: { id: 'msg_123', text: 'hello' } }));
    expect(prompt.status).toBe(200);
    expect(host.sessions.prompt).toHaveBeenCalledWith({ sessionID: 'ses_123', id: 'msg_123', text: 'hello' });

    const interrupt = await handler(request('/api/session/ses_123/interrupt', { method: 'POST', body: {} }));
    expect(interrupt.status).toBe(200);
    expect(host.sessions.interrupt).toHaveBeenCalledWith({ sessionID: 'ses_123' });

    const messages = await handler(request('/api/session/ses_123/message'));
    expect(await messages.json()).toMatchObject({ data: [{ sessionID: 'ses_123' }] });

    const mcp = await handler(request('/api/mcp'));
    expect(await mcp.json()).toMatchObject({ data: [{ name: 'bridge', status: { status: 'connected' } }] });
    expect((await handler(request('/api/session/ses_123'))).status).toBe(404);
  });

  it('preserves SDK conflict status for durable prompt-dispatch recovery', async () => {
    const host = fakeHost();
    host.sessions.prompt.mockImplementation(async () => {
      throw Object.assign(new Error('duplicate prompt'), { status: 409 });
    });
    const handler = createRuntimeHandler({ host, password });
    const response = await handler(request('/api/session/ses_123/prompt', { method: 'POST', body: { id: 'msg_123', text: 'hello' } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { message: 'OpenCode request failed' } });
  });

  it('registers configured MCP servers through the SDK and skips disabled entries', async () => {
    const host = fakeHost();
    await connectConfiguredMcp(host, {
      mcp: {
        servers: {
          bridge: { type: 'remote', url: 'http://opencode-provisioner:4090/mcp' },
          disabled: { type: 'remote', url: 'http://unused.invalid/mcp', disabled: true },
        },
      },
    });
    expect(host.mcp.add).toHaveBeenCalledTimes(1);
    expect(host.mcp.add).toHaveBeenCalledWith({
      server: 'bridge',
      location: { directory: '/workspace' },
      config: { type: 'remote', url: 'http://opencode-provisioner:4090/mcp' },
    });
    expect(host.mcp.connect).toHaveBeenCalledWith({ server: 'bridge', location: { directory: '/workspace' } });
  });

  it('reports readiness only through the authenticated health route', async () => {
    const handler = createRuntimeHandler({ host: fakeHost(), password });
    expect((await handler(request('/healthz'))).status).toBe(200);
    expect((await handler(request('/healthz', { auth: '' }))).status).toBe(401);
  });
});
