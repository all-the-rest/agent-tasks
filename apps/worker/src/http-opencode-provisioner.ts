import { AgentCancelledError } from '@agent-tasks/agent-runtime';
import { MODEL_VARIANTS, parseModelVariant } from '@agent-tasks/ai-providers';
import type { ModelVariant } from '@agent-tasks/ai-providers';
import type { IsolatedOpenCodeProvisioner } from './opencode-isolated-runtime.js';
import { OpenCodeV2Client } from './opencode-v2-client.js';

interface RuntimeResponse {
  baseUrl: string;
  password: string;
  directory: string;
  model: { providerID: string; id: string; variant?: string };
}

/** Authenticated worker client for the isolated runtime service; never logs request data. */
export class HttpOpenCodeProvisioner implements IsolatedOpenCodeProvisioner {
  private readonly baseUrl: URL;

  constructor(baseUrl: string, private readonly token: string, private readonly requestFetch: typeof fetch = fetch) {
    this.baseUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol)) throw new Error('Invalid OpenCode provisioner URL');
    if (token.length < 32) throw new Error('OpenCode provisioner token must contain at least 32 characters');
  }

  async assertAvailable(): Promise<void> {
    let response: Response;
    try {
      response = await this.requestFetch(new URL('/healthz', this.baseUrl), {
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Error('OpenCode provisioner unavailable');
    }
    if (!response.ok) throw new Error('OpenCode provisioner unavailable');
    try {
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || !('ok' in body) || body.ok !== true) {
        throw new Error('OpenCode provisioner unavailable');
      }
    } catch {
      throw new Error('OpenCode provisioner unavailable');
    }
  }

  async open(input: Parameters<IsolatedOpenCodeProvisioner['open']>[0]): Promise<Awaited<ReturnType<IsolatedOpenCodeProvisioner['open']>>> {
    if (input.providerKind !== 'openai-compatible') {
      throw new Error(`Unsupported provider kind for isolated OpenCode execution: ${input.providerKind}`);
    }
    if (parseModelVariant(input.model.id).variant !== undefined) {
      throw new Error('OpenCode model must be split from its variant before provisioning');
    }
    if (input.model.variant !== undefined && !(MODEL_VARIANTS as readonly string[]).includes(input.model.variant)) {
      throw new Error('Unsupported OpenCode model variant');
    }
    if (input.signal?.aborted) throw new AgentCancelledError('cancelled');
    let response: Response;
    try {
      response = await this.requestFetch(new URL('/v1/runtimes/open', this.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          lease: input.lease,
          providerKind: input.providerKind,
          model: { id: input.model.id, ...(input.model.variant ? { variant: input.model.variant } : {}) },
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
    if (result.model.id !== input.model.id) {
      throw new Error('OpenCode provisioner did not preserve the provider model');
    }
    // The variant is a per-run reasoning choice: a response that drops or rewrites
    // it would silently run the wrong effort, so require an exact echo.
    if (result.model.variant !== undefined
      && (typeof result.model.variant !== 'string' || !(MODEL_VARIANTS as readonly string[]).includes(result.model.variant))) {
      throw new Error('Invalid OpenCode provisioner response');
    }
    if (result.model.variant !== input.model.variant) {
      throw new Error('OpenCode provisioner did not preserve the model variant');
    }
    return {
      client: new OpenCodeV2Client({
        baseUrl: result.baseUrl,
        password: result.password,
        headers: { 'x-provisioner-token': this.token },
        fetch: this.requestFetch,
      }),
      directory: result.directory,
      model: {
        providerID: result.model.providerID,
        id: result.model.id,
        ...(result.model.variant ? { variant: result.model.variant as ModelVariant } : {}),
      },
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
