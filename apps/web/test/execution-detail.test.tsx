// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../src/components/ui';
import { setLanguage } from '../src/i18n';
import { api } from '../src/lib/api';
import type { Execution } from '../src/lib/types';
import { ExecutionDetailPage } from '../src/pages/ExecutionDetailPage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

function makeExecution(
  id: string,
  markdown: string,
  change?: NonNullable<Execution['report']>['change'],
  options: {
    steps?: Execution['steps'];
    sources?: NonNullable<Execution['report']>['sources'];
    summary?: string;
  } = {},
): Execution {
  return {
    id,
    taskId: 'task-1',
    taskTitle: 'Research task',
    status: 'completed',
    trigger: 'schedule',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60_000,
    error: null,
    inputSnapshot: 'Research the latest public updates.',
    ownerId: 'owner-1',
    providerId: 'provider-1',
    model: 'test-model',
    report: { summary: options.summary ?? 'Research summary', markdown, sources: options.sources ?? [], uncertainty: [], change },
    toolCalls: [],
    usage: null,
    steps: options.steps ?? [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderExecutionDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/executions/current']}>
        <ToastProvider>
          <Routes>
            <Route path="/executions/:id" element={<ExecutionDetailPage />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setLanguage('en');
  vi.spyOn(api.executions, 'memory').mockResolvedValue({ changes: [], suggestions: [], recommendationEvents: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage('en');
});

describe('execution report comparison', () => {
  it('renders Markdown in the report summary without exposing its syntax', async () => {
    vi.spyOn(api.executions, 'get').mockResolvedValue(
      makeExecution('current', '# Findings', undefined, { summary: '> **Important** summary.' }),
    );

    const { container } = renderExecutionDetail();

    await screen.findByRole('heading', { name: 'Findings' });
    expect(screen.getByRole('heading', { name: 'User input' })).toBeTruthy();
    expect(screen.getByText('Research the latest public updates.')).toBeTruthy();
    expectInteractiveControlsNamed();
    expect(container.querySelector('.report-prose blockquote strong')?.textContent).toBe('Important');
    expect(container.textContent).not.toContain('> **Important**');
  });

  it('fetches and renders both sanitized reports when a predecessor is available', async () => {
    const getExecution = vi.spyOn(api.executions, 'get').mockImplementation(async (id) =>
      id === 'current'
        ? makeExecution('current', '# Current findings', { status: 'changed', previousExecutionId: 'previous' })
        : makeExecution('previous', '# Previous findings\n\n<script>window.__pwned = true</script>'),
    );

    const { container } = renderExecutionDetail();

    expect(await screen.findByRole('heading', { name: 'Historical report comparison' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Previous findings' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Current findings' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Previous report' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Current report' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open previous execution (previous)' }).getAttribute('href'))
      .toBe('/executions/previous');
    expect(getExecution).toHaveBeenCalledWith('previous');
    expect(container.querySelector('script')).toBeNull();
    // Raw HTML is neutralized to inert literal text by checkReportLinks; the
    // sanitizer still guarantees it is not emitted as a script element.
    expect(container.textContent).toContain('window.__pwned');
  });

  it('announces comparison load failures and retries the previous execution query', async () => {
    let previousRequests = 0;
    const getExecution = vi.spyOn(api.executions, 'get').mockImplementation(async (id) => {
      if (id === 'current') {
        return makeExecution('current', '# Current findings', {
          status: 'changed',
          previousExecutionId: 'previous',
        });
      }
      previousRequests += 1;
      if (previousRequests === 1) throw new Error('offline');
      return makeExecution('previous', '# Previous findings');
    });

    renderExecutionDetail();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Previous findings' })).toBeTruthy();
    expect(getExecution).toHaveBeenCalledTimes(3);
  });

  it('does not fetch or show comparison when change metadata has no predecessor', async () => {
    const getExecution = vi.spyOn(api.executions, 'get').mockResolvedValue(
      makeExecution('current', '# First report', { status: 'first' }),
    );

    renderExecutionDetail();

    expect(await screen.findByRole('heading', { name: 'First report' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Historical report comparison' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Open previous execution/ })).toBeNull();
    expect(getExecution).toHaveBeenCalledTimes(1);
    expect(getExecution).toHaveBeenCalledWith('current');
  });

  it('announces execution detail load failures accessibly', async () => {
    vi.spyOn(api.executions, 'get')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(makeExecution('current', '# Findings'));

    renderExecutionDetail();

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Findings' })).toBeTruthy();
  });

  it('rechecks link provenance when rendering current and historical reports', async () => {
    vi.spyOn(api.executions, 'get').mockImplementation(async (id) =>
      id === 'current'
        ? makeExecution(
            'current',
            '[unverified current link](https://invented-current.example/)',
            { status: 'changed', previousExecutionId: 'previous' },
          )
        : makeExecution(
            'previous',
            '[verified historical link](https://source.example/page)\n\n[unverified historical link](https://invented-previous.example/)',
            undefined,
            { sources: [{ url: 'https://source.example/page', title: 'Verified source', retrievedAt: '2026-01-01T00:00:00.000Z', confidence: 'verified' }] },
          ),
    );

    renderExecutionDetail();

    expect(await screen.findByRole('heading', { name: 'Historical report comparison' })).toBeTruthy();
    const verified = await screen.findByRole('link', { name: 'verified historical link' });
    expect(verified.getAttribute('href')).toBe('https://source.example/page');
    expect(screen.queryByRole('link', { name: 'unverified historical link' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'unverified current link' })).toBeNull();
  });
});

describe('execution visited sites', () => {
  it('only presents successful source-producing steps whose URL is a collected source', async () => {
    vi.spyOn(api.executions, 'get').mockResolvedValue(makeExecution('current', '# Report', undefined, {
      sources: [{ url: 'https://visited.example/page', title: 'Visited page', retrievedAt: '2026-01-01T00:00:00.000Z', confidence: 'verified' }],
      steps: [
        { id: '1', executionId: 'current', step: 1, tool: 'open_url', args: { url: 'https://visited.example/page' }, ok: true, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, durationMs: 1, error: null, resultPreview: null },
        { id: '2', executionId: 'current', step: 2, tool: 'open_url', args: { url: 'https://refused.example/' }, ok: false, startedAt: '2026-01-01T00:00:01.000Z', finishedAt: null, durationMs: 1, error: 'blocked', resultPreview: null },
        { id: '3', executionId: 'current', step: 3, tool: 'open_url', args: { url: 'https://not-collected.example/' }, ok: true, startedAt: '2026-01-01T00:00:02.000Z', finishedAt: null, durationMs: 1, error: null, resultPreview: null },
      ],
    }));

    renderExecutionDetail();
    await screen.findByRole('heading', { name: 'Report' });
    await screen.findByRole('tab', { name: /Timeline/ }).then((tab) => tab.click());

    expect(await screen.findByRole('link', { name: 'Visited page' })).toBeTruthy();
    expect(screen.queryByText('https://refused.example/')).toBeNull();
    expect(screen.queryByText('https://not-collected.example/')).toBeNull();
  });
});

describe('execution source URL safety', () => {
  it('renders invalid source and visited-site URLs as non-clickable text', async () => {
    vi.spyOn(api.executions, 'get').mockResolvedValue(makeExecution('current', '# Report', undefined, {
      sources: [
        { url: 'javascript:alert(1)', title: 'Unsafe source', retrievedAt: '2026-01-01T00:00:00.000Z', confidence: 'unknown' },
        { url: 'https://safe.example/page', title: 'Safe source', retrievedAt: '2026-01-01T00:00:00.000Z', confidence: 'verified' },
      ],
      steps: [
        { id: '1', executionId: 'current', step: 1, tool: 'open_url', args: { url: 'javascript:alert(1)' }, ok: true, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, durationMs: 1, error: null, resultPreview: null },
        { id: '2', executionId: 'current', step: 2, tool: 'open_url', args: { url: 'https://safe.example/page' }, ok: true, startedAt: '2026-01-01T00:00:01.000Z', finishedAt: null, durationMs: 1, error: null, resultPreview: null },
      ],
    }));

    const { container } = renderExecutionDetail();
    await screen.findByRole('heading', { name: 'Report' });

    const unsafeLabels = screen.getAllByText('Unsafe source');
    expect(unsafeLabels.length).toBeGreaterThan(0);
    expect(unsafeLabels.every((label) => label.tagName !== 'A')).toBe(true);
    expect(screen.queryAllByRole('link', { name: 'Unsafe source' })).toHaveLength(0);

    fireEvent.click(await screen.findByRole('tab', { name: /Sources/ }));
    expect(screen.getAllByRole('link', { name: 'Safe source' })[0]?.getAttribute('href')).toBe('https://safe.example/page');
    expect(screen.queryAllByRole('link', { name: 'Unsafe source' })).toHaveLength(0);

    fireEvent.click(await screen.findByRole('tab', { name: /Timeline/ }));
    expect(screen.queryAllByRole('link', { name: 'Unsafe source' })).toHaveLength(0);
    expect(screen.getAllByRole('link', { name: 'Safe source' })[0]?.getAttribute('href')).toBe('https://safe.example/page');

    const hrefs = [...container.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href') ?? '');
    expect(hrefs.some((href) => href.startsWith('javascript:'))).toBe(false);
  });
});
