import { describe, expect, it, vi } from 'vitest';
import { HttpOpenCodeProvisioner } from '../src/http-opencode-provisioner.js';

describe('HTTP OpenCode provisioner client', () => {
  it('sends owner-scoped runtime credentials only to the authenticated internal service', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        baseUrl: 'http://opencode-provisioner:4090/v1/runtime/123e4567-e89b-42d3-a456-426614174000/',
        password: 'p'.repeat(64), directory: '/workspace', model: { providerID: 'agent_tasks', id: 'model' },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'ses_test' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ released: true })));
    const provisioner = new HttpOpenCodeProvisioner('http://opencode-provisioner:4090', 't'.repeat(64), fetchMock);
    const runtime = await provisioner.open({
      lease: { executionId: '123e4567-e89b-42d3-a456-426614174000', ownerId: '123e4567-e89b-42d3-a456-426614174001', workerId: 'worker' },
      providerKind: 'openai-compatible', providerContext: { apiKey: 'owner-key', config: { baseUrl: 'https://llm.example/v1' } },
      model: 'model', systemPrompt: 'task policy', maxAgentSteps: 8, maxOutputBytes: 8192,
      toolBridge: { token: 'bridge-token', tools: ['compose_email'] },
    } as never);
    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/v1/runtimes/open');
    expect(new Headers(request.headers).get('authorization')).toBe(`Bearer ${'t'.repeat(64)}`);
    expect(JSON.parse(String(request.body))).toMatchObject({ apiKey: 'owner-key', provider: { baseUrl: 'https://llm.example/v1' }, systemPrompt: 'task policy', maxAgentSteps: 8, maxOutputBytes: 8192 });
    expect(JSON.parse(String(request.body)).providerKind).toBe('openai-compatible');
    expect(JSON.parse(String(request.body)).model).toEqual({ id: 'model' });
    expect(JSON.parse(String(request.body)).toolBridge).toEqual({ token: 'bridge-token', tools: ['compose_email'] });
    expect(runtime.directory).toBe('/workspace');
    await runtime.client.createSession({ directory: runtime.directory });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('x-provisioner-token')).toBe('t'.repeat(64));
    await runtime.release();
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('x-runtime-password')).toBe('p'.repeat(64));
  });

  it('rejects non-compatible providers and hides provisioning response details', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret response', { status: 500 }));
    const provisioner = new HttpOpenCodeProvisioner('http://opencode-provisioner:4090', 't'.repeat(64), fetchMock);
    const input = { lease: { executionId: 'id', ownerId: 'owner', workerId: 'worker' }, providerContext: { apiKey: 'secret', config: {} }, model: 'model' } as never;
    await expect(provisioner.open({ ...input, providerKind: 'codex' })).rejects.toThrow('only OpenAI-compatible');
    await expect(provisioner.open({ ...input, providerKind: 'openai-compatible' })).rejects.not.toThrow('secret');
  });
});
