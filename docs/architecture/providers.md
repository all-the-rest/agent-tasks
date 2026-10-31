# Providers

## Contract

`packages/ai-providers` defines one interface (`listModels`, `chat`, `health`). The
agent runtime never knows which vendor answered.

## OpenAI-compatible (primary)

Production inference uses an OpenAI-compatible endpoint: OpenCode Go, the official
OpenAI API or a self-hosted gateway. The adapter implements:

- `POST {baseUrl}/chat/completions`
- `GET {baseUrl}/models`

### Base URL forms

`baseUrl` is required in the provider config (there is no built-in vendor default,
including for `kind: openai`).

| Configured value | Chat URL | Models URL |
| --- | --- | --- |
| `https://opencode.ai/inference/go/openai/v1` (the form used by the tests; confirm with your account) | `…/v1/chat/completions` | `…/v1/models` |
| `https://api.openai.com/v1` | `…/v1/chat/completions` | `…/v1/models` |
| `https://host/v1/chat/completions` | used as-is | `https://host/v1/models` |

A trailing slash is removed. A value ending exactly in `/chat/completions` is used
as-is for chat; that suffix is stripped only for model discovery.

Model discovery calls `GET {baseUrl}/models`. If that route is missing or returns
nothing and `config.models` is declared, the declared list is used; otherwise
refresh fails with `unavailable`. The UI edits only the base URL; declare models
through the API (`config.models[]`, at most 200 entries), for example
`{ "id": "my-model", "supportsTools": true }`.

### Headers

Every request carries:

- `content-type: application/json`
- `accept: text/event-stream` when streaming is on (the default), otherwise
  `application/json`
- `user-agent`: `config.userAgent`, default `agent-tasks/0.1.0`. Use an honest
  client identifier; OpenCode Go asks clients not to impersonate a generic SDK. The
  mock endpoint rejects `undici` with `400`.
- `x-opencode-session` (renameable with `config.sessionHeader`): one stable value
  per execution attempt. The worker uses the browser session id when the task allows
  web research and a random UUID otherwise; every model turn in that attempt reuses
  it. Health checks send `health`, model discovery sends `discovery`.
- any keys in `config.headers`
- `authorization: Bearer <key>` when a credential resolves
- `openai-organization: <org>` when `config.organization` is set

Precedence: built-in defaults, then `config.headers`, then `authorization`,
`openai-organization` and the session header. Custom headers may override
`content-type`, `accept` or `user-agent`, but not the credential or conversation id.

`compatibleConfigSchema` defaults: `headers: {}`, `userAgent: "agent-tasks/0.1.0"`,
`sessionHeader: "x-opencode-session"`, `timeoutMs: 120000`, `stream: true`,
`models: []`.

### Streaming

Streaming is on by default. `chat()` sends `"stream": true` with
`"stream_options": { "include_usage": true }`, parses server-sent events, concatenates
content and tool-call argument fragments, and requires a terminal event (`[DONE]` or
a `finish_reason`). A server that ignores `stream` and answers plain JSON is parsed
as JSON. Set `config.stream: false` through the API to use the JSON path; the UI does
not expose the field.

### Credentials

Provider keys are stored in `provider_credentials` as AES-256-GCM ciphertext under
`SECRETS_ENCRYPTION_KEY` (32 bytes base64). There is no environment variable for a
model API key.

- An administrator can store a shared credential (`owner_id NULL`) through
  `POST /api/admin/providers/:id/credentials` with
  `{ "apiKey": "…", "label": "default" }`.
- A user can store a personal credential through
  `POST /api/providers/:id/credentials`; the worker prefers it over the shared key
  for that user (`resolveCredential`). A shared key is used only when the user has no
  personal one.
- The user-facing provider endpoint exposes only the non-secret `baseUrl` (plus
  model metadata and the `hasCredential`/`hasPersonalCredential` flags). The admin
  view exposes the non-secret config keys and replaces every `config.headers` value
  with `***`. Neither returns a key.
- The worker and API decrypt a key only in the process that calls the provider; the
  browser container never receives it.

### Models and tool calling

`refresh models` stores every id returned by `/models`. A model is marked
`supportsTools: true` only when `config.models[]` declares it; discovered-only ids
are stored as `supportsTools: false`. `chat()` still sends the tool definitions
unless a declared model explicitly says `supportsTools: false`, so the stored flag
is advisory for undeclared models. Declared models also serve as the fallback when
`/models` is unavailable. Providers created through the UI carry `models: []`, so
their discovered models stay advisory until a config update declares them.

### Allowance and usage

If a response contains `opencode.allowance` (number, body) or
`x-opencode-allowance` (number, header), the value is recorded as
`usage.allowanceUsd` for that execution. The body value wins when both are present;
absent, empty or non-numeric values are omitted.

### Error mapping

| Condition | `ProviderError.code` | Worker behaviour |
| --- | --- | --- |
| HTTP `401` | `auth` | execution fails; no retry |
| HTTP `402`, or `403` with an insufficient-balance body | `auth` with an explicit message | execution fails; no retry |
| other HTTP `403` | `auth` | execution fails; no retry |
| HTTP `429` | `rate_limited` (includes `retry-after` when sent) | requeued with backoff, up to 3 attempts |
| HTTP `5xx` | `unavailable` | requeued with backoff, up to 3 attempts |
| other non-2xx (for example `400`, `404`) | `bad_response` | execution fails; message contains status and the first 300 body characters |
| fetch/network failure | `unavailable` | requeued with backoff, up to 3 attempts |
| request timeout/abort | `timeout` | requeued with backoff, up to 3 attempts |

Provider error text is passed through `redact()` before it is stored. A model that
was declared as not tool-capable is refused with `unsupported` instead of being
silently downgraded.

### Register the provider

UI: **Admin → Providers → Add provider**, kind `openai-compatible`, base URL as
above, save, add the credential, refresh models. The UI form exposes the base URL
only; the other config fields (User-Agent, session header, extra headers, stream,
declared models) currently require the API.

API payload:

`POST /api/admin/providers`:

```json
{
  "name": "OpenCode Go",
  "kind": "openai-compatible",
  "config": {
    "baseUrl": "https://opencode.ai/inference/go/openai/v1",
    "userAgent": "agent-tasks/0.1.0",
    "sessionHeader": "x-opencode-session",
    "headers": {},
    "timeoutMs": 120000,
    "stream": true,
    "models": []
  },
  "enabled": true,
  "isDefault": true
}
```

`POST /api/admin/providers/<id>/credentials`:

```json
{ "apiKey": "<key>", "label": "default" }
```

Then `POST /api/admin/providers/<id>/models/refresh` and
`POST /api/admin/providers/<id>/health`.

`kind: openai` uses the same adapter and the same required `baseUrl`; it has no
preconfigured official URL.

## Ollama (optional, legacy)

The adapter remains in `packages/ai-providers` for local development: models come
from `/api/tags`, tool support from `/api/show`, and a model without the `tools`
capability is refused unless `requireToolSupport` is `false`. It is not used in the
production deployment, the compose stack does not ship it, and this repository
pulls no model.

## Codex (experimental, disabled by default)

There is no officially supported way to use a personal ChatGPT subscription as shared
multi-user inference. What exists is the Codex CLI with account-scoped sign-in and
noninteractive `codex exec`.

The adapter therefore:

- refuses to run unless `AGENT_TASKS_ENABLE_CODEX=1` **and** the provider record has
  `config.enabled: true`,
- derives a per-user `CODEX_HOME` at `<CODEX_HOME_ROOT>/<owner-id>` (default root
  `/var/lib/agent-tasks/codex`) and passes it as `CODEX_HOME`/`HOME`; the provider
  record still needs an absolute `codexHome` because the config schema requires one,
  but the worker replaces it per task owner,
- never reads browser cookies and never calls undocumented endpoints,
- cannot perform tool calls (the CLI is a text interface) and says so instead of
  inventing research.

The compose worker is read-only and mounts no writable volume at
`CODEX_HOME_ROOT`, so enabling Codex also requires a volume there. Until a
documented, account-scoped, multi-user-safe interface is verified, this adapter
stays experimental.

## Verification status

The OpenAI-compatible adapter is covered by two deterministic suites:

- `packages/ai-providers/test/openai-compatible.test.ts` against
  `packages/mock-openai`: URL derivation, User-Agent, `x-opencode-session`, extra
  headers, bearer auth, allowance parsing, model discovery and authentication
  failure mapping.
- `packages/ai-providers/test/opencode-go.test.ts` against the local OpenCode Go
  fixture: streaming content and tool-call fragments, the non-streaming JSON path,
  session-id stability, header precedence, `401`/`402`/`403`/`429`/`5xx` mapping,
  malformed SSE, abort handling, base-URL normalisation and the declared-model
  fallback.

Both endpoints enforce the documented client contract; a generic User-Agent or a
missing session header is rejected with `400`.

No OpenCode Go account was available in the verification environment. Real-account
behaviour (actual models, quotas, allowance values and provider-specific errors) is
**NOT VERIFIED**; the contract above is implemented and mock-tested, not live-tested.
