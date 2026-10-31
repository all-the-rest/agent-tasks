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

- `ratchet` is pinned to `.ratchet-version` (`0.6.3`), installed with
  `scripts/install-ratchet.sh`; hook and CI reject other versions.
- `ratchet check` runs on every commit through `.githooks/pre-commit`; the
  `agent-rules` preset is part of `ratchet.config.jsonc`. The baseline may only
  move down.
- No `TODO`/`FIXME`/`XXX` in shipped source: fix it or track an issue.
- No `any`, no `dangerouslySetInnerHTML`; reports render through
  `rehype-sanitize`.
- No secrets in source. Provider keys are AES-256-GCM encrypted at rest.
- Docs-only changes skip CI (`paths-ignore`); the pre-commit hook still scans
  staged files for secrets, runs lint/typecheck for code and the ratchet gates.

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
- User-facing docs: `README.md`, `docs/USER_GUIDE.md`, `docs/email-dsl.md`;
  screenshots in `docs/images/` via `scripts/capture-readme-screenshots.mjs`;
  evidence in `docs/VERIFICATION_REPORT.md`.

## Agent rules

- Use `codegraph explore` before grep/read in this repository (`.codegraph/`
  exists). Keep the index fresh through the pre-commit hook.
- Follow the harness rules in the global `AGENTS.md` (questions via the
  `question` tool, background long-running work, no PASS without evidence).
- Commit messages end with a `Verify:` footer naming the gates that ran
  (`ratchet check`, `pnpm test:unit`, CI run).
