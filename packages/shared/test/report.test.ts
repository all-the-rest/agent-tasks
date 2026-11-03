import { describe, expect, it } from 'vitest';
import { emptyReport, reportChangeStatus, reportToMarkdown } from '../src/report.js';

describe('report change detection', () => {
  it('marks the first run and a missing predecessor honestly', () => {
    expect(reportChangeStatus(null, 'anything')).toBe('first');
    expect(reportChangeStatus(undefined, 'anything')).toBe('first');
    expect(reportChangeStatus('   ', 'anything')).toBe('unknown');
  });

  it('compares the report text, ignoring surrounding whitespace', () => {
    expect(reportChangeStatus('same body\n', 'same body')).toBe('unchanged');
    expect(reportChangeStatus('old body', 'new body')).toBe('changed');
  });
});

describe('report rendering', () => {
  it('renders summary, sources and uncertainty for an export', () => {
    const report = {
      ...emptyReport('Short answer'),
      markdown: 'Long body',
      sources: [{ url: 'https://example.com/', title: 'Example', confidence: 'verified' as const, retrievedAt: '2026-11-03T00:00:00.000Z' }],
      uncertainty: ['Only one source was available'],
    };
    const markdown = reportToMarkdown(report, { title: 'Export', finishedAt: '2026-11-03T01:00:00.000Z' });
    expect(markdown).toContain('# Export');
    expect(markdown).toContain('Long body');
    expect(markdown).toContain('## Sources');
    expect(markdown).toContain('https://example.com/');
    expect(markdown).toContain('## Uncertainty');
    expect(markdown).toContain('Only one source was available');
  });
});
