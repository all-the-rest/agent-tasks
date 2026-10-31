import { describe, expect, it } from 'vitest';
import { EmailDslError, parseEmailDsl } from '../src/email-dsl.js';

describe('e-mail DSL', () => {
  it('parses headings, paragraphs, images, imageText, buttons and dividers', () => {
    const blocks = parseEmailDsl([
      '# Weekly report',
      'The summary line.',
      'A second line in the same paragraph.',
      '',
      '## Highlights',
      '![Revenue chart](https://example.com/chart.png)',
      ':::imageText side=right image=https://example.com/team.png alt="Team photo" width=240',
      'The team grew by 12% this quarter.',
      ':::',
      '{{Open execution | https://example.com/executions/1}}',
      '---',
    ].join('\n'));

    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'image',
      'imageText',
      'button',
      'divider',
    ]);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1, text: 'Weekly report' });
    expect(blocks[1]).toMatchObject({ type: 'paragraph', text: 'The summary line.\nA second line in the same paragraph.' });
    expect(blocks[3]).toMatchObject({ type: 'image', alt: 'Revenue chart', url: 'https://example.com/chart.png' });
    expect(blocks[4]).toMatchObject({ type: 'imageText', side: 'right', imageWidth: 240, alt: 'Team photo' });
    expect(blocks[5]).toMatchObject({ type: 'button', label: 'Open execution' });
  });

  it('defaults imageText to the left side', () => {
    const [block] = parseEmailDsl(':::imageText image=https://example.com/a.png\ntext\n:::');
    expect(block).toMatchObject({ type: 'imageText', side: 'left' });
  });

  it('rejects unknown directives and unterminated blocks with a line number', () => {
    expect(() => parseEmailDsl(':::gallery image=https://example.com/a.png\nx\n:::')).toThrow(EmailDslError);
    expect(() => parseEmailDsl(':::imageText image=https://example.com/a.png\ntext')).toThrow(/unterminated/);
  });

  it('rejects non-http image and button URLs', () => {
    expect(() => parseEmailDsl('![x](javascript:alert(1))')).toThrow(EmailDslError);
    expect(() => parseEmailDsl('{{Open | ftp://example.com/file}}')).toThrow(EmailDslError);
  });

  it('rejects empty input and more than 20 blocks', () => {
    expect(() => parseEmailDsl('   \n\n')).toThrow(/no blocks/);
    const many = Array.from({ length: 21 }, () => '---').join('\n');
    expect(() => parseEmailDsl(many)).toThrow(EmailDslError);
  });
});
