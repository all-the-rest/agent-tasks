import { AgentCancelledError, buildSystemPrompt } from '@agent-tasks/agent-runtime';
import type { RunAgentOptions } from '@agent-tasks/agent-runtime';
import type { ProviderContext } from '@agent-tasks/ai-providers';
import type { OpenCodeExecutionLease, OpenCodeSessionStore } from './opencode-session-store.js';
import type { ToolBridgeHub } from './opencode-tool-bridge.js';
import { createOpenCodeV2Runner } from './opencode-v2-runner.js';
import type { OpenCodeV2Client, OpenCodeV2Model } from './opencode-v2-client.js';

/**
 * A trusted provisioner must give each execution its own OS/container security
 * boundary and private persistent state. Reopening the same execution after a
 * worker restart must reconnect to that state, not create an empty server.
 * A directory or an OpenCode session on a shared server is not isolation.
 *
 * No production provisioner is currently implemented or configured.
 */
export interface IsolatedOpenCodeProvisioner {
  open(input: {
    lease: OpenCodeExecutionLease;
    providerKind: string;
    providerContext: ProviderContext;
    model: string;
    systemPrompt: string;
    maxAgentSteps: number;
    maxOutputBytes: number;
    /** Present when the execution may call worker-hosted MCP tools. */
    toolBridge?: { token: string; tools: string[] };
    signal?: AbortSignal;
  }): Promise<{
    client: OpenCodeV2Client;
    directory: string;
    model: OpenCodeV2Model;
    /** Release the worker connection; do not delete recoverable session state. */
    release(): Promise<void>;
  }>;
}

export function createIsolatedOpenCodeRunner(
  provisioner: IsolatedOpenCodeProvisioner,
  store: OpenCodeSessionStore,
  toolBridgeHub?: ToolBridgeHub,
) {
  return async (options: RunAgentOptions, lease: OpenCodeExecutionLease) => {
    // Reject unsupported work before provisioning or handing over credentials.
    // Research and memory still need their own tool handlers; e-mail composition
    // is already available through the worker-hosted MCP bridge.
    if (options.allowWebResearch || options.memoryEnabled || options.memoryContext) {
      throw new Error('OpenCode spike only supports tasks without web research or memory');
    }
    if (options.signal?.aborted) throw new AgentCancelledError('cancelled');
    // Validate ownership and the current lease before passing a credential to the provisioner.
    await store.access(lease);
    if (options.signal?.aborted) throw new AgentCancelledError('cancelled');
    const tools = options.emailNotification ? ['compose_email', 'add_email_block'] : [];
    const bridge = tools.length > 0 ? toolBridgeHub?.open({ tools }) : undefined;
    const systemPrompt = buildSystemPrompt({
      title: options.title,
      prompt: options.prompt,
      systemInstructions: options.systemInstructions,
      timezone: options.timezone,
      today: (options.now?.() ?? new Date()).toISOString().slice(0, 10),
      allowWebResearch: false,
      emailNotification: options.emailNotification === true,
      toolNames: tools,
      memoryContext: null,
    });
    let runtime: Awaited<ReturnType<IsolatedOpenCodeProvisioner['open']>>;
    try {
      runtime = await provisioner.open({
        lease,
        providerKind: options.provider.kind,
        providerContext: options.providerContext,
        model: options.model,
        systemPrompt,
        maxAgentSteps: options.limits.maxAgentSteps,
        maxOutputBytes: options.limits.maxOutputBytes,
        ...(bridge ? { toolBridge: { token: bridge.token, tools } } : {}),
        signal: options.signal,
      });
    } catch {
      bridge?.close();
      if (options.signal?.aborted) throw new AgentCancelledError('cancelled');
      // Provisioning errors may include credentials or server authentication material.
      throw new Error('Unable to open isolated OpenCode runtime');
    }
    try {
      const result = await createOpenCodeV2Runner({ ...runtime, store, requiresMcp: Boolean(bridge) })(options, lease);
      return bridge ? { ...result, emailBlocks: bridge.emailBlocks } : result;
    } finally {
      bridge?.close();
      await runtime.release().catch(() => { throw new Error('Unable to release isolated OpenCode runtime'); });
    }
  };
}
