import { AgentCancelledError, buildSystemPrompt } from '@agent-tasks/agent-runtime';
import type { AgentSource, RunAgentOptions } from '@agent-tasks/agent-runtime';
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
    if (options.signal?.aborted) throw new AgentCancelledError('cancelled');
    // Validate ownership and the current lease before passing a credential to the provisioner.
    await store.access(lease);
    if (options.signal?.aborted) throw new AgentCancelledError('cancelled');
    const tools: string[] = [];
    if (options.emailNotification) tools.push('compose_email', 'add_email_block');
    if (options.allowWebResearch) {
      tools.push(
        'search_web',
        'open_url',
        'extract_page_text',
        'inspect_page',
        'click_element',
        'navigate_back',
        'get_page_title',
        'get_current_url',
        'extract_links',
        ...(options.allowForms ? ['fill_form'] : []),
      );
    }
    if (options.memoryEnabled) tools.push('record_task_memory', 'track_recommendation');
    if (tools.length > 0 && !toolBridgeHub) throw new Error('OpenCode tool bridge is not configured');
    const bridge = tools.length > 0
      ? toolBridgeHub!.open({
          tools,
          context: {
            browser: options.browser,
            search: options.search,
            sessionId: options.sessionId,
            allowForms: options.allowForms,
            limits: {
              maxPageVisits: options.limits.maxPageVisits,
              maxSearchQueries: options.limits.maxSearchQueries,
              maxOutputBytes: options.limits.maxOutputBytes,
            },
          },
        })
      : undefined;
    const systemPrompt = buildSystemPrompt({
      title: options.title,
      prompt: options.prompt,
      systemInstructions: options.systemInstructions,
      timezone: options.timezone,
      today: (options.now?.() ?? new Date()).toISOString().slice(0, 10),
      allowWebResearch: options.allowWebResearch,
      emailNotification: options.emailNotification === true,
      toolNames: tools,
      memoryContext: options.memoryContext ?? null,
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
      if (!bridge) return result;
      // Structured output and research results come from validated tool calls.
      // OpenCode only emits the final text, so the bridge is the source of truth
      // for sources, e-mail blocks and memory proposals.
      return {
        ...result,
        sources: mergeSources(result.sources, bridge.sources),
        emailBlocks: bridge.emailBlocks.length > 0 ? bridge.emailBlocks : result.emailBlocks,
        memoryOps: mergeByKey(result.memoryOps, bridge.memoryOps, (op) => op.semanticKey ?? op.content),
        recommendationOps: mergeByKey(result.recommendationOps, bridge.recommendationOps, (op) => op.stableKey),
      };
    } finally {
      bridge?.close();
      await runtime.release().catch(() => { throw new Error('Unable to release isolated OpenCode runtime'); });
    }
  };
}

/** Deduplicate by URL, keeping the newest retrieval. */
function mergeSources(existing: AgentSource[], collected: AgentSource[]): AgentSource[] {
  const merged = new Map<string, AgentSource>();
  for (const source of [...existing, ...collected]) merged.set(source.url, source);
  return [...merged.values()];
}

function mergeByKey<T>(existing: T[], collected: T[], keyOf: (item: T) => string): T[] {
  const merged = new Map<string, T>();
  for (const item of [...existing, ...collected]) merged.set(keyOf(item), item);
  return [...merged.values()];
}
