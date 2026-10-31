/* eslint-disable no-undef -- standalone Node script run outside the bundler */
/**
 * Deterministic, slow OpenAI-compatible endpoint used by the worker checks.
 * It answers one chat completion after DELAY_MS so executions stay running long
 * enough to observe claims and to kill a worker mid-run.
 */
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? '18099');
const delayMs = Number(process.env.DELAY_MS ?? '20000');
const model = process.env.MODEL ?? 'mock-slow';

const server = createServer((request, response) => {
  const send = (status, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  };

  if (request.method === 'GET' && request.url?.endsWith('/models')) {
    return send(200, { object: 'list', data: [{ id: model, object: 'model', owned_by: 'worker-check' }] });
  }
  if (request.method === 'POST' && request.url?.endsWith('/chat/completions')) {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const wantsStream = parsed?.stream === true;
      setTimeout(() => {
        if (wantsStream) {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const chunk = {
            id: 'chatcmpl-worker-check',
            object: 'chat.completion.chunk',
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'worker check answer' }, finish_reason: 'stop' }],
          };
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
          response.write('data: [DONE]\n\n');
          response.end();
          return;
        }
        send(200, {
          id: 'chatcmpl-worker-check',
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'worker check answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }, delayMs);
    });
    return;
  }
  send(404, { error: { message: 'not found' } });
});

server.listen(port, '0.0.0.0', () => console.log(`MOCK_READY port=${port} delayMs=${delayMs}`));
