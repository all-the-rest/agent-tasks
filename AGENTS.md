# Agent Tasks — project rules

Put directory-specific rules in that directory's `AGENTS.md`. Plans in `docs/plans/` begin with `**Status:** Plan | In Arbeit | Done | Empfehlung, nicht implementiert`.

## Verification commands

`pnpm install --frozen-lockfile`; `pnpm lint`; `pnpm -r typecheck`; `pnpm test:unit`; `TEST_DATABASE_URL=postgres://agent@127.0.0.1:55432/agent_tasks pnpm test:integration`; `pnpm --filter @agent-tasks/web test`; `pnpm exec playwright test` (Compose required); `docker compose config -q`.

## Gates and security

- Install pinned Ratchet 0.6.3 via `scripts/install-ratchet.sh`; hook/CI reject other versions. Pre-commit runs `ratchet check` including `agent-rules`; baseline only decreases.
- No `TODO`/`FIXME`/`XXX` in shipped source, `any`, `dangerouslySetInnerHTML`, or source secrets. Sanitize reports with `rehype-sanitize`; encrypt provider keys at rest with AES-256-GCM.
- Private task/execution/report/memory/credential reads and writes, including background execution, are owner-scoped; public share links expose only their token-authorized snapshot. Admins cannot access other users' private data.
- Chromium is non-root/read-only, has no Docker socket, drops all capabilities except sandbox-required `CAP_SYS_CHROOT`, and can egress only through the proxy.
- Docs-only changes skip CI; the pre-commit hook still scans staged files for secrets and runs ratchet, plus lint/typecheck for code.

## Conventions

- Strict TypeScript pnpm monorepo: `apps/{api,web,worker}`, `services/browser-runner`, `packages/*`. Production inference is OpenAI-compatible; Ollama is development-only, not in Compose.
- E-mail DSL: `packages/shared/src/email-dsl.ts`; UI/HTML builder: `email-blocks.ts`; agent tools: `compose_email` and `add_email_block`.
- User docs: `README.md`, `docs/USER_GUIDE.md`, `docs/email-dsl.md`; screenshots: `docs/images/` via `scripts/capture-readme-screenshots.mjs`; evidence: `docs/VERIFICATION_REPORT.md`.

## Agent rules

- Use `codegraph explore` before code grep/read; pre-commit refreshes the index. If CodeGraph reports disabled/recovering or stale files, read those files directly. Follow global/harness rules: questions via `question`, long work in background, no PASS without evidence.
- Commit messages end with `Verify:` naming gates actually run (`ratchet check`, `pnpm test:unit`, CI).
