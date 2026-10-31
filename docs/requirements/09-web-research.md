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
- [ ] Respect robots.txt/tos per site — documented as an operator responsibility, not enforced
- [ ] Captcha/paywall bypass — explicitly out of scope

## Evidence

`packages/browser-tools/src/search.ts`, `test/integration/execution.test.ts` (real page fetch),
`docker/searxng/settings.yml`.
