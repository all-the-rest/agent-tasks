import { describe, expect, it } from 'vitest';
import { emailBlockSchema, emailBlocksSchema, renderEmailBlocks, renderEmailDocument } from '../src/email-blocks.js';

describe('e-mail blocks', () => {
  it('renders an image beside text on the requested side and escapes content', () => {
    const block = emailBlockSchema.parse({
      type: 'imageText',
      imageUrl: 'https://example.com/chart.png',
      alt: 'A <chart>',
      text: 'Line 1\nLine 2',
      side: 'right',
    });
    const rendered = renderEmailBlocks([block]);
    expect(rendered.html).toContain('src="https://example.com/chart.png"');
    expect(rendered.html).toContain('A &lt;chart&gt;');
    expect(rendered.html).toContain('Line 1<br>Line 2');
    // side=right: text cell precedes the image cell.
    expect(rendered.html.indexOf('Line 1')).toBeLessThan(rendered.html.indexOf('<img'));
    expect(rendered.text).toContain('[image] https://example.com/chart.png');
  });

  it('defaults the image to the left of the text', () => {
    const block = emailBlockSchema.parse({
      type: 'imageText',
      imageUrl: 'https://example.com/chart.png',
      text: 'Body',
    });
    expect(block.type === 'imageText' && block.side).toBe('left');
  });

  it('rejects non-http image and button URLs', () => {
    for (const imageUrl of ['javascript:alert(1)', 'data:image/png;base64,xx', 'ftp://example.com/a.png']) {
      expect(
        emailBlockSchema.safeParse({ type: 'imageText', imageUrl, text: 'Body' }).success,
        imageUrl,
      ).toBe(false);
    }
    expect(emailBlockSchema.safeParse({ type: 'button', label: 'Open', url: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('caps the number of blocks', () => {
    const blocks = Array.from({ length: 21 }, () => ({ type: 'divider' as const }));
    expect(emailBlocksSchema.safeParse(blocks).success).toBe(false);
  });

  it('wraps blocks, intro and action in a mail document', () => {
    const content = renderEmailDocument({
      heading: 'Report ready',
      intro: 'Summary line',
      blocks: [{ type: 'paragraph', text: 'Body' }],
      action: { label: 'Open execution', url: 'https://example.com/executions/1' },
      footer: 'Footer',
    });
    expect(content.html).toContain('<title>Report ready</title>');
    expect(content.html).toContain('Summary line');
    expect(content.html).toContain('Body');
    expect(content.html).toContain('href="https://example.com/executions/1"');
    expect(content.text).toContain('Open execution: https://example.com/executions/1');
  });
});
