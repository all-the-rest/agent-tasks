import { z } from 'zod';

/**
 * E-mail content blocks rendered as table-based, inline-styled HTML that survives
 * mainstream mail clients. The same block list is stored with the execution and
 * can be reused by the web UI later; the renderer here is the single source of
 * truth for the e-mail representation.
 */

const httpUrl = z
  .string()
  .trim()
  .max(2_000)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'only http(s) URLs are allowed');

const altText = z.string().trim().max(300).default('');

export const emailBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    text: z.string().trim().min(1).max(200),
    level: z.union([z.literal(1), z.literal(2)]).default(2),
  }),
  z.object({
    type: z.literal('paragraph'),
    text: z.string().trim().min(1).max(4_000),
  }),
  z.object({
    type: z.literal('image'),
    url: httpUrl,
    alt: altText,
    width: z.number().int().min(40).max(600).default(600),
  }),
  z.object({
    type: z.literal('imageText'),
    imageUrl: httpUrl,
    alt: altText,
    text: z.string().trim().min(1).max(4_000),
    side: z.enum(['left', 'right']).default('left'),
    imageWidth: z.number().int().min(80).max(320).default(200),
  }),
  z.object({
    type: z.literal('button'),
    label: z.string().trim().min(1).max(80),
    url: httpUrl,
  }),
  z.object({
    type: z.literal('divider'),
  }),
]);

export const emailBlocksSchema = z.array(emailBlockSchema).max(20);
export type EmailBlock = z.infer<typeof emailBlockSchema>;
export type EmailBlockType = EmailBlock['type'];

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeMultiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

const TEXT_STYLE = 'margin:0 0 16px;font-size:15px;line-height:1.6;color:#1f2937';
const IMAGE_STYLE = 'display:block;height:auto;border:0;border-radius:6px';

function renderBlock(block: EmailBlock): { html: string; text: string } {
  switch (block.type) {
    case 'heading': {
      const size = block.level === 1 ? 22 : 18;
      return {
        html: `<h${block.level} style="margin:0 0 12px;font-size:${size}px;line-height:1.3;color:#111827">${escapeHtml(block.text)}</h${block.level}>`,
        text: block.text,
      };
    }
    case 'paragraph':
      return {
        html: `<p style="${TEXT_STYLE}">${escapeMultiline(block.text)}</p>`,
        text: block.text,
      };
    case 'image':
      return {
        html: `<p style="margin:0 0 16px"><img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.alt)}" width="${block.width}" style="${IMAGE_STYLE};width:${block.width}px;max-width:100%"></p>`,
        text: `[image] ${block.url}${block.alt ? ` (${block.alt})` : ''}`,
      };
    case 'imageText': {
      const imageCell = `<td width="${block.imageWidth}" valign="top" style="width:${block.imageWidth}px;padding:0 ${block.side === 'left' ? '16px' : '0'} 0 ${block.side === 'right' ? '16px' : '0'}"><img src="${escapeHtml(block.imageUrl)}" alt="${escapeHtml(block.alt)}" width="${block.imageWidth}" style="${IMAGE_STYLE};width:${block.imageWidth}px;max-width:100%"></td>`;
      const textCell = `<td valign="top" style="font-size:15px;line-height:1.6;color:#1f2937">${escapeMultiline(block.text)}</td>`;
      return {
        html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>${block.side === 'left' ? imageCell + textCell : textCell + imageCell}</tr></table>`,
        text: `${block.text}\n\n[image] ${block.imageUrl}${block.alt ? ` (${block.alt})` : ''}`,
      };
    }
    case 'button':
      return {
        html: `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td bgcolor="#2563eb" style="background-color:#2563eb;border-radius:6px"><a href="${escapeHtml(block.url)}" rel="noopener noreferrer nofollow" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(block.label)}</a></td></tr></table>`,
        text: `${block.label}: ${block.url}`,
      };
    case 'divider':
      return {
        html: '<hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0">',
        text: '---',
      };
  }
}

export function renderEmailBlocks(blocks: EmailBlock[]): { html: string; text: string } {
  const rendered = blocks.map(renderBlock);
  return {
    html: rendered.map((part) => part.html).join('\n'),
    text: rendered.map((part) => part.text).join('\n\n'),
  };
}

export interface EmailDocumentOptions {
  heading: string;
  intro?: string;
  blocks: EmailBlock[];
  action?: { label: string; url: string };
  /** Repeat the action URL as a copyable link (transactional mails). */
  fallbackUrl?: boolean;
  footer?: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Full e-mail document (HTML + plain-text alternative) around a block list.
 * Table layout and inline styles only; no `<style>` block, no external assets.
 */
export function renderEmailDocument(options: EmailDocumentOptions): { text: string; html: string } {
  const blocks = renderEmailBlocks(options.blocks);
  const introHtml = options.intro ? `<p style="${TEXT_STYLE}">${escapeMultiline(options.intro)}</p>` : '';
  const actionHtml = options.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td bgcolor="#2563eb" style="background-color:#2563eb;border-radius:6px"><a href="${escapeHtml(options.action.url)}" rel="noopener noreferrer nofollow" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(options.action.label)}</a></td></tr></table>`
    : '';
  const fallbackHtml =
    options.fallbackUrl && options.action
      ? `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280">If the button does not work, copy this link into your browser:</p><p style="margin:0 0 20px;font-size:13px;line-height:1.5;word-wrap:break-word"><a href="${escapeHtml(options.action.url)}" rel="noopener noreferrer nofollow" style="color:#2563eb">${escapeHtml(options.action.url)}</a></p>`
      : '';
  const footerHtml = options.footer
    ? `<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:#9ca3af">${escapeHtml(options.footer)}</p>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.heading)}</title></head>
<body style="margin:0;padding:0;background-color:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6" style="background-color:#f3f4f6;padding:24px 12px;font-family:${FONT}">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:8px;padding:32px">
<tr><td>
<h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;color:#111827">${escapeHtml(options.heading)}</h1>
${introHtml}
${blocks.html}
${actionHtml}
${fallbackHtml}
${footerHtml}
</td></tr></table>
</td></tr></table>
</body>
</html>`;

  const text = [
    options.heading,
    options.intro ?? '',
    blocks.text,
    options.action ? `${options.action.label}: ${options.action.url}` : '',
    options.footer ?? '',
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n\n');

  return { text, html };
}
