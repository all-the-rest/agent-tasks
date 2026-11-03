// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { EmailBlock } from '@agent-tasks/shared';
import { EmailBlocksPreview } from '../src/components/EmailBlocksPreview';

function renderBlocks(blocks: EmailBlock[]): HTMLElement {
  return render(<EmailBlocksPreview blocks={blocks} />).container;
}

describe('notification e-mail preview', () => {
  it('renders the same block types the e-mail document uses', () => {
    const container = renderBlocks([
      { type: 'heading', text: 'Weekly report', level: 1 },
      { type: 'paragraph', text: 'All checks passed.' },
      { type: 'button', label: 'Open', url: 'https://example.com/executions/1' },
      { type: 'divider' },
    ]);
    expect(container.querySelector('h4')?.textContent).toBe('Weekly report');
    expect(container.textContent).toContain('All checks passed.');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/executions/1');
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('keeps model text inert and never creates markup from it', () => {
    const container = renderBlocks([
      { type: 'paragraph', text: '<script>window.__previewPwned = true</script>\n<img src=x onerror="alert(1)">' },
    ]);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __previewPwned?: boolean }).__previewPwned).toBeUndefined();
    expect(container.textContent).toContain('<script>');
  });

  it('drops links and images that are not http(s)', () => {
    const container = renderBlocks([
      { type: 'button', label: 'Bad', url: 'javascript:alert(1)' },
      { type: 'image', url: 'data:text/html,<script>alert(1)</script>', alt: 'bad', width: 100 },
    ]);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders image-text blocks with the requested side', () => {
    const container = renderBlocks([
      { type: 'imageText', imageUrl: 'https://example.com/chart.png', alt: 'Chart', text: 'Revenue is up.', side: 'right', imageWidth: 200 },
    ]);
    const row = container.querySelector('[data-testid="email-block-preview"] > div');
    expect(row?.textContent).toContain('Revenue is up.');
    expect(row?.querySelector('img')?.getAttribute('alt')).toBe('Chart');
    expect(row?.lastElementChild?.tagName).toBe('IMG');
  });
});
