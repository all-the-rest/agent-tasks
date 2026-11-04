# Repository, license, workspace layout and CI

_Labels: deploy_

## Goal

A public, Apache-2.0 TypeScript monorepo under `all-the-rest/agent-tasks` with a pnpm
workspace, reproducible builds and CI that fails on a red gate.

## Acceptance criteria

- [x] pnpm workspace with `apps/{web,api,worker}`, `services/browser-runner`, `packages/{shared,database,ai-providers,agent-runtime,browser-tools,mock-openai}`
- [x] Shared versions through a pnpm catalog instead of duplicated semver ranges
- [x] Apache-2.0 license, README, CHANGELOG, CONTRIBUTING
- [x] Strict TypeScript, `pnpm typecheck` for every project
- [x] ESLint flat config, `pnpm lint`
- [x] GitHub Actions: lint, typecheck, unit, integration (Postgres service), browser E2E, image build, Trivy, gitleaks
- [x] Repository-local hooks (`.githooks/pre-commit`): secret scan, ratchet gates, lint, typecheck, codegraph sync
- [x] `ratchet` quality gates with a committed baseline

## Evidence

```
pnpm typecheck   # 10 projects, exit 0
pnpm lint        # exit 0
ratchet check    # 11 of 11 gates passed
```

Workflows: `.github/workflows/ci.yml`.
