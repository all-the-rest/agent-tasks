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

Model discovery calls `GET {baseUrl}/models` and stores every returned id in
`provider_models`; that table is the persisted catalog the API, worker and
provisioner read. `config.models[]` (at most 200 entries) carries administrator
metadata on top of it, for example `{ "id": "my-model", "supportsTools": true }`:
an entry overrides the discovered label, context length and tool capability, and
an id that discovery did not return is usable as a declared-only model. If
`/models` is missing or empty and `config.models` is declared, refresh keeps the
declared list instead of failing with `unavailable`. The merged view is what
`GET /api/providers` and `GET /api/admin/providers` return as `models`; the
persisted rows are never treated as the only source and the declared metadata is
never lost on a later refresh.

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

Precedence: built-in defaults, then `config.headers`, then the **contract headers**.
`user-agent`, `authorization`, `openai-organization` and the session header always
win over extra headers: a spoofed generic User-Agent or a rotated session id is
rejected by OpenCode Go, so the adapter never lets `config.headers` replace them.
Extra headers may still override `content-type` and `accept`.

### Official OpenCode Go client requirements

The [Go documentation](https://opencode.ai/docs/go/) asks every client to:

1. send typical coding-agent traffic;
2. **identify itself with its own User-Agent** (for example `my-coding-agent/1.0`),
   never a generic SDK or HTTP-library name; and
3. **send a stable session id in `x-opencode-session` for each conversation**, so
   routing and prompt caching can be optimised.

The adapter enforces all three mechanically:

- `compatibleConfigSchema` rejects generic agents (`node`, `undici`, `axios`,
  `openai-node`, `python-requests`, `okhttp`, `curl`, `wget`, `go-http-client`,
  `node-fetch`) and requires a non-empty session header.
- `buildHeaders()` always emits the configured tool User-Agent and the
  session header, including for **auxiliary requests**: model discovery uses
  `discovery`, health checks use `health`, and every chat turn reuses the
  execution's conversation id. `config.headers` cannot override either.
- An empty or whitespace-only session id is a typed error rather than a request
  with a missing header.

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

Tool support is **explicit metadata, never inferred**. `refresh models` stores every
id returned by `/models` with `supportsTools: false`, because the OpenAI `/models`
route carries no capability information. A model becomes tool-capable only when
`config.models[]` declares `supportsTools: true`; an absent, `false` or non-boolean
value is not capability, and the discovery flag alone never enables tools.

Admin → Providers shows a toggle per catalog model (**Enable tools** / **Disable
tools**) that writes exactly this declaration into `config.models` without losing
the model's label or context length. Tasks that use web research, e-mail
composition or any memory mode except `off` require tools: the API refuses to
create or execute such a task with HTTP 400 (`model <id> is not marked
tool-capable on provider <name>`), the worker repeats the check before it
provisions a runtime, the isolated runner repeats it again, and the provisioner
refuses a tool bridge for a model that is not explicitly capability-flagged. A
task with no tool requirements still runs on a tool-less model; nothing silently
drops a requested tool capability. Declared models also serve as the fallback when
`/models` is unavailable.

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

Provider error text is passed through `redact()` before it is stored. An execution
whose task requires tools on a model without the explicit capability fails with a
typed `unsupported` error before a runtime is provisioned, instead of being
silently downgraded.

### Register the provider

UI: **Admin → Providers → Add provider**, kind `openai-compatible`, base URL as
above, save, add the credential, refresh models, then mark the models that really
support tools. The UI form exposes the base URL and the per-model tool toggle; the
other config fields (User-Agent, session header, extra headers, stream, free-form
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

### Supported execution kinds

The worker executor accepts only `openai-compatible`. Any other provider kind fails
the execution explicitly instead of being mapped to another adapter; there is no
fallback execution path. The API rejects task creation, an execution-relevant
update (`providerId`, `model`, prompt, schedule, limits, tools) and a manual run on
such a provider with HTTP 400 (`provider kind <kind> is not supported for task
execution`). The same validation runs whenever an update changes an
execution-relevant field (`providerId`, `model`, `allowWebResearch`,
`notification` or `memorySettings`), using the resulting task's effective values.
The task editor lists only executable providers and explains the
filter; the admin and settings views still show every provider, marked
`executable: false`, so existing credentials and provider rows remain visible and
nothing is deleted or rewritten. A title-only update of a task that already points
at an unsupported kind keeps working. For OpenAI, create a provider with kind
`openai-compatible` and base URL `https://api.openai.com/v1`.

### Model variants (suffix)

Tasks and the seeded model may append a variant to the model id, for example
`kimi-k3#high`. Supported variants are `none`, `minimal`, `low`, `medium`,
`high` and `xhigh`. The suffix is stripped before any catalog or wire lookup:
the base id must be declared on the provider, and the variant is sent as
`reasoning_effort: <variant>`; an unknown suffix is rejected before any request
with a typed `unsupported` error. Variants are opt-in: providers that do not
accept `reasoning_effort` may reject the request.

The isolated OpenCode path preserves this contract. The worker splits the
selection locally, validates the base id against the provider catalog, and sends
the provisioner `{ id, variant }` separately. The provisioner matches the base id
exactly, declares all six variants on the runtime model (each mapped to its
`reasoning_effort`), and returns the variant it accepted; the client rejects a
response that drops or rewrites it, and the runner refuses to start when the
runtime's model selection does not match the task. OpenCode 2.2.5 exposes only a
provider-dependent subset of variants without those declarations, so omitting
them would fail `none`, `minimal` or `xhigh` at run time.

### Agent e-mail blocks

Completion mails are composed with the `compose_email` tool and the compact
[e-mail DSL](../email-dsl.md); rendering lives in `packages/shared/src/email-blocks.ts`.

### No environment-seeded provider

Inference providers are **not** seeded from the environment. The admin UI/API is
the only write path: an administrator creates the shared OpenCode Go connection,
stores the key through `POST /api/admin/providers/<id>/credentials` (encrypted
with `SECRETS_ENCRYPTION_KEY`) and refreshes the model catalog. Nothing in a
deployment `.env` carries an inference secret, and every create/rotate/delete is
auditable. A fresh deployment therefore starts with zero providers until an
administrator configures one.

## Ollama (optional, legacy)

The adapter remains in `packages/ai-providers` for local development: models come
from `/api/tags`, tool support from `/api/show`, and a model without the `tools`
capability is refused unless `requireToolSupport` is `false`. It is not used in the
production deployment, the compose stack does not ship it, and this repository
pulls no model. The worker executor rejects `ollama` providers instead of falling
back to this adapter.

## Codex (experimental, disabled by default)

There is no officially supported way to use a personal ChatGPT subscription as shared
multi-user inference. What exists is the Codex CLI with account-scoped sign-in and
noninteractive `codex exec`.

The adapter therefore:

- refuses to run unless `AGENT_TASKS_ENABLE_CODEX=1` **and** the provider record has
  `config.enabled: true`,
- reads `codexHome` from the provider record and passes it as
  `CODEX_HOME`/`HOME`; callers are responsible for giving each owner a private
  absolute directory,
- never reads browser cookies and never calls undocumented endpoints,
- cannot perform tool calls (the CLI is a text interface) and says so instead of
  inventing research.

The worker no longer resolves a per-user Codex home and accepts only the
`openai-compatible` provider kind, so no task can execute through Codex. The
adapter stays available for admin health checks and the library tests; its former
worker settings (`CODEX_HOME_ROOT`, `CODEX_ISOLATED_RUNNER`) and the worker's
`codex-homes` mount were removed. The named volume is intentionally kept so
existing data is not destroyed by an upgrade. Until a documented,
account-scoped, multi-user-safe interface is verified, this adapter stays
experimental and is not a fallback.

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
  fallback. It also asserts the official contract on **every** request (chat,
  model discovery and health): a non-generic tool User-Agent and a non-empty
  `x-opencode-session`; extra headers cannot spoof either; an empty session id is
  refused. `packages/shared/test/schemas.test.ts` rejects generic User-Agents and
  an empty session header at configuration time.

Both endpoints enforce the documented client contract; a generic User-Agent or a
missing session header is rejected with `400`.

No OpenCode Go account was available in the verification environment. By operator
decision, a contract-enforcing fake API is sufficient for this goal; the adapter is
tested against it, including both mandatory headers. Real-account behaviour (actual
models, quotas, allowance values and provider-specific errors) remains
**NOT VERIFIED**.
