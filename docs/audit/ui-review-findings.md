# UI Review Findings — Agent Tasks — 2026-11-04

Capture: `pnpm test:screenshots` · output: `test-results/ui-screenshots/`
Verdict: **APPROVED** — all findings below are fixed and recaptured; no open
critical or high findings remain.

The full visual matrix completed with **52 passed, 52 intentionally skipped**
after the Memory and Admin Users fixes. A final targeted recapture of the four
affected routes completed with **12 passed, 12 intentionally skipped**. Each
screenshot pair below names the archived pre-fix image that exposed the issue
and its post-fix capture.

## Filled · Desktop

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| UI-001 | medium | fixed | — | — | `apps/web/src/pages/MemoryPage.tsx:74` | Before: `/tmp/opencode/agent-tasks-ui-review-before/filled/desktop/memory-task-filled.png`; after: `test-results/ui-screenshots/filled/desktop/memory-task-filled.png`, `test-results/ui-screenshots/filled/mobile/memory-task-filled.png` | Desktop showed the slash-command toolbar twice: in the shared application header and again in the Memory page. | Keep the page-level command bar on mobile only; desktop uses the shared header bar. |
| — | — | — | — | — | — | `test-results/ui-screenshots/filled/desktop/` | No other desktop defects found in this pass. | — |

## Filled · Mobile

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| UI-002 | medium | fixed | — | — | `apps/web/src/pages/AdminUsersPage.tsx:106,132` | Before: `/tmp/opencode/agent-tasks-ui-review-before/filled/mobile/admin-users.png`; after: `test-results/ui-screenshots/filled/mobile/admin-users.png` | Long user names and the users table could force the Admin Users content wider than the mobile viewport. | Constrain the card and table name column at mobile widths; preserve the larger name column at wider breakpoints. |
| UI-003 | medium | fixed | — | — | `apps/web/src/pages/ExecutionDetailPage.tsx:172–175,315–321` | Before: `/tmp/opencode/agent-tasks-ui-review-before/filled/mobile/execution-detail.png`; after: `test-results/ui-screenshots/filled/mobile/execution-detail.png`, `test-results/ui-screenshots/filled/mobile/execution-detail-sec1.png` | The execution summary displayed raw Markdown markers instead of formatted content. | Render the summary through the existing provenance check and sanitized Markdown renderer. |
| UI-004 | medium | fixed | — | — | `apps/web/src/pages/TasksPage.tsx:278–290` | Before: `/tmp/opencode/agent-tasks-ui-review-before/filled/mobile/task-list.png`; after: `test-results/ui-screenshots/filled/mobile/task-list.png`, `test-results/ui-screenshots/empty/mobile/task-list.png` | The task search control was compressed beside the other filters, clipping the entered query on mobile. | Give search its own full-width mobile grid row; return it to the inline desktop layout at `sm`. |
| — | — | — | — | — | — | `test-results/ui-screenshots/filled/mobile/` | No other mobile defects found in this pass. | — |

## Empty · Desktop

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `test-results/ui-screenshots/empty/desktop/` | No defects found in the reviewed empty desktop captures. | — |

## Empty · Mobile

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `test-results/ui-screenshots/empty/mobile/task-list.png` | No additional defect; the task-search finding is consolidated as UI-004 under Filled · Mobile. | — |
| — | — | — | — | — | — | `test-results/ui-screenshots/empty/mobile/` | No other defects found in the reviewed empty mobile captures. | — |

## Open follow-ups

- None from this visual pass. The broader accessibility audit and structured
  uncertainty extraction remain tracked separately in
  `docs/audit/requirements-coverage.md`.
