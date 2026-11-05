import { AgentCancelledError, buildSystemPrompt } from '@agent-tasks/agent-runtime';
import type { AgentSource, AgentStepRecord, RunAgentOptions } from '@agent-tasks/agent-runtime';
import { parseModelVariant, ProviderError } from '@agent-tasks/ai-providers';
import type { ModelVariant, ProviderContext } from '@agent-tasks/ai-providers';
import { catalogModelFor, catalogModelSupportsTools } from '@agent-tasks/shared';
import type { OpenCodeExecutionLease, OpenCodeSessionStore } from './opencode-session-store.js';
import type { ToolBridgeHub } from './opencode-tool-bridge.js';
import type { ToolBridgeBudgetCounter, ToolBridgeBudgetReservation } from './opencode-tool-bridge.js';
import { createOpenCodeV2Runner } from './opencode-v2-runner.js';
import type { OpenCodeV2Client, OpenCodeV2Model } from './opencode-v2-client.js';

/**
 * A trusted provisioner must give each execution its own OS/container security
 * boundary and private persistent state. Reopening the same execution after a
 * worker restart must reconnect to that state, not create an empty server.
 * A directory or an OpenCode session on a shared server is not isolation.
 *
 * The provider model and, for `model#variant` selections, the reasoning effort.
 * They are separate on the wire: the provisioner and OpenCode know only the base
 * catalog id, while the variant is applied to the model request.
 */
export interface OpenCodeModelSelection {
  id: string;
  variant?: ModelVariant;
}

export interface IsolatedOpenCodeProvisioner {
  open(input: {
    lease: OpenCodeExecutionLease;
    providerKind: string;
    providerContext: ProviderContext;
    model: OpenCodeModelSelection;
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

interface BudgetedRunAgentOptions extends RunAgentOptions {
  /** Worker-injected durable budget; never sourced from the task or provider. */
  executionBudget?: {
    reserveBudget(counters: Partial<Record<ToolBridgeBudgetCounter, number>>): Promise<ToolBridgeBudgetReservation>;
  };
}

export function createIsolatedOpenCodeRunner(
  provisioner: IsolatedOpenCodeProvisioner,
  store: OpenCodeSessionStore,
  toolBridgeHub?: ToolBridgeHub,
) {
  return async (options: RunAgentOptions, lease: OpenCodeExecutionLease) => {
    if (options.signal?.aborted) throw new AgentCancelledError('cancelled');
    // `model#variant` is an Agent Tasks convention. Split it before provisioning:
    // the base id must match the provider catalog exactly, and an unknown variant
    // must fail without creating a runtime or spending a provider call.
    const { model: modelId, variant } = parseModelVariant(options.model);
    // Validate ownership and the current lease before passing a credential to the provisioner.
    await store.access(lease);
    if (options.signal?.aborted) throw new AgentCancelledError('cancelled');
    // The executor always supplies the merged persisted catalog. When a catalog is
    // present the selection must exist in it, and a run that needs tools must be
    // explicitly declared tool-capable — never inferred.
    const catalog = (options.providerContext.config as { models?: unknown } | undefined)?.models;
    if (Array.isArray(catalog) && !catalogModelFor(catalog, modelId)) {
      throw new ProviderError('unsupported', `model ${modelId} is not configured on its provider`);
    }
    if ((options.allowWebResearch || options.memoryEnabled === true)
      && !catalogModelSupportsTools(catalog, modelId)) {
      throw new ProviderError('unsupported', `model ${modelId} is not marked tool-capable on its provider`);
    }
    const tools: string[] = [];
    // Completion e-mail is sent by the worker and needs no model tool. Only offer
    // the structured e-mail blocks when the model may actually call tools.
    if (options.emailNotification && catalogModelSupportsTools(catalog, modelId)) {
      tools.push('compose_email', 'add_email_block');
    }
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

    // OpenCode emits one assistant message per model turn, not one event per MCP
    // call. The bridge reports each call with its own per-session number; the
    // synthetic `opencode` step is renumbered after the last observed call so a
    // recovered run can never overwrite a real tool row. Writes are serialised so
    // parallel calls cannot race the executor's timeline bookkeeping.
    const timeline: AgentStepRecord[] = [];
    let lastTimelineStep = 0;
    let timelineWrite: Promise<void> = Promise.resolve();
    const emitStep = (step: AgentStepRecord): Promise<void> => {
      lastTimelineStep = Math.max(lastTimelineStep, step.step);
      timeline.push(step);
      const write = timelineWrite.then(() => options.onStep?.(step)).then(() => undefined);
      // Keep the chain alive after a failed write, but let this caller observe the
      // failure (the bridge contains it for tool calls; the runner propagates it).
      timelineWrite = write.catch(() => undefined);
      return write;
    };
    const bridge = tools.length > 0
      ? toolBridgeHub!.open({
          tools,
          // The bridge defaults to a hard cap; forward the task's per-execution
          // call budget so a lower limit is enforced and a higher one is not
          // silently reduced.
          maxCalls: options.limits.maxToolCalls,
          onCall: (call) => emitStep(call),
          ...( (options as BudgetedRunAgentOptions).executionBudget
            ? { reserveBudget: (options as BudgetedRunAgentOptions).executionBudget!.reserveBudget }
            : {}),
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
      conversationContext: options.conversationContext ?? null,
    });
    let runtime: Awaited<ReturnType<IsolatedOpenCodeProvisioner['open']>>;
    try {
      runtime = await provisioner.open({
        lease,
        providerKind: options.provider.kind,
        providerContext: options.providerContext,
        model: { id: modelId, ...(variant ? { variant } : {}) },
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
      const runnerOptions: RunAgentOptions = {
        ...options,
        async onStep(step) {
          // The runner's only step is the terminal `opencode` summary. Place it
          // after every call the bridge has accepted, including calls whose tool
          // result is still being written/observed.
          const synthetic = step.tool === 'opencode'
            ? { ...step, step: Math.max(step.step, lastTimelineStep + 1, (bridge?.sequence ?? 0) + 1) }
            : step;
          await emitStep(synthetic);
        },
      };
      const result = await createOpenCodeV2Runner({ ...runtime, store, requiresMcp: Boolean(bridge) })(runnerOptions, lease);
      const steps = [...timeline].sort((left, right) => left.step - right.step);
      if (!bridge) return { ...result, steps };
      // Structured output and research results come from validated tool calls.
      // OpenCode only emits the final text, so the bridge is the source of truth
      // for sources, e-mail blocks and memory proposals.
      return {
        ...result,
        steps,
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
