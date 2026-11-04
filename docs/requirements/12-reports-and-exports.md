# Results, reports and exports

_Labels: none_

## Acceptance criteria

- [x] Execution metadata, tool-call timeline, sources, Markdown report, usage, sanitized errors
- [x] Markdown + JSON export with `Content-Disposition: attachment`
- [x] Clickable sources with retrieval timestamps and confidence
- [x] No invented links: sources come from tool results only
- [x] Historical report comparison in execution details, linked to the previous execution

## Evidence

`apps/api/src/routes/tasks.ts` (detail + export), `packages/shared/src/report.ts`,
`apps/web/src/pages/ExecutionDetailPage.tsx`,
`apps/web/test/execution-detail.test.tsx`, `apps/web/test/markdown-safety.test.tsx`,
`packages/shared/test/report.test.ts`.
