import { afterEach, describe, expect, it } from 'vitest';
import { createToolBridgeHub, startToolBridge } from '../src/opencode-tool-bridge.js';
import type { ToolBridge, ToolBridgeHub } from '../src/opencode-tool-bridge.js';

let bridge: ToolBridge | undefined;
let hub: ToolBridgeHub | undefined;

afterEach(async () => {
  await bridge?.close();
  await hub?.close();
  bridge = undefined;
  hub = undefined;
});

async function rpc(target: ToolBridge, body: unknown, token = target.token): Promise<unknown> {
  const response = await fetch(target.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const text = await response.text();
  const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
  return JSON.parse(data);
}

describe('OpenCode tool bridge', () => {
  it('rejects requests without the per-execution token', async () => {
    bridge = await startToolBridge({ token: 'secret-token', port: 0 });
    expect((await fetch(bridge.url, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(bridge.url, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401);
  });

  it('answers initialize and lists only the allowlisted tools', async () => {
    bridge = await startToolBridge({ token: 'secret-token', port: 0 });
    const init = await rpc(bridge, { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) as { result: { capabilities: unknown; serverInfo: { name: string } } };
    expect(init.result.capabilities).toEqual({ tools: {} });
    expect(init.result.serverInfo.name).toBe('agent-tasks-tools');

    const list = await rpc(bridge, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((tool) => tool.name).sort()).toEqual(['add_email_block', 'compose_email']);
  });

  it('captures validated e-mail blocks from compose_email', async () => {
    bridge = await startToolBridge({ token: 'secret-token', port: 0 });
    const reply = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'compose_email', arguments: { dsl: '# Report\n\nAll good.' } },
    }) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(reply.result.isError).toBe(false);
    expect(reply.result.content[0]?.text).toContain('Composed 2 email block');
    expect(bridge.emailBlocks.map((block) => block.type)).toEqual(['heading', 'paragraph']);
  });

  it('rejects tools outside the allowlist and malformed arguments', async () => {
    bridge = await startToolBridge({ token: 'secret-token', port: 0 });
    const denied = await rpc(bridge, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_web', arguments: {} },
    }) as { result: { isError: boolean } };
    expect(denied.result.isError).toBe(true);

    const invalid = await rpc(bridge, {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'compose_email', arguments: { dsl: '![x](javascript:alert(1))' } },
    }) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(invalid.result.isError).toBe(true);
    expect(invalid.result.content[0]?.text).toContain('invalid');
    expect(bridge.emailBlocks).toHaveLength(0);
  });

  it('enforces the per-execution tool-call budget', async () => {
    bridge = await startToolBridge({ token: 'secret-token', port: 0, maxCalls: 1 });
    const call = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'compose_email', arguments: { dsl: 'hello' } } };
    const first = await rpc(bridge, call) as { result: { isError: boolean } };
    const second = await rpc(bridge, call) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(first.result.isError).toBe(false);
    expect(second.result.isError).toBe(true);
    expect(second.result.content[0]?.text).toContain('budget exhausted');
    expect(bridge.calls).toBe(1);
  });

  it('isolates concurrent sessions by token', async () => {
    hub = await createToolBridgeHub({ port: 0 });
    const alice = hub.open({ tools: ['compose_email'] });
    const bob = hub.open({ tools: ['add_email_block'] });
    expect(alice.token).not.toBe(bob.token);

    const target = { url: hub.url, token: alice.token } as unknown as ToolBridge;
    const aliceList = await rpc(target, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    expect(aliceList.result.tools.map((tool) => tool.name)).toEqual(['compose_email']);

    const cross = await rpc(target, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_email_block', arguments: { type: 'paragraph', text: 'x' } } }) as { result: { isError: boolean } };
    expect(cross.result.isError).toBe(true);

    const bobTarget = { url: hub.url, token: bob.token } as unknown as ToolBridge;
    await rpc(bobTarget, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_email_block', arguments: { type: 'paragraph', text: 'x' } } });
    expect(alice.emailBlocks).toHaveLength(0);
    expect(bob.emailBlocks).toHaveLength(1);
  });

  it('serves an SSE stream for the MCP GET handshake', async () => {
    bridge = await startToolBridge({ token: 'secret-token', port: 0 });
    const controller = new AbortController();
    const response = await fetch(bridge.url, {
      headers: { authorization: `Bearer ${bridge.token}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });
});
