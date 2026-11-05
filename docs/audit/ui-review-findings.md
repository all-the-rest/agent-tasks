# UI Review Findings — Agent Tasks — 2026-11-05

Capture: `pnpm test:screenshots` · output: `test-results/ui-screenshots/`
Verdict: **APPROVED** — all findings below are fixed and recaptured; no open
critical or high findings remain.

The desktop/mobile visual matrix completed with **52 passed, 52 intentionally
skipped**. The current-tree matrix also completed with **52 passed, 52
intentionally skipped**, running DOM accessibility checks before each capture.
The 144 full-page and section captures were reviewed. The setup, registration-
disabled, and invalid-share screens were recaptured and visually rechecked after
the latest fixes. Historical UI-001–004 rows cite archived before/after captures;
UI-005–006 list their final captures (pre-fix images were not separately archived).

## Filled · Desktop

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| UI-001 | medium | fixed | — | — | `apps/web/src/pages/MemoryPage.tsx:74` | Before: `/tmp/opencode/agent-tasks-ui-review-before/filled/desktop/memory-task-filled.png`; after: `test-results/ui-screenshots/filled/desktop/memory-task-filled.png`, `test-results/ui-screenshots/filled/mobile/memory-task-filled.png` | Desktop showed the slash-command toolbar twice: in the shared application header and again in the Memory page. | Keep the page-level command bar on mobile only; desktop uses the shared header bar. |
| UI-005 | medium | fixed | — | — | `apps/web/src/pages/SetupPage.tsx:51–63`; `apps/web/src/pages/RegisterPage.tsx:62–74` | `test-results/ui-screenshots/filled/{desktop,mobile}/setup.png`; `test-results/ui-screenshots/filled/{desktop,mobile}/register.png` | Already-configured setup and registration-disabled screens each showed two identical “Back to sign in” actions. | Keep the prominent button as the single recovery action. |
| — | — | — | — | — | — | `test-results/ui-screenshots/filled/desktop/` | No other desktop defects found in this pass. | — |

## Filled · Mobile

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| UI-002 | medium | fixed | — | — | `apps/web/src/pages/AdminUsersPage.tsx:106,132` | Before: `/tmp/opencode/agent-tasks-ui-review-before/filled/mobile/admin-users.png`; after: `test-results/ui-screenshots/filled/mobile/admin-users.png` | Long user names and the users table could force the Admin Users content wider than the mobile viewport. | Constrain the card and table name column at mobile widths; preserve the larger name column at wider breakpoints. |
| UI-003 | medium | fixed | — | — | `apps/web/src/pages/ExecutionDetailPage.tsx:172–175,315–321` | Before: `/tmp/opencode/agent-tasks-ui-review-before/filled/mobile/execution-detail.png`; after: `test-results/ui-screenshots/filled/mobile/execution-detail.png`, `test-results/ui-screenshots/filled/mobile/execution-detail-sec1.png` | The execution summary displayed raw Markdown markers instead of formatted content. | Render the summary through the existing provenance check and sanitized Markdown renderer. |
| UI-004 | medium | fixed | — | — | `apps/web/src/pages/TasksPage.tsx:278–290` | Before: `/tmp/opencode/agent-tasks-ui-review-before/filled/mobile/task-list.png`; after: `test-results/ui-screenshots/filled/mobile/task-list.png`, `test-results/ui-screenshots/empty/mobile/task-list.png` | The task search control was compressed beside the other filters, clipping the entered query on mobile. | Give search its own full-width mobile grid row; return it to the inline desktop layout at `sm`. |
| UI-005 | medium | fixed | — | — | `apps/web/src/pages/SetupPage.tsx:51–63`; `apps/web/src/pages/RegisterPage.tsx:62–74` | `test-results/ui-screenshots/filled/{desktop,mobile}/setup.png`; `test-results/ui-screenshots/filled/{desktop,mobile}/register.png` | Already-configured setup and registration-disabled screens each showed two identical “Back to sign in” actions. | Keep the prominent button as the single recovery action. |
| — | — | — | — | — | — | `test-results/ui-screenshots/filled/mobile/` | No other mobile defects found in this pass. | — |

## Empty · Desktop

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| UI-006 | medium | fixed | — | — | `apps/web/src/pages/SharePage.tsx:113–131` | `test-results/ui-screenshots/empty/{desktop,mobile}/share-invalid.png` | Invalid/revoked share links showed the right 404 explanation alongside a generic load-failure alert and retry that could not recover the link. | Keep the unavailable explanation; reserve retry feedback for transient errors. |

## Empty · Mobile

| Id | Severity | Status | Owner | Ticket | File:Line | Screenshot | Finding | Suggested fix |
|----|----------|--------|-------|--------|-----------|------------|---------|---------------|
| — | — | — | — | — | — | `test-results/ui-screenshots/empty/mobile/task-list.png` | No additional defect; the task-search finding is consolidated as UI-004 under Filled · Mobile. | — |
| UI-006 | medium | fixed | — | — | `apps/web/src/pages/SharePage.tsx:113–131` | `test-results/ui-screenshots/empty/{desktop,mobile}/share-invalid.png` | Invalid/revoked share links showed the right 404 explanation alongside a generic load-failure alert and retry that could not recover the link. | Keep the unavailable explanation; reserve retry feedback for transient errors. |

## Open follow-ups

- No open visual follow-ups. Structured-uncertainty extraction remains separately
  deferred in `docs/audit/requirements-coverage.md`.
