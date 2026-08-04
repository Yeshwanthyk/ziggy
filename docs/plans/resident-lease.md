# Resident lease

## Decision

Do **not** add one Profile-wide lease to the current process shape. Telegram, Discord, and Slack are
separate shipped residents with isolated session roots; a Profile-wide lease would make those
channels mutually exclusive without providing an attach path for local TUI/CLI.

If duplicate provider consumers become a demonstrated operator risk, add only the face-scoped
slice in [`openclaw-hermes-primitives.md`](./openclaw-hermes-primitives.md):

```text
(Profile path, telegram | discord | slack)
```

This is an ownership guard, not a daemon, status registry, or attach protocol.

## Slice

1. Add a `ResidentLease` Effect service backed by a held SQLite `BEGIN IMMEDIATE` transaction at
   `<profile>/.runtime/resident-leases/<kind>.sqlite`.
2. Acquire after local config decoding but before any network call or Pi runtime construction.
3. Hold the database connection for the resident scope; rollback and close on shutdown. Process
   death releases the OS lock.
4. Map a busy lock to a typed `ResidentAlreadyRunning` failure with the Profile and face.
5. Leave different channel faces, TUI, `run`, and `wake` unchanged.

The SQLite transaction is authoritative. Do not add owner JSON, PID/start-time inspection,
heartbeats, polling, stale-lock deletion, canonical-realpath identity, or `--force` bypass.

## Invariants

- At most one resident of each face owns one Profile.
- Telegram, Discord, and Slack may run concurrently for the same Profile.
- A refused duplicate performs zero channel and Pi work.
- Normal interruption and process death release ownership.
- A leftover SQLite file does not imply a live owner.
- Profile path policy remains unchanged.

## Focused proof

1. Hold one face lease; a second same-face hold gets `ResidentAlreadyRunning`.
2. Hold Telegram, Discord, and Slack leases concurrently for one Profile.
3. Close or kill a holder; the next same-face hold succeeds without deleting files.
4. Start each gateway while its face is held; assert zero transport and Pi calls.
5. Confirm TUI, `run`, and `wake` are unchanged.
6. Run `bun test` and `bun run check`.

## Gate

Do not implement this for reference parity. First confirm that users run unattended channel
residents and can accidentally start a duplicate of the same command. Session inventory and doctor
remain ahead of this slice because they add visibility with no behavior change.
