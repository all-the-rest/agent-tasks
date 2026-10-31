/** Minimal, dependency-free transactional e-mail templates. */

export interface EmailContent {
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface ActionEmailOptions {
  heading: string;
  paragraphs: string[];
  actionLabel: string;
  actionUrl: string;
  footer?: string;
}

/**
 * Renders a multi-part transactional mail: a plain-text fallback plus a simple
 * table-based HTML body with inline styles (safe in every mainstream client).
 * Every interpolated value is escaped; only `actionUrl` is used as an href, so a
 * caller must pass a trusted, server-generated URL.
 */
export function renderActionEmail(options: ActionEmailOptions): EmailContent {
  const text = [options.heading, '', ...options.paragraphs, '', `${options.actionLabel}: ${options.actionUrl}`, options.footer ? `\n${options.footer}` : ''].join('\n');

  const paragraphs = options.paragraphs.map((paragraph) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1f2937">${escapeHtml(paragraph)}</p>`).join('');
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.heading)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;padding:32px">
<tr><td>
<h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;color:#111827">${escapeHtml(options.heading)}</h1>
${paragraphs}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="border-radius:8px;background:#2563eb">
<a href="${escapeHtml(options.actionUrl)}" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(options.actionLabel)}</a>
</td></tr></table>
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280">If the button does not work, copy this link into your browser:</p>
<p style="margin:0 0 20px;font-size:13px;line-height:1.5;word-break:break-all"><a href="${escapeHtml(options.actionUrl)}" style="color:#2563eb">${escapeHtml(options.actionUrl)}</a></p>
${options.footer ? `<p style="margin:0;font-size:12px;line-height:1.5;color:#9ca3af">${escapeHtml(options.footer)}</p>` : ''}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { text, html };
}
