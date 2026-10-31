import { renderEmailDocument } from '@agent-tasks/shared';

export interface EmailContent {
  text: string;
  html: string;
}

export interface ActionEmailOptions {
  heading: string;
  paragraphs: string[];
  actionLabel: string;
  actionUrl: string;
  footer?: string;
}

/**
 * Transactional mail (reset, verification, invitation) rendered with the shared
 * internal HTML builder. Every interpolated value is escaped; only `actionUrl` is
 * used as an href, so a caller must pass a trusted, server-generated URL.
 */
export function renderActionEmail(options: ActionEmailOptions): EmailContent {
  return renderEmailDocument({
    heading: options.heading,
    blocks: options.paragraphs.map((text) => ({ type: 'paragraph' as const, text })),
    action: { label: options.actionLabel, url: options.actionUrl },
    fallbackUrl: true,
    footer: options.footer,
  });
}
