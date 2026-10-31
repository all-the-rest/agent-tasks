import { spawn } from 'node:child_process';
import { ProviderError } from './types.js';
import type { AiProvider, ChatRequest, ChatResponse, ModelInfo, ProviderContext } from './types.js';

/**
 * Experimental Codex adapter.
 *
 * Only the officially supported, account-scoped path is implemented: `codex exec`
 * reads its own login state from an isolated CODEX_HOME. The adapter never shares
 * one account between users, never reads browser cookies and never calls
 * undocumented chatgpt.com endpoints. It is disabled unless BOTH the deployment
 * sets `AGENT_TASKS_ENABLE_CODEX=1` and the provider record is marked enabled.
 *
 * Verified limitation: `codex exec` is a text interface, so this adapter cannot
 * offer structured tool calling. Tasks that need research must use Ollama or an
 * OpenAI-compatible provider.
 */
export class CodexProvider implements AiProvider {
  readonly kind = 'codex';

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private guard(context: ProviderContext): { codexHome: string; binary: string } {
    if (this.env.AGENT_TASKS_ENABLE_CODEX !== '1') {
      throw new ProviderError('unsupported', 'the Codex adapter is disabled; set AGENT_TASKS_ENABLE_CODEX=1 to opt in');
    }
    if (context.config.enabled !== true) {
      throw new ProviderError('unsupported', 'this provider record is not enabled for account-scoped Codex use');
    }
    const codexHome = String(context.config.codexHome ?? '');
    if (!codexHome.startsWith('/')) {
      throw new ProviderError('unsupported', 'codexHome must be an absolute per-user directory');
    }
    return { codexHome, binary: String(context.config.binary ?? 'codex') };
  }

  async health(context: ProviderContext): Promise<{ ok: boolean; message: string }> {
    try {
      this.guard(context);
      return { ok: true, message: 'enabled (experimental, text-only)' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  async listModels(context: ProviderContext): Promise<ModelInfo[]> {
    this.guard(context);
    // The CLI has no supported model-discovery command; the admin declares models.
    const declared = (context.config.models as Array<{ id: string; label?: string; contextLength?: number }> | undefined) ?? [];
    return declared.map((model) => ({ id: model.id, label: model.label ?? model.id, supportsTools: false, contextLength: model.contextLength }));
  }

  async chat(context: ProviderContext, request: ChatRequest): Promise<ChatResponse> {
    const { codexHome, binary } = this.guard(context);
    if (request.tools && request.tools.length > 0) {
      throw new ProviderError('unsupported', 'the Codex adapter cannot execute tool calls; choose a tool-capable provider');
    }
    const prompt = request.messages
      .filter((message) => message.role === 'system' || message.role === 'user')
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n');
    const args = ['exec', '--json', '--model', request.model, '--', prompt];

    return new Promise<ChatResponse>((resolve, reject) => {
      const child = spawn(binary, args, {
        env: { PATH: this.env.PATH ?? '', HOME: codexHome, CODEX_HOME: codexHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new ProviderError('timeout', 'codex exec timed out'));
      }, 120_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(new ProviderError('unavailable', `codex binary unavailable: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new ProviderError('bad_response', `codex exec failed with code ${code}: ${stderr.slice(0, 300)}`));
          return;
        }
        const text = extractAgentMessage(stdout);
        resolve({ content: text, toolCalls: [], finishReason: 'stop' });
      });
    });
  }
}

/** `codex exec --json` emits JSONL; the final assistant message is what we report. */
export function extractAgentMessage(stdout: string): string {
  const lines = stdout.split('\n').filter((line) => line.trim().startsWith('{'));
  let last = '';
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; msg?: { type?: string; message?: string }; message?: string };
      const text = event.msg?.message ?? event.message;
      if (typeof text === 'string' && text.trim()) last = text;
    } catch {
      // non-JSON noise from the CLI is ignored on purpose
    }
  }
  return last;
}
