# OpenCode Web: documented capabilities and integration boundary

**Research date:** 2026-11-04

**Decision:** Do not integrate or embed OpenCode Web in Agent Tasks. Keep Agent Tasks as the user-facing product and system of record; use OpenCode only as its private execution backend.

## Findings from the official V2 documentation

### Web access and authentication

OpenCode's Web UI is served by the same server as its TUI. It is password-protected; `opencode pair` issues a one-use link that expires after five minutes, and the resulting browser session lasts 30 days. The server listens on localhost by default. Remote pairing is an explicit exposure decision, and OpenCode warns before enabling its OpenTunnel-based remote access. A standalone `opencode serve` can bind to a chosen host and uses HTTP Basic authentication for other clients.

This is a session into an OpenCode server, not a documented way to mount its UI under an application-owned identity or to make Agent Tasks users, tasks, permissions, and reports authoritative inside it. Exposing or proxying it would need a separately designed authentication, tenant-isolation, and lifecycle boundary.

### Custom result blocks

The V2 GUI-plugin documentation describes extension points such as session panels, composer pills, window/session slots, settings pages, commands, and file viewers. These are documented as plugin GUI contributions (primarily for OpenCode Desktop); the app metadata distinguishes `web` and `desktop`, and the built-in Browser contract is explicitly inactive on web. The documented registries do not provide an arbitrary renderer for custom blocks embedded in the session message timeline.

The HTTP API also lists experimental artifact endpoints. Artifacts are location-scoped, can optionally carry a `sessionID`, and contain named files plus an entry point. This is a published-file/artifact facility, not a documented custom message-block protocol. The API reference labels these routes experimental and says they may change without notice.

**Conclusion:** There is no documented, supported V2 route for Agent Tasks to add custom result blocks to OpenCode Web's session transcript. Plugin panels or artifacts are not equivalent substitutes for that contract. This is a finding about the published documentation, not a claim that no private or future implementation exists.

### Scheduling

The V2 HTTP API exposes schedule routes only under `/api/experimental/schedule`. The OpenAPI descriptions say the feature requires `experimental.schedules` in the Session's config and may change without notice. Creating a schedule requires a `sessionID` and a prompt; its purpose is to wake that Session. The documented triggers include a delay, a time, an interval, or cron, with optional conditions and pause/resume/delete operations.

This is experimental, session-bound prompting—not a documented durable, owner-scoped task and execution system equivalent to Agent Tasks scheduling. It should not replace Agent Tasks' scheduler, queue, leases, quotas, audit, notifications, or persisted reports.

## Product decision and implications

- Keep the authenticated Agent Tasks web app as the only customer-facing product surface and source of truth.
- Keep OpenCode server sessions private to trusted backend services. Do not send OpenCode pairing links, passwords, session IDs, or server credentials to the Agent Tasks browser.
- Render Agent Tasks execution reports and structured results in Agent Tasks. If a future requirement calls for OpenCode-side presentation, first obtain a stable documented message-rendering contract or design a clearly separate plugin/artifact experience with its own support and security review.
- Do not implement a Web UI integration based solely on experimental schedules, artifacts, HTTP routes, or desktop-oriented plugin UI APIs.

## Sources

Official OpenCode V2 documentation, consulted 2026-11-04:

- [Intro and Web overview](https://opencode.ai/v2/docs/) — Web UI availability and `opencode pair`.
- [CLI Web](https://opencode.ai/v2/docs/cli/web/) — pairing, session lifetime, default loopback binding, remote access, and standalone server authentication.
- [HTTP API reference](https://opencode.ai/v2/docs/api/) — selected HTTP API is experimental; schedule and artifact routes and schemas.
- [OpenAPI document](https://opencode.ai/v2/openapi.json) — schedule creation requires `sessionID` and prompt; schedule operations are session-config gated; artifact schema is files/entry and optional session association.
- [GUI plugins](https://opencode.ai/v2/docs/build/plugins/gui/) — documented panels, slots, composer pills, file viewers, platform metadata, and experimental GUI API.
- [Plugin overview](https://opencode.ai/v2/docs/build/plugins/) — plugin parts and loading model.

This report uses published V2 documentation only. OpenCode's HTTP API and GUI plugin APIs are explicitly experimental where noted; re-check the official docs before revisiting the decision.
