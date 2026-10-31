import { emailBlockSchema, emailBlocksSchema } from './email-blocks.js';
import type { EmailBlock } from './email-blocks.js';

/**
 * Compact, Markdown-like DSL for agent-composed e-mail blocks. The agent writes
 * text; the parser yields validated `EmailBlock`s and never lets raw HTML through.
 *
 * Grammar (blank line separates paragraphs):
 *
 *   # Heading 1
 *   ## Heading 2
 *   A paragraph. Line breaks are preserved.
 *   ![alt text](https://example.com/image.png)
 *   {{Open execution | https://example.com/executions/1}}
 *   ---
 *   :::imageText side=left image=https://example.com/chart.png alt="Revenue chart"
 *   Text shown beside the image.
 *   :::
 */
export class EmailDslError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'EmailDslError';
  }
}

export const EMAIL_DSL_GRAMMAR = [
  'E-mail DSL (one block per blank-line separated group):',
  '# Heading 1 / ## Heading 2',
  'plain text lines -> paragraph (blank line ends it)',
  '![alt](https://image-url) -> image',
  '{{Button label | https://url}} -> button',
  '--- -> divider',
  ':::imageText side=left|right image=https://url alt="alt text"',
  'text beside the image',
  ':::',
  'http(s) URLs only; at most 20 blocks.',
].join('\n');

function attributes(input: string, line: number): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([a-zA-Z][\w-]*)=(?:"([^"]*)"|(\S+))/g;
  let rest = input;
  for (const match of input.matchAll(pattern)) {
    result[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  rest = rest.replace(pattern, '').trim();
  if (rest) throw new EmailDslError(`unexpected directive attributes: ${rest}`, line);
  return result;
}

function parseBlocks(dsl: string): EmailBlock[] {
  const lines = dsl.replace(/\r\n/g, '\n').split('\n');
  const blocks: EmailBlock[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    const text = paragraph.join('\n').trim();
    if (text) blocks.push(emailBlockSchema.parse({ type: 'paragraph', text }));
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.trim();
    const lineNumber = index + 1;

    if (!line) {
      flush();
      continue;
    }

    if (line.startsWith(':::')) {
      flush();
      const header = line.slice(3).trim();
      const [directive, ...rest] = header.split(/\s+/);
      if (directive !== 'imageText') {
        throw new EmailDslError(`unknown directive "${directive ?? ''}"`, lineNumber);
      }
      const attrs = attributes(rest.join(' '), lineNumber);
      const body: string[] = [];
      let closed = false;
      for (index += 1; index < lines.length; index += 1) {
        if ((lines[index] ?? '').trim() === ':::') {
          closed = true;
          break;
        }
        body.push(lines[index] ?? '');
      }
      if (!closed) throw new EmailDslError('unterminated :::imageText block', lineNumber);
      blocks.push(
        emailBlockSchema.parse({
          type: 'imageText',
          imageUrl: attrs.image,
          text: body.join('\n').trim(),
          alt: attrs.alt ?? '',
          side: attrs.side === 'right' ? 'right' : 'left',
          imageWidth: attrs.width ? Number(attrs.width) : 200,
        }),
      );
      continue;
    }

    const heading = /^(#{1,2})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(emailBlockSchema.parse({ type: 'heading', text: heading[2], level: heading[1]!.length === 1 ? 1 : 2 }));
      continue;
    }

    if (/^---+$/.test(line)) {
      flush();
      blocks.push(emailBlockSchema.parse({ type: 'divider' }));
      continue;
    }

    const image = /^!\[([^\]]*)\]\((\S+)\)$/.exec(line);
    if (image) {
      flush();
      blocks.push(emailBlockSchema.parse({ type: 'image', url: image[2], alt: image[1] }));
      continue;
    }

    const button = /^\{\{\s*(.+?)\s*\|\s*(\S+)\s*\}\}$/.exec(line);
    if (button) {
      flush();
      blocks.push(emailBlockSchema.parse({ type: 'button', label: button[1], url: button[2] }));
      continue;
    }

    paragraph.push(line);
  }
  flush();

  if (blocks.length === 0) throw new EmailDslError('the DSL produced no blocks', 1);
  const parsed = emailBlocksSchema.safeParse(blocks);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EmailDslError(issue?.message ?? 'invalid email blocks', 1);
  }
  return parsed.data;
}

export function parseEmailDsl(dsl: string): EmailBlock[] {
  try {
    return parseBlocks(dsl);
  } catch (error) {
    if (error instanceof EmailDslError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new EmailDslError(message, 1);
  }
}
