# Codex / ChatGPT integration: only official, account-scoped paths

_Labels: security_

## Goal

Investigate an officially supported Codex path without turning a personal ChatGPT
subscription into shared multi-user inference.

## Decision

- [x] Adapter exists but is **disabled by default** (`AGENT_TASKS_ENABLE_CODEX=1` + provider flag)
- [x] Account-scoped: per-user `CODEX_HOME`, no shared accounts — enforced by
      refusing the `codex` provider kind for task execution entirely, so no
      execution ever shares an account. The adapter stays a library for admin
      health checks; its worker-side per-user home resolver was removed.
- [x] No browser cookies, no undocumented endpoints, no token extraction
- [x] Text-only: refuses tool calling instead of pretending research happened
- [x] Documented limitation: ChatGPT Go is not OpenAI API credit

## Evidence

`packages/ai-providers/src/codex.ts`, `docs/architecture/providers.md`.
Not verified against a live Codex account in this environment.
