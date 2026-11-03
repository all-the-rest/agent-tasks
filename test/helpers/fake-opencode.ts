import { createIsolatedOpenCodeRunner } from '../../apps/worker/src/opencode-isolated-runtime.js';
import type { IsolatedOpenCodeProvisioner } from '../../apps/worker/src/opencode-isolated-runtime.js';
import { OpenCodeSessionStore } from '../../apps/worker/src/opencode-session-store.js';
import type { OpenCodeExecutionLease } from '../../apps/worker/src/opencode-session-store.js';
import { OpenCodeV2Client } from '../../apps/worker/src/opencode-v2-client.js';
import type { Database } from '@agent-tasks/database';
import type { AgentMemoryOp, AgentRecommendationOp } from '@agent-tasks/shared';
import type { ToolBridgeHub } from '../../apps/worker/src/opencode-tool-bridge.js';
import { createToolBridgeHub } from '../../apps/worker/src/opencode-tool-bridge.js';

export interface FakeOpenCodePlan {
  answer?: string;
  searchQuery?: string;
  openUrls?: string[];
  emailDsl?: string;
  memoryOps?: AgentMemoryOp[];
  recommendationOps?: AgentRecommendationOp[];
}

interface ProvisionRequest {
  lease: OpenCodeExecutionLease;
  model: { id: string; variant?: string };
  systemPrompt: string;
  providerContext: { apiKey?: string };
  toolBridge?: { token: string; tools: string[] };
}

interface RuntimeState {
  sessionId: string;
  messages: unknown[];
  dispatched: boolean;
}

/** Makes every fake report unmistakably simulated in UI, exports and tests. */
const FAKE_BANNER = '> **Simulated execution.** The test-only fake OpenCode provisioner produced this report; no model provider was called.\n\n';

/**
 * Test-only fake provisioning boundary. The OpenCode V2 client, session store,
 * executor and worker-hosted MCP tools remain real; only the provisioned runtime
 * and model response are deterministic fakes. It never calls the configured
 * provider URL or logs provider credentials.
 */
export class FakeOpenCodeProvisioner implements IsolatedOpenCodeProvisioner {
  readonly requests: ProvisionRequest[] = [];
  readonly toolCalls: Array<{ executionId: string; name: string; args: unknown; isError: boolean; text: string }> = [];
  readonly plans = new Map<string, FakeOpenCodePlan>();
  defaultPlan: FakeOpenCodePlan = {};

  private readonly runtimes = new Map<string, RuntimeState>();
  private hub: ToolBridgeHub | undefined;

  async start(): Promise<void> {
    this.hub = await createToolBridgeHub({ port: 0 });
  }

  async close(): Promise<void> {
    await this.hub?.close();
    this.hub = undefined;
  }

  runner(db: Database) {
    if (!this.hub) throw new Error('Fake OpenCode provisioner has not started');
    return createIsolatedOpenCodeRunner(this, new OpenCodeSessionStore(db), this.hub);
  }

  async open(input: Parameters<IsolatedOpenCodeProvisioner['open']>[0]): Promise<Awaited<ReturnType<IsolatedOpenCodeProvisioner['open']>>> {
    if (!this.hub) throw new Error('Fake OpenCode provisioner has not started');
    const providerConfig = input.providerContext.config as { models?: unknown } | undefined;
    const catalog = Array.isArray(providerConfig?.models) ? (providerConfig.models as Array<{ id?: unknown; supportsTools?: unknown }>) : [];
    const selected = catalog.find((model) => model?.id === input.model.id);
    if (!selected) throw new Error('Task model is not configured on its provider');
    if (input.toolBridge && selected.supportsTools !== true) throw new Error('Task model is not declared tool-capable');
    const request: ProvisionRequest = {
      lease: input.lease,
      model: { id: input.model.id, ...(input.model.variant ? { variant: input.model.variant } : {}) },
      systemPrompt: input.systemPrompt,
      providerContext: input.providerContext,
      ...(input.toolBridge ? { toolBridge: input.toolBridge } : {}),
    };
    this.requests.push(request);
    let state = this.runtimes.get(input.lease.executionId);
    if (!state) {
      state = { sessionId: `ses_${input.lease.executionId.replaceAll('-', '')}`, messages: [], dispatched: false };
      this.runtimes.set(input.lease.executionId, state);
    }
    const runtime = state;
    const fetchMock: typeof fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === '/api/mcp' && init.method !== 'POST') {
        return json({ data: input.toolBridge ? [{ name: 'agent_tasks_tools', status: { status: 'connected' } }] : [] });
      }
      if (path === '/api/session' && init.method === 'POST') {
        return json({ data: { id: runtime.sessionId } });
      }
      if (path === `/api/session/${runtime.sessionId}/message` && init.method !== 'POST') {
        return json({ data: runtime.messages });
      }
      if (path === `/api/session/${runtime.sessionId}/prompt` && init.method === 'POST') {
        if (!runtime.dispatched) {
          runtime.dispatched = true;
          await this.dispatch(input.lease, input.systemPrompt, input.toolBridge, runtime);
        }
        return json({ data: {} });
      }
      if (path === `/api/session/${runtime.sessionId}/interrupt` && init.method === 'POST') {
        return json({ data: {} });
      }
      return json({ error: { message: 'not found' } }, 404);
    };
    return {
      client: new OpenCodeV2Client({ baseUrl: 'http://fake-opencode.invalid', password: 'fake-runtime-password', fetch: fetchMock }),
      directory: '/fake-workspace',
      model: { providerID: 'agent_tasks', id: input.model.id, ...(input.model.variant ? { variant: input.model.variant } : {}) },
      release: async () => undefined,
    };
  }

  private async dispatch(
    lease: OpenCodeExecutionLease,
    systemPrompt: string,
    bridge: ProvisionRequest['toolBridge'],
    state: RuntimeState,
  ): Promise<void> {
    if (!this.requests.find((request) => request.lease.executionId === lease.executionId)?.providerContext.apiKey) {
      state.messages = [{ type: 'assistant', finish: 'error', error: { name: 'ProviderError' }, content: [] }];
      return;
    }

    const plan = { ...this.defaultPlan, ...this.plans.get(lease.executionId) };
    const available = new Set(bridge?.tools ?? []);
    const invoke = async (name: string, args: unknown): Promise<void> => {
      if (!bridge || !available.has(name) || !this.hub) return;
      const response = await fetch(this.hub.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.toolCalls.length + 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const raw = await response.text();
      const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith('data:'));
      const payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } } : {};
      this.toolCalls.push({
        executionId: lease.executionId,
        name,
        args,
        isError: payload.result?.isError === true,
        text: payload.result?.content?.map((part) => part.text ?? '').join('\n') ?? '',
      });
    };

    if (plan.searchQuery) await invoke('search_web', { query: plan.searchQuery });
    for (const url of plan.openUrls ?? []) await invoke('open_url', { url });
    if (plan.emailDsl) await invoke('compose_email', { dsl: plan.emailDsl });
    for (const op of plan.memoryOps ?? []) await invoke('record_task_memory', op);
    for (const op of plan.recommendationOps ?? []) await invoke('track_recommendation', op);

    const memoryPrompt = systemPrompt.includes('TASK MEMORY') || systemPrompt.includes('PREVIOUS RECOMMENDATIONS');
    const answer = plan.answer ?? `${FAKE_BANNER}${memoryPrompt
      ? 'Previous task memory was provided. Existing tracked recommendations were recognized.'
      : 'Findings\n\nA deterministic fake OpenCode report for the integration test.'}`;
    state.messages = [{
      type: 'assistant',
      finish: 'stop',
      content: [{ type: 'text', text: answer }],
      time: { created: Date.now() - 1, completed: Date.now() },
      tokens: { input: 10, output: 5 },
      cost: 0.001,
    }];
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
