# AI providers: Ollama, OpenAI-compatible (OpenCode Go contract), mock endpoint

_Labels: testing_

## Goal

A provider-neutral interface where local inference works without any paid subscription.

## Acceptance criteria

- [x] Ollama adapter: model discovery, capability check, tool calling, timeouts, clear errors
- [x] A model without the `tools` capability is refused instead of silently degraded
- [x] OpenAI-compatible adapter with configurable base URL, extra headers and timeouts
- [x] Sends an honest `User-Agent` and a stable `x-opencode-session` per conversation (OpenCode Go requirements)
- [x] Records `opencode.allowance` usage where the endpoint reports it
- [x] Model tool support is declared, never assumed
- [x] `packages/mock-openai`: a real HTTP server that enforces the client contract
- [x] Credentials are per-user or explicitly shared; never sent to the browser runner

## Evidence

`packages/ai-providers/test/openai-compatible.test.ts` drives the adapter against the mock
server: tool calls, usage, allowance, 401 mapping, generic User-Agent rejected, missing session
header rejected.

Execution scope: the worker's only task backend is the isolated OpenCode runtime and only
`openai-compatible` providers execute tasks. The Ollama adapter is kept for local development
and adapter tests; an `ollama` provider is refused at task creation/update/run with a clear
400 instead of being silently mapped to another adapter (see
`docs/architecture/providers.md`). Tool capability is enforced through the persisted provider
catalog plus explicit `config.models` overrides: a task that needs research or memory
is refused before provisioning when the model is not marked tool-capable.

Open question: a real Ollama run needs model hardware and is not executed in this
environment (see VERIFICATION_REPORT).
