# Automation scheduler

`automation-shaping.md` owns requirements and state; `automation-slices.md` owns the shipped
vertical slices.

## Shipped runtime

- Human-owned definitions stay in `automations/<id>.md`.
- `ziggy automations run` and `ziggy scheduler` enter one claim-before-Pi runner.
- Receipts are clean Markdown under `.runtime/automations/runs/<id>/`, capped at 50.
- One SQLite lease owns due-time evaluation for a Profile. Different automation IDs may run
  concurrently; one ID cannot overlap itself.
- Cron/timezone, one-shot `at`, and fixed-second `every` schedules share one engine.
- Restart or sleep admits one latest catch-up inside 15 minutes and records older work as skipped.
- Scheduler heartbeat runs independently of model work.
- Scheduler health is instance-scoped, so an old process cannot mark its replacement stopped during
  a restart.
- launchd on macOS and systemd user services on Linux invoke the same foreground scheduler command.
- Saving or resuming an enabled scheduled definition idempotently installs and starts that Profile's
  scheduler. The OS service is a projection of the Markdown scheduling intent.
- `/automations` shows scheduler online/offline, next run, latest status, Run now, run history, and
  explicit Start, Stop, Restart, and diagnostic status actions.
- Telegram, Discord, and Slack gateway loops are separate inbound processes. Automation delivery
  uses their HTTP adapters and credentials directly; those gateway loops do not need to be open.
- Local output is durable before optional Telegram, Discord, or Slack delivery, with independent
  target outcomes.

## Invariants

- A firing receipt is claimed before model or delivery side effects.
- A deterministic scheduled firing ID cannot be claimed twice.
- Crashed SQLite leases release with the process.
- Restart uses `launchctl kickstart -k` or `systemctl --user restart`; Start installs when missing.
- A stale running receipt becomes unknown without automatic retry.
- Closing the TUI never stops or owns scheduled work.
- Creating, updating, or resuming an enabled schedule reconciles the scheduler on; an explicit Stop
  is an operator override until the next such definition write.
- Missing or failed delivery never erases a successful local result.

## Still out

- Retries, outboxes, and delivery replay.
- Webhooks, Windows services, and remote administration.
- Multiple destinations on the same transport.
- Unbounded run history.
