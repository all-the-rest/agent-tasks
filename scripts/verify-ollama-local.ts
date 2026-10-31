/**
 * Real local-inference smoke test (not part of the deterministic CI suite).
 *
 * Requires a running Ollama with a tool-capable model:
 *   ollama serve
 *   ollama pull llama3.2:1b
 *   pnpm exec tsx scripts/verify-ollama-local.ts
 *
 * Exit code 0 only when the model answers and actually emits a tool call.
 */
import { createProvider, contextFor } from '@agent-tasks/ai-providers';

const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const model = process.env.OLLAMA_MODEL ?? 'llama3.2:1b';

const provider = createProvider('ollama');
const context = contextFor(
  { id: 'local-ollama', name: 'Ollama (local)', kind: 'ollama', enabled: true, config: { baseUrl, timeoutMs: 180_000, requireToolSupport: true } },
  undefined,
);

const health = await provider.health(context);
console.log('health:', health);
if (!health.ok) process.exit(1);

const models = await provider.listModels(context);
console.log('models:', models);
const declared = models.find((entry) => entry.id === model || entry.id.startsWith(`${model}:`));
if (!declared?.supportsTools) {
  console.error(`model ${model} is not listed with tool support`);
  process.exit(1);
}

const response = await provider.chat(context, {
  model: declared.id,
  temperature: 0,
  messages: [
    { role: 'system', content: 'You are a tool-using assistant. Always call get_weather for weather questions.' },
    { role: 'user', content: 'What is the weather in Vienna right now? Use the get_weather tool.' },
  ],
  tools: [
    {
      name: 'get_weather',
      description: 'Return the current weather for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
        additionalProperties: false,
      },
    },
  ],
});

console.log('response:', JSON.stringify(response, null, 2));
const call = response.toolCalls?.[0];
if (!call || call.name !== 'get_weather') {
  console.error('FAIL: the real model did not emit a get_weather tool call');
  process.exit(1);
}
console.log('PASS: real model emitted tool call', call.name, JSON.stringify(call.arguments));
