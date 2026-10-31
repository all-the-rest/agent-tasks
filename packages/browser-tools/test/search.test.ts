import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureSearchProvider, NoopSearchProvider, SearxngSearchProvider } from '../src/search.js';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function startSearxng(
  handler: (url: URL) => { status: number; body: unknown },
): Promise<{ baseUrl: string; requests: URL[] }> {
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    requests.push(url);
    const result = handler(url);
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  servers.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

describe('SearxngSearchProvider', () => {
  it('calls the JSON API and maps title, url, snippet, engine and date', async () => {
    const { baseUrl, requests } = await startSearxng(() => ({
      status: 200,
      body: {
        results: [
          { title: 'Example', url: 'https://example.com/a', content: 'First hit', engine: 'duckduckgo', publishedDate: '2026-10-01' },
          { url: 'https://example.com/b' },
        ],
      },
    }));

    const results = await new SearxngSearchProvider({ baseUrl }).search('agent tasks', 10);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe('/search');
    expect(requests[0]?.searchParams.get('q')).toBe('agent tasks');
    expect(requests[0]?.searchParams.get('format')).toBe('json');
    expect(results).toEqual([
      { title: 'Example', url: 'https://example.com/a', snippet: 'First hit', engine: 'duckduckgo', publishedAt: '2026-10-01' },
      { title: 'https://example.com/b', url: 'https://example.com/b', snippet: '', engine: undefined, publishedAt: undefined },
    ]);
  });

  it('drops non-http results and honours the limit', async () => {
    const { baseUrl } = await startSearxng(() => ({
      status: 200,
      body: {
        results: [
          { title: 'ftp', url: 'ftp://example.com/file' },
          { title: 'one', url: 'https://example.com/1' },
          { title: 'two', url: 'https://example.com/2' },
        ],
      },
    }));

    const results = await new SearxngSearchProvider({ baseUrl }).search('query', 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe('https://example.com/1');
  });

  it('rejects with the backend status instead of returning an empty list', async () => {
    const { baseUrl } = await startSearxng(() => ({ status: 503, body: { error: 'down' } }));

    await expect(new SearxngSearchProvider({ baseUrl }).search('query', 5)).rejects.toThrow('search backend returned HTTP 503');
  });

  it('honours a caller abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { baseUrl } = await startSearxng(() => ({ status: 200, body: { results: [] } }));

    await expect(new SearxngSearchProvider({ baseUrl }).search('query', 5, controller.signal)).rejects.toThrow();
  });
});

describe('deterministic providers', () => {
  it('fixture provider matches a keyword and slices to the limit', async () => {
    const provider = new FixtureSearchProvider({
      alpha: [{ title: 'A', url: 'https://example.com/a', snippet: '' }],
      beta: [{ title: 'B', url: 'https://example.com/b', snippet: '' }],
    });

    expect((await provider.search('tell me about ALPHA', 5)).map((result) => result.title)).toEqual(['A']);
    expect((await provider.search('nothing matches', 1)).map((result) => result.title)).toEqual(['A']);
  });

  it('noop provider never performs a request and returns an empty list', async () => {
    await expect(new NoopSearchProvider().search('query', 10)).resolves.toEqual([]);
  });
});
