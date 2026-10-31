# Results, reports and exports

_Labels: none_

## Acceptance criteria

- [x] Execution metadata, tool-call timeline, sources, Markdown report, usage, sanitized errors
- [x] Markdown + JSON export with `Content-Disposition: attachment`
- [x] Clickable sources with retrieval timestamps and confidence
- [x] No invented links: sources come from tool results only
- [x] Historical comparison through the execution list per task

## Evidence

`apps/api/src/routes/tasks.ts` (detail + export), `packages/shared/src/report.ts`,
`apps/web/src/pages/ExecutionDetailPage.tsx`.
