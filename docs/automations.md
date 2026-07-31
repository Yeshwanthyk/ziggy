# Automations

This is the current Ziggy automation contract. The implementation and focused tests are the
authority; completed shaping and build-order documents are removed after their behavior lands.

## Authority and execution

- Human-owned definitions are clean Markdown under `automations/<id>.md`. The TUI, model tools,
  CLI, and scheduler all enter the same application service.
- Manual and scheduled runs enter one runner. It claims the firing before Pi, prevents overlapping
  runs of one automation, evaluates `wakeGate`, opens a fresh Pi session, and persists local output
  before attempting delivery.
- Bounded Markdown receipts live under `.runtime/automations/runs/<id>/`. Execution and each
  Telegram, Discord, or Slack delivery outcome remain separate.
- `/automations` creates, edits, pauses, resumes, removes, runs, and inspects definitions and
  receipts. It reads durable state; the TUI does not own execution.

## Scheduling and services

- Schedules support timezone-aware `cron`, canonical UTC `at`, and epoch-anchored `every`.
- `ziggy scheduler <profile>` is the foreground due-time owner. It holds a Profile-wide SQLite
  lease, derives canonical firing IDs, admits one catch-up inside 15 minutes, and maintains health
  independently of model work.
- Saving or resuming an enabled scheduled definition idempotently starts that Profile's scheduler.
  launchd on macOS and systemd user services on Linux invoke the same foreground command.
- `/automations` exposes Start, Stop, Restart, and status. The matching
  `ziggy service install|status|restart|uninstall scheduler <profile>` commands are the repair and
  diagnostic surface.
- Closing the TUI or a terminal does not stop scheduled work. Gateway processes are also separate;
  outbound automation delivery uses the transport adapters directly.

## Code map

- Definition authority and Profile-bound operations: [`automations.ts`](../src/application/automations.ts)
- Shared runner and gate ordering: [`automation-runner.ts`](../src/application/automation-runner.ts)
- Schedule meaning and firing identity: [`automation-schedule.ts`](../src/domain/automation-schedule.ts)
- Foreground ownership and health: [`automation-scheduler.ts`](../src/application/automation-scheduler.ts)
- Receipts and claim persistence: [`automation-receipts.ts`](../src/application/automation-receipts.ts)
- Host lifecycle projection: [`automation-services.ts`](../src/application/automation-services.ts)
- TUI and model surface: [`automation-extension.ts`](../src/adapters/pi/automation-extension.ts)

## Deliberate limits

There are no retries, outbox, delivery replay, webhooks, Windows services, remote administration,
multiple destinations on one transport, or unbounded run history. Portable local/cloud wake
providers remain prospective work in
[`portable-automation-scheduling.md`](research/portable-automation-scheduling.md).
