# Task management, scheduling presets and timezone/DST correctness

_Labels: none_

## Goal

Complete task lifecycle with timezone-aware schedules that survive DST changes.

## Acceptance criteria

- [x] Task fields: title, description, prompt, system instructions, provider, model, enabled, schedule, timezone, limits, research permission, notification preference
- [x] CRUD, pause/resume, run-now, duplicate, execution history
- [x] Presets: once, daily, selected weekdays, weekly, monthly, custom cron
- [x] Timestamps stored in UTC; schedule evaluated in the task's IANA zone
- [x] Spring-forward gap: a 02:30 job runs at 03:30 local instead of being dropped
- [x] Fall-back overlap: the job runs once, at the first (CEST) instant
- [x] Limits are capped by hard maxima and enforced in the agent loop

## Evidence

- `packages/shared/test/schedule.test.ts` (DST cases with fixed instants, Europe/Vienna).
- `apps/api/src/routes/tasks.ts`, `packages/shared/src/schedule.ts`.
