import { describe, expect, it } from 'vitest';
import { createMockOpenAiServer } from '../src/index';

describe('mock OpenAI server transport', () => {
  it('advertises the configured origin instead of the bind address', async () => {
    const server = await createMockOpenAiServer({ publicOrigin: 'http://192.0.2.10:18099/' });
    try {
      expect(server.url).toBe('http://192.0.2.10:18099/v1');
    } finally {
      await server.close();
    }
  });

  it('listens on the requested port and answers on all interfaces', async () => {
    const server = await createMockOpenAiServer({ port: 0 });
    try {
      const origin = new URL(server.url).origin;
      const response = await fetch(`${origin}/v1/models`, {
        headers: { 'user-agent': 'agent-tasks-test/1.0', 'x-opencode-session': 'session-1' },
      });
      expect(response.ok).toBe(true);
      const payload = (await response.json()) as { data: Array<{ id: string }> };
      expect(payload.data.map((model) => model.id)).toContain('mock-researcher');
    } finally {
      await server.close();
    }
  });
});
