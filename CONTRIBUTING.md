# Contributing

Thanks for taking the time. This project values small, verifiable changes over large
unverifiable ones.

## Setup

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test:unit
```

Integration tests need PostgreSQL; see [TESTING.md](TESTING.md).

## Rules

1. **No secrets in commits.** CI runs gitleaks; the pre-commit hook runs a regex
   secret scan.
2. **Every fix gets a test.** A bug fix without a regression test is incomplete.
3. **Do not weaken a gate to make it green.** If a limit, a policy or a test is wrong,
   change it deliberately and explain why in the commit message.
4. **Owner scoping is not optional.** New endpoints and new queries carry
   `owner_id = session.user.id` unless they are explicitly administrative.
5. **No new capability for the model** without a review of the security section.

## Style

- TypeScript strict, no `any` in new code.
- Zod at every boundary (HTTP input, tool arguments, provider responses).
- Errors are `AppError` with a stable code; user-facing text is not a stack trace.
- Commits: imperative subject, body explains *why*.

## Local hooks

```bash
pnpm hooks:install   # .githooks/pre-commit: secret scan, ratchet gates, lint, typecheck
```

## License

By contributing you agree that your contribution is licensed under Apache-2.0.
