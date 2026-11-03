import { AgentCancelledError } from '@agent-tasks/agent-runtime';
import type { IsolatedOpenCodeProvisioner } from './opencode-isolated-runtime.js';
import { OpenCodeV2Client } from './opencode-v2-client.js';

interface RuntimeResponse {
  baseUrl: string;
  password: string;
  directory: string;
  model: { providerID: string; id: string };
}

/** Authenticated worker client for the isolated runtime service; never logs request data. */
export class HttpOpenCodeProvisioner implements IsolatedOpenCodeProvisioner {
  private readonly baseUrl: URL;

  constructor(baseUrl: string, private readonly token: string, private readonly requestFetch: typeof fetch = fetch) {
    this.baseUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol)) throw new Error('Invalid OpenCode provisioner URL');
    if (token.length < 32) throw new Error('OpenCode provisioner token must contain at least 32 characters');
  }

  async open(input: Parameters<IsolatedOpenCodeProvisioner['open']>[0]): Promise<Awaited<ReturnType<IsolatedOpenCodeProvisioner['open']>>> {
    if (input.providerKind !== 'openai-compatible') throw new Error('Isolated OpenCode currently supports only OpenAI-compatible providers');
    if (input.signal?.aborted) throw new AgentCancelledError('cancelled');
    let response: Response;
    try {
      response = await this.requestFetch(new URL('/v1/runtimes/open', this.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          lease: input.lease,
          providerKind: input.providerKind,
          model: { id: input.model },
          provider: input.providerContext.config,
          apiKey: input.providerContext.apiKey,
          systemPrompt: input.systemPrompt,
          maxAgentSteps: input.maxAgentSteps,
          maxOutputBytes: input.maxOutputBytes,
          ...(input.toolBridge ? { toolBridge: input.toolBridge } : {}),
        }),
        signal: input.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      if (input.signal?.aborted) throw new AgentCancelledError('cancelled');
      throw new Error('OpenCode provisioner unavailable');
    }
    if (!response.ok) throw new Error(`OpenCode provisioner rejected runtime request (${response.status})`);
    let result: RuntimeResponse;
    try {
      result = await response.json() as RuntimeResponse;
    } catch {
      throw new Error('Invalid OpenCode provisioner response');
    }
    const runtimeUrl = new URL(result.baseUrl);
    if (runtimeUrl.origin !== this.baseUrl.origin || !runtimeUrl.pathname.startsWith('/v1/runtime/')) {
      throw new Error('Invalid OpenCode runtime endpoint');
    }
    if (typeof result.password !== 'string' || result.password.length < 32 || typeof result.directory !== 'string'
      || !result.model || typeof result.model.providerID !== 'string' || typeof result.model.id !== 'string') {
      throw new Error('Invalid OpenCode provisioner response');
    }
    return {
      client: new OpenCodeV2Client({
        baseUrl: result.baseUrl,
        password: result.password,
        headers: { 'x-provisioner-token': this.token },
        fetch: this.requestFetch,
      }),
      directory: result.directory,
      model: result.model,
      // Stop the credential-bearing process but retain private session data for
      // worker recovery. The provisioner eventually removes inactive resources.
      release: async () => {
        try {
          await this.requestFetch(new URL('release', result.baseUrl), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.token}`,
              'x-provisioner-token': this.token,
              // Server password is an HMAC-derived per-execution capability.
              'x-runtime-password': result.password,
            },
            signal: AbortSignal.timeout(5_000),
          });
        } catch {
          // Best effort only; the service's TTL sweep is the final cleanup gate.
        }
      },
    };
  }
}
