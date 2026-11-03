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
   (history, memory, credentials) never travels with it.

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
| Destination: this chat vs new chat per run | **Adopt** | The single biggest UX differentiator |
| Model / reasoning per task | **Adapt** | We pin provider + model, not "reasoning effort" |

### 4.3 Runs and inbox

| Behaviour | Decision | Why |
| --- | --- | --- |
| Run-now without moving the schedule | **Adopt** | Essential for testing a prompt |
| Runs as immutable snapshots | **Adopt** | Partly ours already: title, model, report and usage are frozen per run; prompt and schedule are not (see §8.2) |
| "Nothing to report" as a real outcome | **Adopt** | The core of monitoring |
| Unread marker on new runs | **Adopt** | The inbox metaphor depends on it |
| Run history shown inside the chat | **Adapt** | We keep runs in the task view and link the chat |
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

- Deleting a chat pauses its tasks but does not delete the task or a share link.
  _(blocked on the destination slice — there is no chat concept yet)_
- Deleting a task leaves the chat untouched. _(blocked on the destination slice)_
- Resuming does not backfill missed runs.
- Two occurrences with the same `(task, scheduled_for)` never double-book.
- "Nothing to report" is a valid outcome and still consumes quota/usage.
- A retired model on a task is flagged, not silently substituted.
- Paused tasks consume no quota but keep their schedule and history.
- A shared snapshot never carries memory, files or credentials.
- Relative next-run text stays correct across DST changes.
- An empty filter shows the empty state, not the suggestion block.
- Duplicating a task copies definition and schedule, never history or memory.

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
| Tool timeline | one row per tool call with args, duration, error, preview | `schema.ts:262-280` |
| Sources with confidence | `execution_sources` with `confidence`, `excerpt`, unique per URL | `schema.ts:282-296` |
| Task actions | create, edit, pause, resume, run now, duplicate, delete | `apps/api/src/routes/tasks.ts:57-283` |
| Run-now semantics | manual trigger, never moves `next_run_at`; rejected while a run is queued/running | `tasks.ts:222-253` |
| Execution actions | list by status, detail, cancel, retry, Markdown and JSON export | `tasks.ts:316-426` |
| Notifications | e-mail on completion, opt-in per task | `schemas.ts:108`, `executor.ts:372-380` |
| End conditions | `never / on_date / after_runs`; date includes the selected local day; run cap counts scheduled bookings, not manual runs or retries | `packages/shared/src/task-end-condition.ts`, `apps/worker/src/scheduling.ts`, `packages/database/drizzle/0005_deep_madripoor.sql` |
| Per-run caps | duration, steps, pages, output bytes, tool calls, search queries; admin may lower | `packages/shared/src/limits.ts:3-24` |
| Task memory policy | `off / suggest / auto` + `contextBytes` per task | `schema.ts:207-212` |
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
| Composer-first creation | ❌ | `TaskFormPage` is a form with *Task / Schedule / Behaviour* sections |
| One-click suggestions | ❌ | Empty state only links to "create your first task" |
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
| Destination: this chat vs new chat | ❌ | Every run is standalone; there is no chat concept |
| Per-task model/reasoning effort | 🟡 | Model is pinned; variants exist (`model#high`), no explicit effort UI |
| Per-task sandbox/permission profile | 🟡 | Browser isolation is deployment-wide; web research is a per-task switch; the per-task `limits` column is stored but not enforced (global settings win) |
| Approval-gated unattended actions | ❌ | No approval state |

**Runs**

| Reference behaviour | Ours | Note |
| --- | --- | --- |
| Run status incl. awaiting approval | 🟡 | Six statuses, no approval/paused |
| Immutable snapshots | 🟡 | Title, model, report and usage are stored; prompt and schedule are not, so an edited prompt makes old runs non-reproducible |
| Step timeline | ✅+ | Tool args, durations, errors |
| Sources and confidence | ✅+ | Unique per URL, excerpt stored |
| Token usage and duration | ✅+ | `usage` JSON, `duration_ms` |
| Cancel / retry / export | ✅+ | Markdown and JSON export (`tasks.ts:404-426`); the reference exposes cancel implicitly |
| "Nothing to report" as an outcome | 🟡 | `emptyReport()` exists; no suppression or distinct state |
| Notification only when relevant | ❌ | With e-mail enabled, every completed run sends — even when the report says nothing changed |
| Concurrency guard per task | 🟡 | Run-now refuses while a run is active; the scheduler only dedupes per occurrence. Concurrency is limited per **user** (`quota.ts:29-31`), not per task |

**Lifecycle, sharing, compliance**

| Reference behaviour | Ours | Note |
| --- | --- | --- |
| Pause / resume / duplicate / delete | ✅ | Duplicate is ours alone |
| Task caps per plan | ✅+ | No cap on task count by design; per-user execution caps instead (`maxTaskExecutionsPerDay`, `maxConcurrentExecutionsPerUser`) |
| Share as frozen snapshot | ❌ | No share route, no snapshot table |
| Copy-on-adopt | ❌ | — |
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
| 2 | **Prompt-first creation with a confirmed draft** | The form asks for provider/model/schedule before the user has said what they want | M — composer + draft object + confirm step |
| 3 | **Destination choice** | Every run looks the same; no "continue this thread" | L — needs a conversation concept |
| 4 | **End conditions (date / after N runs)** | Long-running monitors never stop | ✅ Shipped in #20; after N counts scheduled bookings, while manual runs and retries remain independent |
| 5 | **Monitoring diff + "nothing to report"** | The core of a monitoring task; we would e-mail noise | M — compare with previous run, suppress notification |
| 6 | **Notification channels** (push, per-feature, only-on-change) | E-mail-only limits the product to inbox-checkers | M — channel abstraction + settings page |
| 7 | **Share snapshot** | No way to hand a task to a colleague without credentials | S/M — snapshot table, public read route, adopt flow |
| 8 | **Event triggers** | Pull-based only; no reaction to changes | L — connector layer, rate limits, review UI |
| 9 | **Approval pause** | Unattended actions either run or fail | M — approval state + resume |
| 10 | **RRULE import/export** | Only relevant if we interoperate with calendar tooling | S — optional |

## 9. Suggested delivery slices (ordered by size and dependency; §8.4 ranks by value)

1. ✅ **End conditions shipped in #20** — date and "after N runs" are evaluated
   by the scheduler before booking; date is inclusive in the task timezone.
2. **Monitoring diff + quiet runs** — store the previous report, compare, and make
   "nothing changed" a first-class result that suppresses e-mail.
3. ✅ **Inbox slice shipped in #20** — task state (`active / paused / completed`),
   owner-scoped unread runs, an explicit per-execution read action, status filter
   and relative next run. Reuses the executions table; existing completed runs
   are treated as already read.
4. **Prompt-first creation** — composer on the tasks page; the form becomes the
   second step, pre-filled from the draft.
5. **Notification channels** — abstract `notification` into channels; add
   "only when something changed"; keep e-mail as the default channel (still
   opt-in per task).
6. **Share snapshot** — definition only, copy-on-adopt, revoke, explicit exclusion
   of memory and history.
7. **Destination** — thread-aware runs, once a conversation model exists.
8. **Approvals** — pause a run that wants to act outside its allowlist.
9. **Event triggers** — only after a connector exists.
10. **RRULE** (rank 10 in §8.4) stays out of scope: five-field cron covers our cases.

## 10. Acceptance criteria

**Already true — protect them**

- [x] Presets, multi-day schedules, cron, IANA timezones, DST-correct occurrences
- [x] Idempotent booking, leases, retries, cancellation, per-user concurrency and
      daily execution caps
- [x] Immutable result snapshots (title, model, report, usage) with timeline, sources, confidence
- [x] Duplicate, retry, run-now, Markdown and JSON export
- [x] Per-task and global memory with review policy
- [x] En/de UI, owner-scoped access, audit log

**Open — the work in §9**

- [x] Task state: active / paused / completed, with a filter on the list
- [x] Unread runs and an inbox-style review surface with an explicit per-run read action
- [ ] Prompt-first creation with a confirmable draft
- [x] End condition: never / on a date / after N scheduled bookings (manual runs and retries do not count)
- [ ] "Nothing to report" outcome that suppresses notification
- [ ] Notification channels beyond e-mail, with per-feature settings
- [ ] Share snapshot with copy-on-adopt and revoke
- [ ] Destination: continue an existing thread or start a standalone run
- [ ] Approval pause for unattended actions
- [ ] Event triggers — only after a connector layer exists (see §9 item 9)

## 11. Open questions

- Do we introduce a conversation model at all, or keep runs standalone and let the
  execution view be the destination?
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
