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

User-visible demo:

1. Choose Run now in `/automations`.
2. Watch state move from running to succeeded or failed.
3. Open the durable local output from the detail view.
4. Close and reopen the TUI and see the same result.

Build B3, U5/U7, N2/N3, and `automation_run`. Every run uses a fresh Pi session and writes one
bounded receipt. Persist the local reply before any delivery work. An open TUI watches the receipt
directory and notifies; a closed TUI simply catches up on reopen. “TUI” is not a delivery mode and
does not receive an injected asynchronous chat turn.

Proof: one prompt, fresh session path, running-to-terminal transitions, reopen/catch-up, bounded
retention, interrupted receipt visibility, and no false verified status when the model fails.

## V3: Schedule in a separate foreground process

User-visible demo:

1. Add a cron expression and timezone in the TUI.
2. Run `ziggy scheduler <profile>` in a second terminal.
3. Close the TUI and observe the due run complete.
4. Reopen `/automations` and see its next run and receipt.

Build B4/N4 and the scheduled fields in B1/U3. The scheduler holds one Profile-specific lease,
uses Effect `Cron`, derives a canonical firing ID, persists the claim before N2, prevents overlap
for one automation ID, and permits different IDs to run concurrently. Scheduled runs without the
required gate remain declined before Pi construction.

Proof: fake clock, invalid cron/timezone, one claim across two contenders, no replay after restart,
same-ID overlap prevention, different-ID concurrency, declined gate with no Pi session, and TUI
online/offline plus next-run projection.

## V4: Survive TUI closure, terminal closure, and login

User-visible demo:

1. Install the Profile scheduler service.
2. See “scheduler online” in `/automations`.
3. Close every Ziggy TUI and terminal.
4. Let one run fire, then reopen the TUI and inspect its receipt.

Build B5: `ziggy service install|status|uninstall scheduler <profile>` with a Profile-specific
launchd label on macOS, explicit binary/Profile paths, bounded logs, and heartbeat. The service runs
the V3 scheduler command; it does not create a second scheduler implementation. A stale heartbeat
or dead service is displayed as offline, never scheduled.

Proof: generated plist contract, idempotent install, real launchd disposable-Profile smoke,
restart/login restoration, one scheduler lease, stale-heartbeat status, and uninstall without
deleting definitions or receipts.

## V5: Broadcast with truthful per-target receipts

User-visible demo:

1. Add one or more Telegram, Discord, or Slack destinations in the automation detail view.
2. Run now and inspect the local result immediately.
3. See success or failure beside every destination.
4. Change destinations without changing the prompt or schedule.

Build B6/N5 and delivery editing in U3. Replace the single `telegram-chat` field with a typed list of
channel destinations while retaining a version-1 read migration. Local history is unconditional;
zero targets means local-only. Fan-out starts only after the local reply is durable. Telegram,
Discord, and Slack reuse their existing adapters and update independent receipt entries.

Proof: zero/one/many targets, all three channel adapters, partial failure, missing/invalid channel
configuration, stable target identity, local result before delivery, no retry, and no claim that
partial delivery is complete success.

## Definition of automation support

Automation support is complete only after V4: before then, Ziggy may say a definition or foreground
schedule exists, but it may not say an unattended schedule is installed. V5 completes multi-channel
broadcasting. Retries, an outbox, a general event bus, remote administration, and unbounded run
history remain out.
