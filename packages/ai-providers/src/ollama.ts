import { ProviderError } from './types.js';
import type { AiProvider, ChatMessage, ChatRequest, ChatResponse, ModelInfo, ProviderContext, ToolCallRequest } from './types.js';

interface OllamaConfig {
  baseUrl: string;
  timeoutMs: number;
  requireToolSupport: boolean;
}

function readConfig(context: ProviderContext): OllamaConfig {
  const baseUrl = String(context.config.baseUrl ?? 'http://ollama:11434').replace(/\/$/, '');
  return {
    baseUrl,
    timeoutMs: Number(context.config.timeoutMs ?? 300_000),
    requireToolSupport: context.config.requireToolSupport !== false,
  };
}

function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.role === 'tool') {
    base.role = 'tool';
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    base.tool_calls = message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }));
  }
  return base;
}

export class OllamaProvider implements AiProvider {
  readonly kind = 'ollama';

  async health(context: ProviderContext): Promise<{ ok: boolean; message: string }> {
    const { baseUrl, timeoutMs } = readConfig(context);
    try {
      const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)) });
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
      return { ok: true, message: 'reachable' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  async listModels(context: ProviderContext): Promise<ModelInfo[]> {
    const { baseUrl, timeoutMs } = readConfig(context);
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)) });
    if (!response.ok) throw new ProviderError('unavailable', `Ollama returned HTTP ${response.status}`, response.status);
    const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const models: ModelInfo[] = [];
    for (const model of payload.models ?? []) {
      const id = model.name ?? model.model;
      if (!id) continue;
      const capabilities = await this.capabilities(context, id);
      models.push({
        id,
        label: id,
        supportsTools: capabilities.includes('tools'),
      });
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async capabilities(context: ProviderContext, model: string): Promise<string[]> {
    const { baseUrl, timeoutMs } = readConfig(context);
    try {
      const response = await fetch(`${baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)),
      });
      if (!response.ok) return [];
      const payload = (await response.json()) as { capabilities?: string[] };
      return payload.capabilities ?? [];
    } catch {
      return [];
    }
  }

  async chat(context: ProviderContext, request: ChatRequest): Promise<ChatResponse> {
    const config = readConfig(context);
    if (config.requireToolSupport && request.tools && request.tools.length > 0) {
      const capabilities = await this.capabilities(context, request.model);
      if (!capabilities.includes('tools')) {
        throw new ProviderError('unsupported', `model ${request.model} does not support tool calling`);
      }
    }
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOllamaMessage),
      stream: false,
      options: {
        temperature: request.temperature ?? 0.2,
        ...(request.maxTokens ? { num_predict: request.maxTokens } : {}),
      },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }

    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs)])
      : AbortSignal.timeout(config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'AbortError') throw new ProviderError('timeout', 'Ollama request timed out');
      throw new ProviderError('unavailable', `Ollama unreachable: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(response.status === 404 ? 'model_missing' : 'bad_response', `Ollama HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
    }

    let payload: {
      message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: string;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      throw new ProviderError('unavailable', `Ollama response unreadable: ${(error as Error).message}`, response.status);
    }
    const rawCalls = payload.message?.tool_calls ?? [];
    const toolCalls: ToolCallRequest[] = rawCalls.map((call, index) => ({
      id: `ollama_${index}_${Date.now()}`,
      name: call.function?.name ?? 'unknown',
      arguments: normalizeArguments(call.function?.arguments),
    }));
    return {
      content: payload.message?.content ?? '',
      toolCalls,
      finishReason: payload.done_reason,
      usage: {
        promptTokens: payload.prompt_eval_count,
        completionTokens: payload.eval_count,
        totalTokens: (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0) || undefined,
      },
    };
  }
}

export function normalizeArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') return value as Record<string, unknown>;
  return {};
}
