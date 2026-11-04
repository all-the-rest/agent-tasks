# Agent runtime: validated tools, limits, structured results

_Labels: security_

## Goal

A real execution loop that researches instead of answering from memory.

## Acceptance criteria

- [x] Tools: `search_web`, `open_url`, `extract_page_text`, `inspect_page`, `click_element`, `fill_form`, `navigate_back`, `get_page_title`, `get_current_url`, `extract_links`
- [x] No shell, no arbitrary JavaScript, no file system access
- [x] Every call validated against a schema and an allowlist; unknown tools are refused
- [x] Administrator-configured global limits enforced per step, tool call, page visit, search query, output size, duration; defaults use finite hard maxima
- [x] Retrieved content wrapped as untrusted data
- [x] Sources collected, deduplicated and persisted with confidence labels
- [ ] Final answer stored as Markdown with summary, sources and uncertainty
  (partial: summary and sources are stored; the runtime records uncertainty for
  unverified citation links, but does not extract model-authored uncertainty prose)

## Evidence

`packages/agent-runtime/test/runtime.test.ts`,
`apps/worker/test/opencode-tool-bridge.test.ts`,
`test/integration/execution-budget.test.ts` and the execution integration tests.
