import { describe, expect, it } from 'vitest';
import { checkReportLinks, emptyReport, reportChangeStatus, reportToMarkdown } from '../src/report.js';

describe('report change detection', () => {  it('marks the first run and a missing predecessor honestly', () => {
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

describe('report link validation', () => {
  it('keeps links that a tool result actually produced and reduces unbacked ones to text', () => {
    const markdown = [
      'See [the report](https://example.com/report) and [invented](https://hallucinated.example/page).',
      'A [same page](https://example.com/report/#section) is still the same source.',
    ].join('\n');
    const result = checkReportLinks(markdown, [{ url: 'https://example.com/report' }]);

    expect(result.markdown).toContain('[the report](https://example.com/report)');
    expect(result.markdown).toContain('[same page](https://example.com/report/#section)');
    expect(result.markdown).toContain('invented');
    expect(result.markdown).not.toContain('hallucinated.example');
    expect(result.removed).toEqual(['https://hallucinated.example/page']);
  });

  it('handles an empty link text without leaving a broken markdown link', () => {
    const result = checkReportLinks('[](https://invented.example/a)', []);
    expect(result.markdown).toBe('source');
    expect(result.markdown).not.toContain('](');
  });

  it('removes GFM bare URLs, angle autolinks, reference links and images', () => {
    const markdown = [
      'Bare https://invented.example/bare',
      '<https://invented.example/angle>',
      '[reference][invented] and ![invented image](https://invented.example/image.png)',
      '[invented]: https://invented.example/reference',
      'Keep [sourced][real].',
      '[real]: https://source.example/article',
    ].join('\n\n');
    const result = checkReportLinks(markdown, [{ url: 'https://source.example/article' }]);

    expect(result.removed).toEqual([
      'https://invented.example/bare',
      'https://invented.example/angle',
      'https://invented.example/reference',
    ]);
    expect(result.markdown).not.toMatch(/\]\(https:\/\/invented\.example/);
    expect(result.markdown).not.toMatch(/<https:\/\/invented\.example/);
    expect(result.markdown).toContain('sourced');
    expect(result.markdown).toContain('https://source.example/article');
  });

  it('never embeds a remote image even when its URL is a collected source', () => {
    const result = checkReportLinks('![page](https://source.example/article)', [{ url: 'https://source.example/article' }]);

    expect(result.markdown).toBe('page');
    expect(result.removed).toEqual([]);
  });

  it('does not create Markdown links from escaped, code or raw-HTML-looking input', () => {
    const markdown = [
      '`https://invented.example/code`',
      'https\\://invented.example/escaped',
      '<a href="https://invented.example/html">raw HTML</a>',
    ].join('\n\n');
    const result = checkReportLinks(markdown, []);

    expect(result.markdown).not.toMatch(/\]\(https:\/\/invented\.example/);
    expect(result.removed).toContain('https://invented.example/escaped');
    expect(result.markdown).toContain('`https://invented.example/code`');
    expect(result.markdown).toContain('raw HTML');
  });
});
