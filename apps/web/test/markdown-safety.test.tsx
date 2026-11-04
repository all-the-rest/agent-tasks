// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { checkReportLinks } from '@agent-tasks/shared';

/**
 * A report is model output derived from web pages. It is rendered exactly like the
 * execution detail page renders it, so a regression in the sanitizer chain fails here.
 */
function renderReport(markdown: string): HTMLElement {
  const { container } = render(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
      {markdown}
    </ReactMarkdown>,
  );
  return container;
}

describe('report rendering', () => {
  it('renders no clickable URL from any unsupported Markdown link syntax', () => {
    const markdown = [
      'Bare https://invented.example/bare',
      '<https://invented.example/angle>',
      '[ref][bad] and ![image](https://invented.example/image)',
      '[bad]: https://invented.example/reference',
      '[valid](https://source.example/page)',
    ].join('\n\n');
    const checked = checkReportLinks(markdown, [{ url: 'https://source.example/page' }]);
    const container = renderReport(checked.markdown);

    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://source.example/page');
    expect(container.querySelector('img')).toBeNull();
    expect(checked.removed).toContain('https://invented.example/reference');
  });

  it('does not execute or emit a script tag', () => {
    const container = renderReport('# Report\n\n<script>window.__pwned = true</script>');
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    // Raw HTML is dropped entirely (no rehype-raw), so not even the source text leaks.
    expect(container.textContent).not.toContain('__pwned');
  });

  it('strips javascript: links and inline event handlers', () => {
    const container = renderReport('<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))');
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('keeps headings, lists and safe links', () => {
    const container = renderReport('## Findings\n\n- one\n- two\n\n[source](https://example.com/a)');
    expect(container.querySelector('h2')?.textContent).toBe('Findings');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a');
  });
});
