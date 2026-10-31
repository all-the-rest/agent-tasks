# Strict multi-user isolation and horizontal authorization

_Labels: security_

## Goal

No user can reach another user's tasks, executions, reports, logs, artifacts or
credentials — by id, body, or role.

## Acceptance criteria

- [x] Every query is scoped with `owner_id = session.user.id`
- [x] Client-supplied `ownerId`/`id` is ignored on create
- [x] Malformed ids return 404 instead of a database error
- [x] Administrator role grants no access to user tasks, executions or credentials
- [x] Personal provider credentials are per-owner; a shared credential is explicit
- [x] Background execution re-derives ownership from the task row

## Evidence

`test/integration/isolation.test.ts` (8 tests): cross-user read/write/run/pause, execution
read/cancel/export/history, admin bypass attempts, credential isolation, forged owner ids,
last-admin guard, revoked invitation.
