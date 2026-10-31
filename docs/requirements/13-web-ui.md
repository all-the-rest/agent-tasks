# Web UI: pages, accessibility, i18n (en/de), daisyUI

_Labels: none_

## Acceptance criteria

- [x] Login, setup, invite, dashboard, tasks, task editor, scheduling, executions, execution detail, settings, admin (users, providers, audit, monitoring)
- [x] Responsive layout, daisyUI components, Tailwind v4
- [x] Full English and German catalogues on Lingui 6 (gettext PO files), language persisted locally
- [x] Accessible controls, labels, loading/error/empty states
- [x] Markdown report rendered sanitized
- [ ] E2E against the real API — covered by the Playwright suite in CI, not yet run locally

## Notes

The translation runtime follows the operator's reference stack (Lingui, Tiptap),
not i18next. The prompt fields stay plain Markdown text areas on purpose: prompts go
to a language model, so a rich-text editor would add escaping noise without value.

## Evidence

`pnpm --filter @agent-tasks/web build` and `typecheck` exit 0; 15 UI unit tests.
