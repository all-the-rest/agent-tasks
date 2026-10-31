## Summary

<!-- What changes, and why? Link the requirement or issue. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behaviour change)
- [ ] Documentation
- [ ] CI, build or deployment

## What changed

<!-- Bullet points. Mention API, database, UI and compose changes explicitly. -->

-

## Testing

<!-- Exact commands and results. New behaviour needs new tests. -->

- [ ] `pnpm lint`
- [ ] `pnpm -r typecheck`
- [ ] `pnpm test:unit`
- [ ] `pnpm test:integration` (PostgreSQL 17)
- [ ] `pnpm test:e2e` (running compose stack)

## Checklist

- [ ] No secrets, tokens or personal data in code, logs or fixtures
- [ ] Multi-user isolation preserved (every new query is scoped to its owner)
- [ ] Migrations are additive and idempotent
- [ ] UI strings added to both `apps/web/src/i18n/en.ts` and `de.ts`
- [ ] Documentation updated (`README.md`, `TESTING.md`, `DEPLOYMENT.md`, `docs/`)
- [ ] Commits are signed off and the history is clean

## Deployment notes

<!-- New environment variables, migration order, rollback concerns, image tags. -->
