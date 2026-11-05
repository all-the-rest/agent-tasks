# Web research with a configurable, documented search backend

_Labels: none_

## Goal

Actual discovery and page reading, not model recall.

## Acceptance criteria

- [x] SearXNG JSON adapter (self-hosted, no commercial key) with a composable interface
- [x] Fixture and no-op providers for deterministic tests
- [x] Visited URLs, timestamps, titles and excerpts recorded per execution
- [x] Inaccessible pages reported honestly as errors, not invented content
- [x] Domain/redirect validation in the browser layer
- [x] Enforce robots.txt for main-frame navigations; site terms of service remain an operator responsibility (`docs/security/browser-isolation.md`)
- [x] Captcha/paywall bypass — explicitly out of scope

## Evidence

`packages/browser-tools/src/search.ts`, `test/integration/execution.test.ts` (real page fetch),
`docker/searxng/settings.yml`.
