import type { ExecutionReport } from './schemas.js';

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
