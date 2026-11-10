/* global Bun, Response, TextDecoder */
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OpenCode } from '@opencode/sdk';

const PORT = 4096;
const MAX_REQUEST_BYTES = 1_000_000;
const DIRECTORY = '/workspace';

function authorized(request, password) {
  const supplied = request.headers.get('authorization') ?? '';
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new Response(JSON.stringify({ error: { message: 'Request too large' } }), {
      status: 413,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Response(JSON.stringify({ error: { message: 'Request too large' } }), {
          status: 413,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
      status: 400,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function routeError(error) {
  if (error instanceof Response) return error;
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : 500;
  return json({ error: { message: 'OpenCode request failed' } }, status);
}

export function createRuntimeHandler({ host, password, directory = DIRECTORY }) {
  if (typeof password !== 'string' || password.length < 32) throw new Error('Runtime password is required');
  return async (request) => {
    if (!authorized(request, password)) return json({ error: { message: 'Unauthorized' } }, 401);
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'GET' && path === '/healthz') return json({ ok: true });
    if (request.method === 'POST' && path === '/api/session') {
      try {
        const body = await readJson(request);
        if (body?.location?.directory !== directory) return json({ error: { message: 'Invalid session location' } }, 400);
        return json({ data: await host.sessions.create(body) });
      } catch (error) {
        return routeError(error);
      }
    }
    const prompt = /^\/api\/session\/([A-Za-z0-9_-]+)\/prompt$/.exec(path);
    if (request.method === 'POST' && prompt) {
      try {
        const body = await readJson(request);
        return json({ data: await host.sessions.prompt({ ...body, sessionID: prompt[1] }) });
      } catch (error) {
        return routeError(error);
      }
    }
    const interrupt = /^\/api\/session\/([A-Za-z0-9_-]+)\/interrupt$/.exec(path);
    if (request.method === 'POST' && interrupt) {
      try {
        return json({ data: await host.sessions.interrupt({ sessionID: interrupt[1] }) });
      } catch (error) {
        return routeError(error);
      }
    }
    const messages = /^\/api\/session\/([A-Za-z0-9_-]+)\/message$/.exec(path);
    if (request.method === 'GET' && messages) {
      try {
        return json(await host.message.list({ sessionID: messages[1] }));
      } catch (error) {
        return routeError(error);
      }
    }
    if (request.method === 'GET' && path === '/api/mcp') {
      try {
        const status = await host.mcp.list({ location: { directory } });
        return json({ data: status.data });
      } catch (error) {
        return routeError(error);
      }
    }
    return json({ error: { message: 'Not found' } }, 404);
  };
}

export async function connectConfiguredMcp(host, config, directory = DIRECTORY) {
  const servers = config?.mcp?.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  const location = { directory };
  for (const [server, serverConfig] of Object.entries(servers)) {
    if (!serverConfig || typeof serverConfig !== 'object' || serverConfig.disabled === true) continue;
    await host.mcp.add({ server, location, config: serverConfig });
    try {
      await host.mcp.connect({ server, location });
    } catch {
      // Keep the runtime available so the worker can observe a failed MCP state
      // and apply its existing connection timeout/recovery behavior.
      console.error(JSON.stringify({ event: 'opencode_sdk_mcp_connect_failed' }));
    }
  }
}

async function start() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (typeof password !== 'string' || password.length < 32) throw new Error('OPENCODE_SERVER_PASSWORD is required');
  const config = JSON.parse(await readFile('/etc/opencode/opencode.json', 'utf8'));
  const host = await OpenCode.create({
    config: { directory: '/etc/opencode' },
    database: { path: '/home/opencode/.local/share/opencode/opencode.db' },
  });
  await connectConfiguredMcp(host, config);
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: PORT,
    fetch: createRuntimeHandler({ host, password }),
  });
  console.log(JSON.stringify({ event: 'opencode_sdk_runtime_ready', port: server.port }));
  const shutdown = async () => {
    server.stop(true);
    await host.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

if (import.meta.main) await start();
