# Automation scheduler

The scheduler shape is now selected and sliced:

- `automation-frame.md` records the failure and desired outcome.
- `automation-shaping.md` is authoritative for requirements, the dedicated Profile scheduler
  shape, state ownership, and invariants.
- `automation-slices.md` is authoritative for the V1-V5 build order.

## What shipped

V1 adds Profile-owned Markdown definitions, `automation_list/create/update/remove`, and
`/automations` create/list/inspect/edit/pause/resume/remove. Definitions use deterministic
frontmatter with `version`, `name`, and `enabled`; the Markdown body remains the prompt. Existing
manual-wake files without the new fields remain readable.

`ziggy wake <profile> <automation-id>` reads the same automation file, declines disabled
definitions, evaluates its gate, opens a fresh Pi session only when admitted, prints the answer,
and optionally sends it to Telegram.

- Gate exit 0 proceeds.
- Gate nonzero declines before Pi construction.
- Gate spawn failure or timeout warns and follows the existing fail-open policy.
- Every wake gets a fresh session under `sessions/automations/<id>/`.

## Selected ownership

One dedicated scheduler process owns scheduled claims for one Profile. The TUI and channel
gateways never own scheduling. V3 proves the scheduler in the foreground; V4 installs that exact
command as a Profile-specific service so closing the TUI or a terminal does not stop scheduled
work.

V1 now establishes the shared definition boundary. Build V2 receipts next so V3 can schedule the
same runner without creating a parallel state path.

## Invariants

- Exactly one dedicated scheduler process claims scheduled work for a Profile.
- A due slot is claimed before model or delivery work.
- Restart never replays a claimed slot.
- A declined gate creates no Pi session.
- One slow automation does not block unrelated automation IDs.
- Existing automation files without `cron` keep working.
- The local result is durable before broadcast delivery.
- Closing the TUI has no effect on scheduler ownership.

## Focused proof

Each vertical slice carries its focused proof in `automation-slices.md`. Then run:

```sh
bun test
bun run check
```

## Still out

- One-shot schedules.
- Retries, outbox semantics, or delivery replay.
- A general event bus or remote automation dashboard.
- Unbounded run history.
