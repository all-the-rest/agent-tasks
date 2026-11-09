# Web UI: pages, accessibility, i18n (en/de), daisyUI

_Labels: none_

## Acceptance criteria

- [x] Login, setup, invite, dashboard, tasks, task editor, scheduling, executions, execution detail, settings, admin (users, providers, audit, monitoring)
- [x] Responsive layout, daisyUI components, Tailwind v4
- [x] Full English and German catalogues on Lingui 6 (gettext PO files), language persisted locally
- [x] Accessibility verified across all pages and loading/error/empty states (desktop/mobile route-state screenshot matrix with DOM checks; focused page-state, keyboard and feedback tests; light/dark WCAG AA semantic-color matrix)
- [x] Markdown report rendered sanitized
- [x] E2E against the real API — authenticated local Playwright passed 11/11 against the API/Vite stack using only a test-only fake runtime/provider; no live provider was contacted. CI run `41742072347` is historical for parent `18725fb`.

## Notes

The translation runtime follows the operator's reference stack (Lingui, Tiptap),
not i18next. The prompt fields stay plain Markdown text areas on purpose: prompts go
to a language model, so a rich-text editor would add escaping noise without value.

## Evidence

Current local verification: the full web suite passes 171/171 tests across
28 files, including interactive-role accessible-name and recovery/retry checks,
administrator/standard-user navigation, global layout landmarks and skip link,
drawer/dialog keyboard behavior, and page loading/error/empty/filled states.
Task detail data (task, history, conversation, memory and recommendation)
and execution detail (current report, comparison and memory review) failure paths
have retry coverage; task and execution infinite-list background refresh errors
retain loaded rows and expose a retry action. The screenshot harness verifies
visible control names, a single main landmark and named level-one heading, form
control names, image alt attributes, non-empty live announcements, and no
focusable control inside aria-hidden content before capturing each route/state.
The full matrix passed **52 captures with 52 intentional viewport skips**; its
144 full-page and section artifacts were visually reviewed, with the affected
screens recaptured and rechecked after fixes. The web build, monorepo lint,
workspace typecheck and unit tests (**600 passed, 4 skipped**) pass. Vite reports
a 916.48 kB minified JavaScript chunk (260.12 kB gzip), above its advisory size
limit. The light/dark WCAG AA semantic-color matrix passes 2/2. The serial web
test run is required for browser-history/pagination tests whose setup can exceed
the default 5-second timeout.
The current-tree authenticated Playwright suite passed 11/11 against a fresh local
PostgreSQL database, the local API/Vite stack and a test-only fake runtime/provider.
The current screenshot matrix also passed 52/52 actual route/viewport captures;
its 52 other project cases were intentional viewport skips. Compose verification
with Mailpit and Search profiles passed **11/11**; scoped cleanup of the isolated
`agent-tasks-e2e-review` project was verified. Production deployment and live-provider
verification remain excluded. CI run `41742072347` covers only parent `18725fb`.
