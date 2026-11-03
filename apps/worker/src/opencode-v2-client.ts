/** HTTP client for the isolated OpenCode V2 runtime. It does not enforce Agent
 * Tasks' per-run limits; V2 only provides a configured agent step cap, not
 * per-session controls for duration, tool calls, browser visits, search requests,
 * or output.
 */
export interface OpenCodeV2ClientOptions {
  baseUrl: string;
  password: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface OpenCodeV2Model {
  providerID: string;
  id: string;
  variant?: string;
}

export interface OpenCodeV2Session {
  id: string;
  [key: string]: unknown;
}

export interface OpenCodeV2Event {
  type: string;
  [key: string]: unknown;
}

export class OpenCodeV2Error extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'OpenCodeV2Error';
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeEvent(data: string): OpenCodeV2Event | undefined {
  try {
    const value = object(JSON.parse(data));
    if (!value) return undefined;
    // Native stream events may be wrapped in a `payload` envelope.
    const event = object(value.payload) ?? value;
    return typeof event.type === 'string' ? (event as OpenCodeV2Event) : undefined;
  } catch {
    return undefined;
  }
}

export class OpenCodeV2Client {
  private readonly baseUrl: URL;
  private readonly requestFetch: typeof fetch;
  private readonly authorization: string;
  private readonly headers: Record<string, string>;

  constructor(options: OpenCodeV2ClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.baseUrl.pathname = `${this.baseUrl.pathname.replace(/\/+$/, '')}/`;
    this.requestFetch = options.fetch ?? fetch;
    this.headers = options.headers ?? {};
    // The V2 service accepts Basic auth with an arbitrary username and the
    // configured password. Never include credentials in thrown errors.
    this.authorization = `Basic ${btoa(`opencode:${options.password}`)}`;
  }

  async createSession(input: { directory: string; model?: OpenCodeV2Model }, signal?: AbortSignal): Promise<OpenCodeV2Session> {
    // Do not send session-level permissions: an unconditional deny here
    // overrides the agent's explicit MCP tool allow and hides every tool.
    // The provider-side agent config is the single permission boundary.
    const body: Record<string, unknown> = {
      location: { directory: input.directory },
    };
    if (input.model) body.model = input.model;
    const response = await this.json('api/session', { method: 'POST', body: JSON.stringify(body), signal });
    const data = object(response)?.data;
    const session = object(data);
    if (!session || typeof session.id !== 'string') throw new OpenCodeV2Error(200, 'Invalid session response');
    return session as OpenCodeV2Session;
  }

  async prompt(sessionId: string, messageId: string, text: string, signal?: AbortSignal): Promise<unknown> {
    if (!messageId.startsWith('msg_')) throw new Error('Message ID must start with msg_');
    return this.json(`api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ id: messageId, text }),
      signal,
    });
  }

  async getSession(sessionId: string): Promise<unknown> {
    return this.json(`api/session/${encodeURIComponent(sessionId)}`);
  }

  async getContext(sessionId: string): Promise<unknown> {
    return this.json(`api/session/${encodeURIComponent(sessionId)}/context`);
  }

  async getMessages(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.json(`api/session/${encodeURIComponent(sessionId)}/message`, { signal });
  }

  /** Global MCP connection state; used to wait before the first prompt. */
  async getMcpStatus(signal?: AbortSignal): Promise<unknown> {
    return this.json('api/mcp', { signal });
  }

  async interrupt(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.json(`api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST', signal });
  }

  /** Live-only SSE subscription; callers must resync after disconnects. */
  async *events(sessionId: string, signal?: AbortSignal): AsyncGenerator<OpenCodeV2Event> {
    const eventUrl = this.url('api/event');
    for (const type of ['session.status', 'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']) {
      eventUrl.searchParams.append('types', type);
    }
    const response = await this.requestFetch(eventUrl, {
      headers: { ...this.headers, authorization: this.authorization, accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) throw new OpenCodeV2Error(response.status, 'Unable to subscribe to OpenCode events');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
          const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          const event = data ? decodeEvent(data) : undefined;
          const eventSession = object(event?.data)?.sessionID;
          if (event && (eventSession === sessionId || event.type === 'server.connected')) yield event;
          boundary = buffer.search(/\r?\n\r?\n/);
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private url(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.requestFetch(this.url(path), {
        ...init,
        headers: { ...this.headers, authorization: this.authorization, 'content-type': 'application/json', ...init.headers },
      });
    } catch {
      throw new OpenCodeV2Error(0, 'OpenCode request failed');
    }
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      throw new OpenCodeV2Error(response.status, 'Unable to read OpenCode response');
    }
    let body: unknown;
    try { body = bodyText ? JSON.parse(bodyText) : undefined; } catch { body = undefined; }
    if (!response.ok) {
      const error = object(body)?.error;
      const message = object(error)?.message;
      // Server messages can contain request data or credentials: expose only a status.
      throw new OpenCodeV2Error(response.status, typeof message === 'string' ? `OpenCode request rejected (${response.status})` : `OpenCode request failed (${response.status})`);
    }
    return body;
  }
}
