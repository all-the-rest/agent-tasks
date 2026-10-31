import { browserActionSchema, browserResultSchema } from './actions.js';
import type { BrowserAction, BrowserResult } from './actions.js';

export class BrowserRunnerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BrowserRunnerError';
  }
}

export interface BrowserRunnerClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

/**
 * Thin client for the isolated browser service. The service owns Chromium and the
 * egress proxy; this client never launches a browser in the API or worker process.
 */
export class BrowserRunnerClient {
  constructor(private readonly options: BrowserRunnerClientOptions) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-runner-token': this.options.token };
  }

  private async call<T>(path: string, init: RequestInit, schema: { parse(value: unknown): T }): Promise<T> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    }).catch((error: Error) => {
      throw new BrowserRunnerError(`browser runner unreachable: ${error.message}`);
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new BrowserRunnerError(`browser runner HTTP ${response.status}: ${body.slice(0, 200)}`, response.status);
    }
    return schema.parse(await response.json());
  }

  async createSession(): Promise<{ sessionId: string }> {
    return this.call('/v1/sessions', { method: 'POST', body: '{}' }, { parse: (value) => value as { sessionId: string } });
  }

  async act(sessionId: string, action: BrowserAction): Promise<BrowserResult> {
    const parsed = browserActionSchema.parse(action);
    return this.call(
      `/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
      { method: 'POST', body: JSON.stringify(parsed) },
      browserResultSchema,
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      // No content-type: Fastify rejects a JSON content type without a body (400),
      // which used to leave browser sessions open until the TTL expired.
      headers: { 'x-runner-token': this.options.token },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
  }
}
