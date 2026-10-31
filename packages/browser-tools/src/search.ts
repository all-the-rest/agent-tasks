import { z } from 'zod';

export const searchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string().default(''),
  engine: z.string().optional(),
  publishedAt: z.string().optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export interface SearchProvider {
  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

/** SearXNG JSON API (`/search?format=json`), self-hosted, no commercial key. */
export class SearxngSearchProvider implements SearchProvider {
  constructor(private readonly options: { baseUrl: string; timeoutMs?: number }) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL('/search', this.options.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', 'en');
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'agent-tasks/0.1.0' },
      signal: signal ?? AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });
    if (!response.ok) throw new Error(`search backend returned HTTP ${response.status}`);
    const payload = (await response.json()) as { results?: Array<Record<string, unknown>> };
    return (payload.results ?? [])
      .map((entry) =>
        searchResultSchema.parse({
          title: String(entry.title ?? entry.url ?? ''),
          url: String(entry.url ?? ''),
          snippet: String(entry.content ?? entry.snippet ?? ''),
          engine: entry.engine ? String(entry.engine) : undefined,
          publishedAt: entry.publishedDate ? String(entry.publishedDate) : undefined,
        }),
      )
      .filter((result) => result.url.startsWith('http'))
      .slice(0, limit);
  }
}

/** Deterministic provider for integration tests: no network, stable URLs. */
export class FixtureSearchProvider implements SearchProvider {
  constructor(private readonly fixture: Record<string, SearchResult[]>) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const key = Object.keys(this.fixture).find((candidate) => query.toLowerCase().includes(candidate.toLowerCase()));
    const results = key ? (this.fixture[key] ?? []) : Object.values(this.fixture).flat();
    return results.slice(0, limit);
  }
}

export class NoopSearchProvider implements SearchProvider {
  async search(): Promise<SearchResult[]> {
    return [];
  }
}
