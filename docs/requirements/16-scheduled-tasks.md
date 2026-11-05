# Scheduled tasks: what we adopt from ChatGPT's "Planen" mode

_Labels: none_
_Status: exploration. **Inspired by**, not a 1:1 rebuild — a capability and UX
reference for our own design._

## 0. What this document is

ChatGPT's **Planen** surface (English product name: *Scheduled*; the German UI
calls the page "Planen") is a good reference for one thing: how to make a
scheduled agent run feel like an inbox instead of a cron table. We use it for
inspiration on flow, vocabulary and the shape of the data — we do **not** rebuild
its screens, copy its copy, or chase feature-for-feature parity.

> **Naming note:** "Planen" here means *scheduled tasks*, not the model's internal
> planning/reasoning mode. The two are unrelated.

Decisions in this document use three markers:

| Marker | Meaning |
| --- | --- |
| **Adopt** | The idea fits our product; we implement it in our own form |
| **Adapt** | The problem is real, the reference solution does not fit our stack; we solve it differently |
| **Skip** | Deliberately out of scope, with the reason recorded |

Where we already have something the reference product lacks — duplicate, the
execution view, per-task memory, the audit trail — the existing feature wins; see
[§5](#5-our-extensions-already-implemented--keep-them). "Inspired by" never means
"downgrade to match".

## 1. Clean-room rules

| Allowed input | Not allowed |
| --- | --- |
| Public help-centre and developer documentation | OpenAI source code, internal specs, leaked prompts |
| Observed UI behaviour (screens, states, labels) | Copying UI text, icons, illustrations, CSS or layout files |
| The user's own account, used as a walkthrough | Decompiled bundles, captured network payloads |
| General scheduling theory (cron, RRULE, DST) | Vendor internals or private APIs |

Screenshots were taken to verify observations. They stay out of the repository —
they are not artefacts, and they show a personal account. Everything below is a
description of behaviour, re-derived in our own words.

## 2. The mental model worth borrowing

A scheduled task = **durable instruction** + **trigger** + **destination** +
**policy**.

```
         ┌──────────────┐         ┌──────────────┐
user ───►│    Task      │────────►│     Run      │──────► Inbox item
         │              │  fires  │              │        (chat or entry)
         │ instructions │         │ status       │
         │ trigger      │         │ steps        │
         │ destination  │         │ sources      │
         │ policy       │         │ usage        │
         └──────┬───────┘         └──────────────┘
                │
      ┌─────────┴─────────┬──────────────┬─────────────┐
  schedule            event         monitoring      manual
 (one-off, RRULE)  (app events)   (diff vs last)   ("run now")
```

Three ideas carry most of the value:

1. **Prompt-first authoring.** You describe the work in a sentence; there is no
   wizard with twelve fields. Scheduling details are secondary.
2. **Results are an inbox, not a log.** A run that found nothing is a different
   state from a run that needs you.
3. **A task is portable.** Its definition can be shared as a snapshot; its data
   (history, memory, credentials) never travels with it. Its destination can be a
   standalone run or the same task's private conversation history; that history
   remains owner-scoped and is not a separately shared chat.

## 3. Observed UI (walkthrough, German UI, Plus account, 2026-11-03)

### 3.1 Landing page

```
┌─────────────────────┬──────────────────────────────────────────────────────────┐
│ ⌄ ChatGPT      🔍 ▯ │  Planen                              [ ⚲ Aktiv ⌄ ]        │
│                     │  ChatGPT bitten, Aufgaben zu planen, Erinnerungen        │
│ ✎ Neuer Chat        │  einzurichten oder Updates zu überwachen                 │
│ 🕘 Planen      ◄    │                                                          │
│ ▤ Bibliothek        │  ┌────────────────────────────────────────────────────┐  │
│ ⊙ Plugins           │  │  +  Aufgabe planen                        🎤   ↑   │  │
│ ⋯ Entdecken         │  └────────────────────────────────────────────────────┘  │
│                     │                                                          │
│ Projekte            │  ┌────────────────────────────────────────────────────┐  │
│ Keine Projekte      │  │ ⏸  Canon-Gebrauchtobjektiv-Deals        ✎   ⋯     │  │
│                     │  │    Wöchentlich · Nächste Ausführung in 3 Tagen     │  │
│ Letzte              │  └────────────────────────────────────────────────────┘  │
│ Canon-Gebraucht…    │                                                          │
│ Esskastanien …      │  Empfohlen ⌄                                             │
│ Garantieantrag …    │  🎯 Mein Wochenende planen                          +    │
│ …                   │     Sende mir jeden Donnerstag Ideen …                   │
│                     │  🎵 Konzerte finden                                 +    │
│                     │     Suche jede Woche nach neuen Konzerten …              │
│ ┌─────────────────┐ │  🛒 Preisbenachrichtigungen                         +    │
│ │ FR Florian R.   │ │     Prüfe täglich die Preise …                           │
│ │    Plus         │ │  📖 Wochenendlektüre finden                         +    │
└─┴─────────────────┴─┴──────────────────────────────────────────────────────────┘
```

Structure top to bottom:

- **Sidebar:** the scheduled surface is a first-class nav item between *New chat*
  and *Library*; below it *Plugins*, *Discover*, an empty *Projects* group, then
  the recent-chat list and the account footer with the plan badge.
- **Header:** plain H1, a one-line description, and exactly **one** control on the
  right — a pill-shaped filter dropdown (`Aktiv` + funnel icon + chevron). No
  tabs, no "new" button.
- **Composer:** full-width rounded field with a leading `+`, placeholder
  *Aufgabe planen*, mic, and a send arrow disabled until text exists. Same shape
  as the chat composer: the page says "say what you want scheduled".
- **Task row:** a soft card. The leading circular avatar doubles as the **pause**
  control on hover; title in medium weight; meta line `cadence · next run` with a
  relative next run (*Wöchentlich · Nächste Ausführung in 3 Tagen*); trailing
  pencil (edit) and `⋯` (more). Trailing actions only appear on hover/selection.
- **Suggestions:** collapsible *Empfohlen* block with four ready-made tasks —
  emoji, title, one-sentence prompt, trailing `+` that seeds the composer. All
  four are recurring and outcome-oriented ("tell me when it gets cheaper"), which
  is the mental model the page is teaching.

### 3.2 Filter

A dropdown, not tabs: **Aktiv** / **Pausiert** / **Abgeschlossen** with a
checkmark on the current value. Empty filters show a bordered card with a single
line — *Keine Aufgaben* — and the composer stays available. The *Empfohlen*
block is hidden on non-active filters.

### 3.3 Row menu

`⋯` opens a right-aligned menu with icons:

| Item | Note |
| --- | --- |
| **Jetzt ausführen** | run now |
| **Teilen** | opens the share dialog |
| **Pausieren** | same action as the avatar hover control |
| **Löschen** | destructive, red |

There is **no duplicate entry**, although the documentation mentions one — a
reminder that vendor docs and vendor UI drift apart. We design from the behaviour
we actually want.

### 3.4 Edit modal

Opened from the pencil; also deep-linkable
(`/scheduled?automationId=…&automationSource=cloud&edit_modal=true`).

```
┌───────────────────────────────────────────────┐
│ Wöchentlich                              ✕    │  ← cadence as eyebrow, accent colour
│ Canon-Gebrauchtobjektiv-Deals                 │  ← title, editable textarea
│ PROMPT                                        │
│ ┌───────────────────────────────────────────┐ │
│ │ (prompt, scrollable)                      │ │
│ └───────────────────────────────────────────┘ │
│ HÄUFIGKEIT                                    │
│ ┌───────────────────────────────────────────┐ │
│ │ Wiederholen          Wöchentlich       ⌄  │ │
│ │ Wochentage           Dienstag und Fr… ⌄  │ │
│ │ Uhrzeit              Vormittag        ⌄  │ │
│ └───────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────┐ │
│ │ Ende der Wiederholung             Nie  ⌄  │ │
│ └───────────────────────────────────────────┘ │
│                       [ Pausieren ] [Speichern]│
└───────────────────────────────────────────────┘
```

Two sections, not tabs — *Prompt* and *Frequency* are stacked. Labels are small
caps; values sit right-aligned in the row with chevrons, so the modal reads like a
settings list rather than a form. Save stays disabled until something changed.

**The most interesting detail** is the time model:

- Preset cadences offer **time windows**: `Vormittag`, `Nachmittag`, `Abend`,
  `Nachts` — no clock times.
- Choosing **Benutzerdefiniert** (custom) reveals `Häufigkeit`, `Wochentage` and
  an **exact time** (`9:00`).

So the product deliberately trades precision for simplicity in the default path,
and only exposes exact times to users who ask for custom. That is a real design
decision worth copying — not the implementation.

Other option sets observed:

| Field | Options |
| --- | --- |
| Wiederholen | Intervall, Täglich, Wochentage, Wöchentlich, Monatlich, Benutzerdefiniert |
| Uhrzeit (presets) | Vormittag, Nachmittag, Abend, Nachts |
| Uhrzeit (custom) | exact clock time |
| Ende der Wiederholung | Nie, An einem Datum |
| Footer | Pausieren (secondary), Speichern (primary) |

### 3.5 Share dialog

Centred modal: title *Aufgabe teilen*, two warning lines —

> "Änderungen nach dem Teilen werden nicht geteilt. Benutzerdefinierte
> Anweisungen und Erinnerungen werden nicht geteilt."

— then an inner card with the task title, a type label (*Geplante Aufgabe*), the
prompt preview with *Mehr anzeigen*, and one full-width primary button
*Link kopieren* plus an `✕`.

The takeaway: sharing distributes a **frozen definition**, explicitly excluding
custom instructions and memories. Privacy is stated in the dialog, not buried in a
policy page.

### 3.6 Notifications settings

A single page of feature rows; each row is title + description + a channel
dropdown on the right (`Push`, `E-Mail`, `Push, E-Mail`). The *Aufgaben* row adds
an inline link **Aufgaben verwalten** that jumps to the task list. No global
"enable notifications" switch at the top — the toggles are per feature.

### 3.7 Connected apps

Settings → *Plugins*: catalog search, installed plugins, and a default permission
(*allow low-risk tools*) plus a per-plugin permission dropdown. This is the
prerequisite for event-triggered tasks; the UI treats permissions as a property of
the connection, not of the task.

### 3.8 Inside a chat

A task created "in this chat" leaves no banner in the chat. Its runs simply arrive
as chat messages over time; the chat menu is the only link back to the task list.
This keeps the chat clean, but it also means the chat carries no visible "this is
automated" marker — a trade-off we should decide explicitly.

## 4. Feature inventory — adopt / adapt / skip

### 4.1 Landing surface

| Behaviour | Decision | Why |
| --- | --- | --- |
| Dedicated nav entry for scheduled work | **Adopt** | Scheduling is a product area, not a settings page |
| Single filter dropdown (active / paused / completed) | **Adopt** | Cheaper than tabs and matches the real task states |
| Composer as primary create action | **Adopt** | Prompt-first; the form comes later |
| Suggestions with one-click seeding | **Adopt** | Teaches the pattern; lowers the empty-page cost |
| Row shows `cadence · relative next run` | **Adopt** | Relative time ("in 3 Tagen") reads better than a timestamp |
| Hover-revealed row actions | **Adapt** | Fine on desktop; our tables must also work on touch/keyboard |
| "No tasks" as a plain bordered line | **Adapt** | We add a short "what is this" hint and a link to docs |
| No create button in the header | **Adopt** | One primary action is enough |

### 4.2 Task definition

| Behaviour | Decision | Why |
| --- | --- | --- |
| Title + prompt as the only required fields | **Adopt in spirit** | Provider and model are additionally required (BYO); everything else defaults |
| Cadence presets with **time windows** | **Adopt — shipped** | Already implemented and admin-configurable (`scheduleTimePresets`) |
| Exact times only under "custom" | **Adapt** | We offer windows *and* exact times; same simplicity, more control |
| Custom = interval/daily/weekdays/weekly/monthly/custom | **Adapt** | We use once/daily/weekdays/weekly/monthly/cron — no "interval", but multi-weekday and multi-day-of-month |
| End condition: never / on a date | **Adopt** | Add "after N runs" as our extension |
| Pause and save in the modal footer | **Adopt** | Lifecycle where the definition lives |
| Save disabled until dirty | **Adopt** | Prevents accidental no-op writes |
| Destination: continue this task's private conversation vs standalone runs | **Adapt — implemented for v1** | A task-level mode reuses owner-scoped execution history; no external chat or OpenCode Web surface is introduced |
| Model / reasoning per task | **Adapt** | We pin provider + model, not "reasoning effort" |

### 4.3 Runs and inbox

| Behaviour | Decision | Why |
| --- | --- | --- |
| Run-now without moving the schedule | **Adopt** | Essential for testing a prompt |
| Runs as immutable snapshots | **Adopt** | Each run now stores its exact user-input snapshot, including follow-ups; title, model, report and usage are also frozen. Schedule and other task settings remain task-level values (see §8.2) |
| "Nothing to report" as a real outcome | **Adopt** | The core of monitoring |
| Unread marker on new runs | **Adopt** | The inbox metaphor depends on it |
| Run history shown inside the chat | **Adapt — shipped in v1** | Runs and private follow-ups stay in the task view; there is no separate chat object to link |
| Completed filter separate from paused | **Adopt** | Different recovery actions |

### 4.4 Sharing, permissions, compliance

| Behaviour | Decision | Why |
| --- | --- | --- |
| Share = frozen definition, no data | **Adopt** | Cheap and safe; fits self-hosting |
| Explicit "custom instructions and memories are not shared" | **Adopt** | Say the privacy rule where the action happens |
| Copy link as the only primary action | **Adopt** | One job per dialog |
| Revoking does not delete copies | **Adopt** | Honest semantics |
| Per-connection permission model | **Adapt** | We have provider keys, not OAuth apps (for now) |
| Plan-based task caps | **Adapt** | Our limits are admin-configured, not subscription tiers |
| Compliance/export coverage | **Skip** (for now) | No regulated customers yet; revisit with SSO |

### 4.5 Event triggers, Codex-style automations

| Behaviour | Decision | Why |
| --- | --- | --- |
| Trigger on new mail / channel message / PR activity | **Skip** (v1) | Requires connectors we do not have |
| Trigger/condition/prompt triple | **Adopt as a concept** | Good structure even for timer tasks |
| Local project vs isolated worktree per run | **Adapt** | We run server-side; isolation is a container, not a worktree |
| "Machine must be on" caveat | **Skip** | Our worker is always on — a genuine advantage, say so |

## 5. Our extensions already implemented — keep them

Several things we already ship go beyond the reference product. They are not
deviation risks to be trimmed back to "parity"; they are the reason someone would
self-host this. Any new work must preserve them.

| Extension | Where it lives | Why it stays |
| --- | --- | --- |
| **Time-of-day windows and exact times in one control** | `TaskFormPage.tsx`, `scheduleTimePresets` in `shared/schemas.ts` | The reference forces a choice; ours offers both |
| **Multi-weekday, multi-day-of-month and raw cron** | `packages/shared/src/schedule.ts` | Real operator needs, one extra field each |
| **Hard per-run caps** (duration, steps, pages, tool calls, searches) | `packages/shared/src/limits.ts` | Unattended runs need finite budgets, not trust |
| Durable scheduling: idempotent booking, leases, retries with backoff, crash recovery | `05-durable-scheduling.md` | The reference is a cloud service; we have to survive restarts |
| Per-task **and** global memory with revisions, tombstones and dedupe | `15-persistent-memory.md` | Sticky context across runs; the reference only keeps chat context |
| E-mail DSL: validated blocks, inline-styled table HTML, agent-composed mails | `docs/email-dsl.md` | Delivery-first product, not notification-first |
| Execution view: status, duration, tokens, step timeline, sources, uncertainty | `12-reports-and-exports.md` | Auditable, not a chat bubble |
| Real research stack: SearXNG + Playwright, persisted sources | `09-web-research.md` | Reports cite what was actually opened |
| Browser isolation and an enforcing egress proxy | `10-browser-isolation-and-egress.md` | Unattended browsing needs a hard boundary |
| Prompt-injection and XSS defences | `11-prompt-injection-and-xss.md` | Unattended runs are the highest-risk path |
| Multi-user isolation, RBAC, invites, audit log, quotas | `02`, `03`, `14` | Self-hosted means shared instance, per-user boundaries |
| Bring-your-own provider, encrypted keys, model variants | `06`, `07` | No vendor account required |
| Full en/de localisation | `13-web-ui.md` | The UI language is a feature, not a preference |
| **Duplicate task** | `api.tasks.action(id, 'duplicate')` | The reference UI omits it; operators need it |
| Retry and run-now | run-now on the task page, retry on the execution page (`ExecutionDetailPage.tsx`) | Recovery is a first-class action |
| Admin-configurable limits | admin area | Ours are guardrails, not subscription tiers |

Rule of thumb for the slices in §9: a new surface should *expose* these, not route
around them. If a change touches scheduling, memory, delivery or the audit trail,
the existing guarantees are the baseline, not an optional extra.

## 6. What we deliberately do differently

| Area | Reference product | Ours |
| --- | --- | --- |
| Hosting | Vendor cloud, plan tiers | Self-hosted, one workspace, admin-set limits |
| Model access | Vendor models, per-plan availability | Bring your own OpenAI-compatible provider |
| Delivery | Push/mobile-first | E-mail-first with the e-mail DSL, plus web inbox |
| Memory | Custom instructions + per-task memory | Global + task memory with revisions and tombstones |
| Research | Web browsing built in | SearXNG + Playwright with persisted sources |
| Run detail | Chat message | Execution view with timeline, tokens, sources, uncertainty |
| Automation scope | Chat + Codex + apps | One runtime, one queue, one database |
| Language | Product-localised UI | We localise, but write our own strings |

These differences are features to state plainly in our own UI copy — not gaps to
hide. Where the table above overlaps with §5, the extension wins: we do not
remove a working capability to look more like the reference.

## 7. Behavioural edge cases to encode as tests

- External chat deletion semantics are out of scope: v1 creates no separate chat
  object; private conversation history is the task's execution history.
- There is no separate chat to preserve when a task is deleted; task deletion
  follows the existing task/execution data lifecycle.
- Resuming does not backfill missed runs.
- Two occurrences with the same `(task, scheduled_for)` never double-book.
- "Nothing to report" is a valid outcome and still consumes quota/usage.
- A retired model on a task is flagged, not silently substituted.
- Paused tasks consume no quota but keep their schedule and history.
- A shared snapshot never carries memory, files or credentials.
- A share link is a frozen definition: editing the task afterwards does not change
  what an existing link shows.
- Revoking a share link stops it resolving immediately; tasks already adopted from
  it keep working because they are independent copies.
- Relative next-run text stays correct across DST changes.
- An empty filter shows the empty state, not the suggestion block.
- Duplicating a task copies definition and schedule, never history or memory.
- Follow-ups are accepted only for enabled, incomplete conversation tasks and are
  rejected while that task has a queued or running execution.
- A task has at most one queued or running execution: the scheduler leaves due work
  pending while an execution is active, and a racing worker claim is deferred without
  consuming a retry attempt.
- A follow-up is a manual execution: it preserves the schedule and stores its
  exact message as the execution input; a retry keeps that same input.
- Conversation context includes only recent completed executions from the same
  task and owner, is byte-bounded, and treats historical text as untrusted data.

## 8. Template vs. implementation — reconciled against the code (2026-11-03)

This section replaces an earlier, documentation-only gap list. Everything below was
checked against the repository, not against its README. The next steps are tracked
in **#20**.

Legend: **✅ have** (equal or better than the reference), **🟡 partial**, **❌ missing**.

### 8.1 As built, with evidence

| Capability | Implementation | Evidence |
| --- | --- | --- |
| Schedule model | presets `once / daily / weekdays / weekly / monthly / custom`, plus multi-weekday and multi-day-of-month | `packages/shared/src/schedule.ts:9-29` |
| Time of day | windows **and** exact time in one control; windows are admin-configurable | `apps/web/src/pages/TaskFormPage.tsx:364-378`, `packages/shared/src/schemas.ts:198-220` |
| DST correctness | spring-forward shifts to a valid wall time, fall-back runs once; documented and tested | `packages/shared/src/schedule.ts:87-109` |
| Idempotent booking | unique `(task_id, scheduled_for)` | `packages/database/src/schema.ts:258` |
| Leases, retries, cancellation | worker id, lease expiry, attempt counter, `cancel_requested` | `schema.ts:238-250`, `apps/worker/src/executor.ts` |
| Run statuses | `queued, running, completed, failed, cancelled, timed_out` | `packages/shared/src/status.ts:1` |
| Immutable run history | denormalised `task_title`, provider, model, `usage`, `report` JSON | `schema.ts:233-247`, `scheduling.ts:38`, `executor.ts:297-299` |
| Immutable run input | Each manual, scheduled, follow-up and retry execution stores `input_snapshot`; retries copy the failed attempt's input | `schema.ts` (`executions.inputSnapshot`), `drizzle/0010_woozy_mauler.sql`, task routes and `scheduling.ts` |
| Private task conversation | Task-level standalone/conversation mode (new and migrated tasks default to standalone); owner-scoped history and follow-up endpoint; one active manual run/follow-up at a time | `apps/api/src/routes/tasks.ts`, `TaskDetailPage.tsx`, `test/integration/tasks.test.ts` |
| Bounded conversation context | Up to four recent completed turns, capped at 8 KB per turn and 24 KB serialized; prior text is labelled untrusted | `packages/shared/src/conversation.ts`, `packages/agent-runtime/src/prompt.ts`, worker tests |
| Tool timeline | one row per tool call with args, duration, error, preview | `schema.ts:262-280` |
| Sources with confidence | `execution_sources` with `confidence`, `excerpt`, unique per URL | `schema.ts:282-296` |
| Task actions | create, edit, pause, resume, run now, duplicate, delete | `apps/api/src/routes/tasks.ts:57-283` |
| Run-now semantics | manual trigger, never moves `next_run_at`; rejected while a run is queued/running | `tasks.ts:222-253` |
| Execution actions | list by status, detail, cancel, retry, Markdown and JSON export | `tasks.ts:316-426` |
| Notifications | e-mail on completion, opt-in per task | `schemas.ts:108`, `executor.ts:372-380` |
| End conditions | `never / on_date / after_runs`; date includes the selected local day; run cap counts scheduled bookings, not manual runs or retries | `packages/shared/src/task-end-condition.ts`, `apps/worker/src/scheduling.ts`, `packages/database/drizzle/0005_deep_madripoor.sql` |
| Per-run caps | duration, steps, pages, output bytes, tool calls, search queries; admin may lower | `packages/shared/src/limits.ts:3-24` |
| Task memory policy | `off / suggest / auto` + `contextBytes` per task | `schema.ts:207-212` |
| Share snapshots | Frozen title, prompt, schedule and timezone; 32-byte bearer token stored only as SHA-256; owner-scoped create/list/revoke; public read and authenticated copy-on-adopt | `packages/shared/src/task-share.ts`, `packages/database/src/schema.ts`, `apps/api/src/routes/task-shares.ts`, `apps/web/src/pages/SharePage.tsx` |
| Multi-user | owner-scoped reads/writes, roles, invites, audit log | `apps/api/src/routes/*.ts`, `schema.ts:494` |
| UI | task table + title search, task detail with runs, executions page with status tabs | `apps/web/src/pages/TasksPage.tsx`, `TaskDetailPage.tsx`, `ExecutionsPage.tsx` |
| i18n | full en/de catalogues, localised schedule summaries | `apps/web/src/locales/*`, `schedule.ts:115-132` |

### 8.2 Behaviour matrix

**Landing and discovery**

| Reference behaviour | Ours | Note |
| --- | --- | --- |
| Dedicated scheduled surface in the nav | ✅ | *Tasks* page now includes the inbox slice: status filters, per-task unread counts and run history with an explicit review action |
| Filter active / paused / completed | ✅ | `GET /api/tasks?status=…`; status is derived from `completed_at` first, then `enabled` |
| Unread marker on new runs | ✅ | Completed runs are unread by default; owners explicitly mark an individual execution read. Existing completed runs are backfilled as read |
| Composer-first creation | ✅ | The task-list composer carries a prompt in router history state to the existing form; the user reviews the draft and confirms there. The direct form remains available. |
| One-click suggestions | ✅ | A collapsible block on an active list with tasks seeds the composer draft; it never creates or runs a task, and an empty filter keeps its empty state |
| Relative "next run" in the list | ✅ | Active tasks show a locale-aware relative next run; paused and completed tasks show no next run |

**Definition**

| Reference behaviour | Ours | Note |
| --- | --- | --- |
| Title + prompt are the only *content* fields | 🟡 | Provider and model are additionally required (BYO); everything else defaults |
| Provider and model pinned per task | ✅+ | Plus optional system instructions |
| Time windows, exact time under custom | ✅+ | Both visible at once |
| Multi-weekday / multi-day-of-month | ✅+ | Reference has single day per preset |
| Advanced recurrence (RRULE vs cron) | 🟡 | Five-field cron, no RRULE; equivalent for our cases |
| End condition (never / date / after N) | ✅ | Date is inclusive in the task timezone; after N counts scheduled bookings, excluding manual runs and retries. Reaching a condition records completion and stops booking. |
| Destination: this task's private conversation vs standalone | ✅ (adapted) | The task's execution history is the conversation; follow-ups are manual executions and do not change the schedule. There is no separate chat object or OpenCode Web integration. |
| Per-task model/reasoning effort | 🟡 | Model is pinned; variants exist (`model#high`), no explicit effort UI |
| Per-task sandbox/permission profile | 🟡 | Browser isolation is deployment-wide; web research is a per-task switch; the per-task `limits` column is stored but not enforced (global settings win) |
| Approval-gated unattended actions | ❌ | No approval state |

**Runs**

| Reference behaviour | Ours | Note |
| --- | --- | --- |
| Run status incl. awaiting approval | 🟡 | Six statuses, no approval/paused |
| Immutable snapshots | 🟡 | Title, model, report, usage and exact per-execution user input are stored. Schedule and other task settings are not snapshotted; inputs from before migration are best-effort backfilled from the task's prompt at migration time. |
| Step timeline | ✅+ | Tool args, durations, errors |
| Sources and confidence | ✅+ | Unique per URL, excerpt stored |
| Token usage and duration | ✅+ | `usage` JSON, `duration_ms` |
| Cancel / retry / export | ✅+ | Markdown and JSON export (`tasks.ts:404-426`); the reference exposes cancel implicitly |
| "Nothing to report" as an outcome | ✅ | Each completed run stores `report.change` (`first` / `changed` / `unchanged` / `unknown`) against the previous completed run of the same task |
| Notification only when relevant | ✅ | `notification: "email_on_change"` suppresses the e-mail when the report text is unchanged; a changed or uncomparable report is always delivered |
| Concurrency guard per task | ✅ | Scheduler checks active executions under the task row lock; a due occurrence remains pending until the active run finishes. Worker claims serialize through the owner lock and defer a same-task second claim without consuming a retry attempt. Covered by `test/integration/scheduler.test.ts` and `apps/worker/test/executor.test.ts`. |

**Lifecycle, sharing, compliance**

| Reference behaviour | Ours | Note |
| --- | --- | --- |
| Pause / resume / duplicate / delete | ✅ | Duplicate is ours alone |
| Task caps per plan | ✅+ | No cap on task count by design; per-user execution caps instead (`maxTaskExecutionsPerDay`, `maxConcurrentExecutionsPerUser`) |
| Share as frozen snapshot | ✅ | `POST /api/tasks/:id/share` freezes title, prompt, schedule and timezone; description, system instructions, provider/model, credentials, memory and history are never in the snapshot |
| Copy-on-adopt | ✅ | `POST /api/shares/:token/adopt` requires a signed-in owner and their own executable provider/model; it creates an independent copy with no source memory, history or credentials |
| Per-feature notification channels | ❌ | One global e-mail switch per task |
| Push channel | ❌ | E-mail only |
| Event triggers (Gmail/Slack/GitHub) | ❌ | No connectors |
| Compliance/data export coverage | ❌ | No export of task definitions |
| Weekly auto-task on account connect | ❌ | Not applicable (no accounts to connect) |

### 8.3 Where we already exceed the template

Kept deliberately, per §5:

1. A window always shows its concrete clock time, and exact entry is one option away in the same select.
2. Multi-weekday and multi-day-of-month presets.
3. Hard per-run budgets (duration, steps, pages, tool calls, searches).
4. Execution view with tool timeline, sources, confidence and token usage.
5. Per-task memory policy with review queue and change journal.
6. Durable booking, leases, retries, crash recovery, per-user concurrency limits.
7. Duplicate, retry, cancel, Markdown and JSON export.
8. Multi-user isolation, roles, invites, audit log.
9. Full en/de localisation, including schedule summaries.
10. Admin-lowerable limits instead of subscription caps.

### 8.4 Where the template exceeds us (ranked)

| Rank | Gap | Why it matters | Size |
| --- | --- | --- | --- |
| 1 | ✅ **Inbox slice shipped in #20** | Owner-scoped unread counts and explicit read markers, with active / paused / completed filtering and relative next-run text | Shipped using existing task and execution state; no separate archive state |
| 2 | ✅ **Prompt-first creation shipped** | The form asks for provider/model/schedule before the user has said what they want | Prompt composer + private history-state draft + explicit form confirmation; direct form remains available |
| 3 | ✅ **Task-bound destination implemented for #20 v1** | Per-task standalone or private conversation mode, history and follow-ups; no separate chat system | Implemented with owner-scoped execution history and bounded context |
| 4 | **End conditions (date / after N runs)** | Long-running monitors never stop | ✅ Shipped in #20; after N counts scheduled bookings, while manual runs and retries remain independent |
| 5 | ✅ **Monitoring comparison and quiet runs** | Unchanged report text need not generate e-mail noise | `email_on_change` suppresses unchanged reports; comparison is text-based, not semantic |
| 6 | **Notification channels** (push, per-feature) | E-mail-only limits the product to inbox-checkers | Only-on-change e-mail exists; additional channels and per-feature settings remain open |
| 7 | ✅ **Share snapshot shipped** | A frozen definition-only link can be handed to a colleague without credentials; revoking stops the link, not existing copies | Snapshot table, public read route, owner-scoped revoke, authenticated copy-on-adopt |
| 8 | **Event triggers** | Pull-based only; no reaction to changes | L — connector layer, rate limits, review UI |
| 9 | **Approval pause** | Unattended actions either run or fail | M — approval state + resume |
| 10 | **RRULE import/export** | Only relevant if we interoperate with calendar tooling | S — optional |

## 9. Suggested delivery slices (ordered by size and dependency; §8.4 ranks by value)

1. ✅ **End conditions shipped in #20** — date and "after N runs" are evaluated
   by the scheduler before booking; date is inclusive in the task timezone.
2. ✅ **Monitoring comparison + quiet runs** — compare report text with the previous
   completed report; an unchanged result suppresses `email_on_change` notifications.
   This is not a semantic diff and may report a change for formatting differences.
3. ✅ **Inbox slice shipped in #20** — task state (`active / paused / completed`),
   owner-scoped unread runs, an explicit per-execution read action, status filter
   and relative next run. Reuses the executions table; existing completed runs
   are treated as already read.
4. ✅ **Prompt-first creation shipped** — the tasks-page composer carries the
   prompt into the existing form as a history-state draft; users review the full
   form and confirm before creation. The prompt is not put in the URL.
5. **Notification channels** — abstract `notification` into channels and add
   per-feature settings. E-mail and opt-in `email_on_change` already exist.
6. ✅ **Share snapshot shipped** — definition only, copy-on-adopt, revoke, explicit
   exclusion of memory and history. The link carries title, prompt, schedule and
   timezone; the adopter supplies their own provider and model.
7. ✅ **Task-bound destination implemented for #20 v1** — standalone or conversation mode;
   follow-ups create manual executions without changing the schedule, and only
   completed same-task turns enter the bounded context. Retry inputs are retained.
8. **Approvals** — open design: unlisted tools are not offered and browser/egress
   hard denies must not be overridden. An OpenCode permission request can pause a
   live process, but the pending request is lost on runtime restart. Durable
   approval therefore needs an explicit approvable action policy and recovery
   design before it can safely be shipped.
9. **Event triggers** — only after a connector exists.
10. **RRULE** (rank 10 in §8.4) stays out of scope: five-field cron covers our cases.
11. ✅ **One-click suggestions shipped** — a static, originally written set on the
    active list; selecting one only fills the composer draft.

## 10. Acceptance criteria

**Already true — protect them**

- [x] Presets, multi-day schedules, cron, IANA timezones, DST-correct occurrences
- [x] Idempotent booking, leases, retries, cancellation, per-user concurrency and
      daily execution caps
- [x] Immutable result snapshots (title, model, report, usage) with timeline, sources, confidence
- [x] Immutable per-execution user input, including scheduled runs, follow-ups and retries
- [x] Duplicate, retry, run-now, Markdown and JSON export
- [x] Per-task and global memory with review policy
- [x] En/de UI, owner-scoped access, audit log

**Open — the work in §9**

- [x] Task state: active / paused / completed, with a filter on the list
- [x] Unread runs and an inbox-style review surface with an explicit per-run read action
- [x] Prompt-first creation with a confirmable draft
- [x] One-click suggested prompts that fill the draft only
- [x] End condition: never / on a date / after N scheduled bookings (manual runs and retries do not count)
- [x] "Nothing to report" outcome that suppresses notification
- [ ] Notification channels beyond e-mail, with per-feature settings
- [x] Share snapshot with copy-on-adopt and revoke
- [x] Task-level destination: standalone runs or a private task conversation with follow-ups
- [x] At most one queued/running execution per task; due occurrences remain pending and racing claims are deferred without spending retry attempts
- [ ] Approval pause for unattended actions
- [ ] Event triggers — only after a connector layer exists (see §9 item 9)

## 11. Open questions

- Should conversation mode be snapshotted per execution, or should a queued run
  use the task's mode when the worker starts it? User input itself is immutable;
  other task settings remain task-level values.
- Should "paused" and "disabled" stay the same state, or split?
- Do suggestions come from a static list, from the user's past tasks, or both?
- How do we phrase the per-user execution limits so they feel like a guardrail,
  not a paywall?
- Does an inbox need push, or is e-mail plus the list enough for v1?

## 12. Sources

- OpenAI Help Center — *Scheduled tasks in ChatGPT*:
  <https://help.openai.com/en/articles/10291617>
- OpenAI docs — *Scheduled tasks* (Codex automations, RRULE, sandboxes):
  <https://learn.chatgpt.com/docs/automations>
- Observed UI walkthrough of the user's own account (2026-11-03); screenshots kept
  outside the repository.
- This repository, read on 2026-11-03: `packages/shared/src/schedule.ts`,
  `packages/shared/src/limits.ts`, `packages/shared/src/status.ts`,
  `packages/database/src/schema.ts`, `apps/api/src/routes/tasks.ts`,
  `apps/worker/src/executor.ts`, `apps/web/src/pages/{Tasks,TaskForm,TaskDetail,Executions}Page.tsx`.
- Issue #20 v1 implementation: `packages/shared/src/conversation.ts`,
  `packages/database/drizzle/0010_woozy_mauler.sql`, task conversation API/UI,
  and worker/prompt tests. Historical inputs are backfilled from each task's
  current prompt at migration time; prior edited prompts cannot be reconstructed.
