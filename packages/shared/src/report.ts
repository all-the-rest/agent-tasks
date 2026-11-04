import type { ExecutionReport } from './schemas.js';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';

/** Strips control characters and caps length — used before text reaches storage or logs. */
export function sanitizeText(value: string, maxLength = 20_000): string {
  // Remove C0 control characters except tab, newline and carriage return. A loop is
  // clearer here than a control-character regex, which linters rightly flag.
  const withoutControl = [...value]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code === 9 || code === 10 || code === 13) return true;
      return code >= 32 && code !== 127;
    })
    .join('');
  return withoutControl.length > maxLength ? `${withoutControl.slice(0, maxLength)}…` : withoutControl;
}

export function emptyReport(summary: string): ExecutionReport {
  return { summary, markdown: summary, sources: [], uncertainty: [] };
}

/** Markdown export of a finished execution, deterministic and free of HTML. */
export function reportToMarkdown(report: ExecutionReport, meta: { title: string; finishedAt: string | null }): string {
  const lines: string[] = [`# ${meta.title}`, ''];
  if (meta.finishedAt) lines.push(`_Generated at ${meta.finishedAt}_`, '');
  lines.push(report.markdown.trim(), '');
  if (report.sources.length > 0) {
    lines.push('## Sources', '');
    for (const source of report.sources) {
      const label = source.title ?? source.url;
      lines.push(`- [${label}](${source.url}) — ${source.confidence}, retrieved ${source.retrievedAt}`);
    }
    lines.push('');
  }
  if (report.uncertainty.length > 0) {
    lines.push('## Uncertainty', '');
    for (const item of report.uncertainty) lines.push(`- ${item}`);
    lines.push('');
  }
  return lines.join('\n');
}

export type ReportChangeStatus = 'first' | 'changed' | 'unchanged' | 'unknown';

/**
 * Compare a report with the previous completed run of the same task.
 *
 * The comparison is deliberately content-based: a run "changes" when its report
 * text differs from the previous one. `first` means the task has no earlier
 * completed run, `unknown` means the earlier run stored no comparable text.
 */
export function reportChangeStatus(
  previousMarkdown: string | null | undefined,
  nextMarkdown: string,
): ReportChangeStatus {
  if (previousMarkdown === null || previousMarkdown === undefined) return 'first';
  const previous = previousMarkdown.trim();
  if (previous.length === 0) return 'unknown';
  return previous === nextMarkdown.trim() ? 'unchanged' : 'changed';
}

/** URL form used for source matching: no fragment, no trailing slash, lower-case host. */
function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export interface ReportLinkCheck {
  /** Markdown with every link not backed by a collected source reduced to its text. */
  markdown: string;
  /** Link targets that were removed because no tool result produced them. */
  removed: string[];
}

/**
 * Keep the report's citations honest: a link may only stay clickable when a tool
 * result actually visited that URL. Unbacked links are reduced to plain text and
 * reported, so a hallucinated source can neither be clicked nor pass as evidence.
 */
export function checkReportLinks(
  markdown: string,
  sources: ReadonlyArray<{ url: string }>,
): ReportLinkCheck {
  const allowed = new Set<string>();
  for (const source of sources) {
    const normalized = normalizedUrl(source.url);
    if (normalized) allowed.add(normalized);
  }
  const removed: string[] = [];
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const definitions = new Map<string, string>();
  visit(tree, 'definition', (node) => {
    definitions.set(node.identifier.toLowerCase(), node.url);
  });
  visit(tree, (node, index, parent) => {
    if ((node.type !== 'linkReference' && node.type !== 'imageReference') || !parent || index === undefined) return;
    const url = definitions.get(node.identifier.toLowerCase());
    const replacement = url
      ? node.type === 'linkReference'
        ? { type: 'link' as const, url, title: null, children: node.children }
        : { type: 'image' as const, url, title: null, alt: node.alt }
      : { type: 'text' as const, value: node.type === 'imageReference' ? (node.alt || 'image') : toMarkdown({ type: 'root', children: node.children } as Root, { extensions: [gfmToMarkdown()] }).trim() || 'source' };
    parent.children.splice(index, 1, replacement);
  });
  visit(tree, (node, index, parent) => {
    if (node.type === 'image') {
      // A page URL is not a trusted image host. Embedding it can leak the
      // report viewer's IP/referrer and load arbitrary remote content. This is a
      // rendering-safety decision, not uncertainty about a cited source link.
      if (parent && index !== undefined) {
        parent.children.splice(index, 1, { type: 'text', value: node.alt || 'image' });
      }
      return;
    }
    if (node.type !== 'link') return;
    const normalized = normalizedUrl(node.url);
    if (normalized && allowed.has(normalized)) return;

    removed.push(node.url);
    if (!parent || index === undefined) return;
    const label = toMarkdown({
      type: 'root',
      children: node.children,
    } as Root, { extensions: [gfmToMarkdown()] }).trim();
    parent.children.splice(index, 1, { type: 'text', value: label || 'source' });
  });
  return {
    markdown: toMarkdown(tree, { extensions: [gfmToMarkdown()] }).trimEnd(),
    removed,
  };
}
