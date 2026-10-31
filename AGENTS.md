# Agent Tasks — project rules

Regeln dieser Ebene. Was nur ein Verzeichnis betrifft, gehört in die `AGENTS.md`
**dieses** Verzeichnisses — sie wird geladen, wenn eine Datei daraus gelesen wird.

Ein Plan in `docs/plans/` beginnt mit
`**Status:** Plan | In Arbeit | Done | Empfehlung, nicht implementiert`.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm -r typecheck
pnpm test:unit
TEST_DATABASE_URL=postgres://agent@127.0.0.1:55432/agent_tasks pnpm test:integration
pnpm --filter @agent-tasks/web test
pnpm exec playwright test          # compose stack required
docker compose config -q
```

## Gates

- `ratchet check` runs on every commit through `.githooks/pre-commit`; the
  `agent-rules` preset is part of `ratchet.config.jsonc`. The baseline may only
  move down.
- No `TODO`/`FIXME`/`XXX` markers in shipped source: a gap is either fixed or
  tracked as an issue, never left in code.
- No `any`, no `dangerouslySetInnerHTML`; reports render through
  `rehype-sanitize`.
- No secrets in source. Provider keys are AES-256-GCM encrypted at rest.
- The pre-commit hook scans staged files for secret-looking strings and runs
  lint/typecheck for code changes.
- Docs-only changes do not start the CI workflow (`paths-ignore`), but the local
  pre-commit hook still scans them and runs the ratchet gates.

## Conventions

- pnpm monorepo: `apps/api`, `apps/web`, `apps/worker`,
  `services/browser-runner`, `packages/*`. TypeScript strict.
- Production inference is OpenAI-compatible (OpenCode Go, OpenAI or a gateway).
  Ollama is development-only and not part of the compose deployment.
- Every read and write is owner-scoped, including background execution; admin
  rights never imply access to another user's data.
- Chromium runs non-root, read-only, without capabilities or the Docker socket;
  the egress proxy is the only way out.
- E-mail blocks: DSL parser in `packages/shared/src/email-dsl.ts`, UI/HTML
  builder in `email-blocks.ts`, agent tools `compose_email`/`add_email_block`.
- User-facing docs: `README.md`, `docs/USER_GUIDE.md`, `docs/email-dsl.md`.
  Screenshots live in `docs/images/` and are regenerated with
  `node scripts/capture-readme-screenshots.mjs`.
- Evidence and open gates: `docs/VERIFICATION_REPORT.md`.

## Agent rules

- Use `codegraph explore` before grep/read in this repository (`.codegraph/`
  exists). Keep the index fresh through the pre-commit hook.
- Follow the harness rules in the global `AGENTS.md` (questions via the
  `question` tool, background long-running work, no PASS without evidence).
- Commit messages end with a `Verify:` footer naming the gates that ran
  (`ratchet check`, `pnpm test:unit`, CI run).
