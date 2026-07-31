---
shaping: true
---

# Automation — Vertical slices

Shape B in `automation-shaping.md` is selected. Build in this order. Every slice ends with visible
TUI behavior and a real Profile artifact; no slice is only a schema, service, or UI mock.

## V1: Own the definition

Status: shipped 2026-07-30.

User-visible demo:

1. Ask Ziggy to create a manual automation.
2. Open `/automations` and see the same definition.
3. Edit, pause/resume, and remove it from the TUI.
4. Confirm no `.claw/` state or external binary was touched.

Build B1, the definition half of B2/B7, U1-U4/U6, N1, and the definition operations in N6.
Introduce an always-admitted `automation-authoring` skill and Profile-bound
`automation_list/create/update/remove` tools. Keep the version-1 Markdown body as the prompt; add
only the enabled and display fields required by this slice. Existing manual-wake files remain
valid.

Proof: typed parse/write failures, atomic no-clobber create, update/remove identity, current-Profile
binding, TUI create/list/detail/edit/pause/remove, model tool discovery, and no `.claw` write path.

## V2: Run now and bring the result home

Status: shipped 2026-07-31.

User-visible demo:

1. Choose Run now in `/automations`.
2. Watch state move from running to succeeded or failed.
3. Open the durable local output from the detail view.
4. Close and reopen the TUI and see the same result.

Build B3, U5/U7, N2/N3, and `automation_run`. Every run uses a fresh Pi session and writes one
Markdown receipt, capped at 50 per automation. The shared runner claims before Pi, enforces one
run per automation, times out after 30 minutes, and persists the local reply before delivery.
The TUI catches up from receipts whenever `/automations` opens; it does not own execution or
receive an injected asynchronous chat turn.

Proof: one prompt, fresh session path, running-to-terminal transitions, reopen/catch-up, bounded
retention, interrupted receipt visibility, and no false verified status when the model fails.

## V3: Schedule in a separate foreground process

Status: shipped 2026-07-31.

User-visible demo:

1. Add a cron expression and timezone in the TUI.
2. Run `ziggy scheduler <profile>` in a second terminal.
3. Close the TUI and observe the due run complete.
4. Reopen `/automations` and see its next run and receipt.

Build B4/N4 and the scheduled fields in B1/U3. The scheduler holds one crash-safe Profile SQLite
lease, uses Effect `Cron`, derives a canonical firing ID, and calls the same claim-before-Pi runner
as Run now. Different automation IDs run concurrently. Restart or sleep admits at most one
catch-up inside 15 minutes; an older latest firing gets a durable skipped receipt and earlier
slots are not replayed. A separate heartbeat remains fresh during long model runs.

Proof: fake clock, invalid cron/timezone, one claim across two contenders, no replay after restart,
same-ID overlap prevention, different-ID concurrency, declined gate with no Pi session, and TUI
online/offline plus next-run projection.

## V4: Survive TUI closure, terminal closure, and login

Status: shipped 2026-07-31.

User-visible demo:

1. Save an enabled schedule and see its Profile scheduler start automatically.
2. Use Start, Stop, Restart, or status from `/automations` when manual control is needed.
3. Close every Ziggy TUI and terminal.
4. Let one run fire, then reopen the TUI and inspect its receipt.

Build B5: enabled scheduled writes reconcile a Profile-specific launchd agent on macOS or systemd
user unit on Linux. `/automations` exposes Start, Stop, Restart, and status. The equivalent
`ziggy service install|status|restart|uninstall scheduler <profile>` commands remain available for
repair and diagnostics. Both backends use exact binary/script/Profile argv and the V3 scheduler
command; there is no second scheduler. Status keeps installed, host-active, and fresh heartbeat
separate. Linux reports user-linger state because a disabled linger may stop work after logout.
Other platforms remain explicit unsupported cases.

Proof: generated plist/unit contracts, idempotent lifecycle tests, one crash-safe scheduler lease,
stale-heartbeat status, and uninstall without deleting definitions or receipts.

## V5: Broadcast with truthful per-target receipts

Status: shipped 2026-07-31.

User-visible demo:

1. Add one or more Telegram, Discord, or Slack destinations in the automation detail view.
2. Run now and inspect the local result immediately.
3. See success or failure beside every destination.
4. Change destinations without changing the prompt or schedule.

Build B6/N5 and delivery editing in U3. Version 1 supports one explicit destination per transport
through `telegram-chat`, `discord-channel`, and `slack-channel`; a run can therefore fan out to
zero through three targets without a nested YAML parser. Local history is unconditional. Fan-out
starts only after the local reply is durable, and each target updates its own receipt outcome.

Proof: zero/one/many targets, all three channel adapters, partial failure, missing/invalid channel
configuration, stable target identity, local result before delivery, no retry, and no claim that
partial delivery is complete success.

## V6: One-shot and interval schedules

Status: shipped with V3 on 2026-07-31.

Definitions accept `schedule: cron:<expression>` plus `timezone`, `schedule: at:<UTC instant>`, or
`schedule: every:<seconds>`. Cron evaluation uses Effect's timezone and DST rules. Fixed intervals
are epoch-anchored, so restart does not introduce drift.

## Definition of automation support

Automation support is complete through V6. Saving an enabled schedule starts its Profile scheduler
by default; online health remains the truthful proof that it is running. Retries, replay queues,
webhooks, Windows services, a general event bus, remote administration, multiple destinations on
the same transport, and unbounded run history remain out.
