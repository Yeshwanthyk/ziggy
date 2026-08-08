# Automation operations

Automation Markdown in the Profile is the only authority for automation policy. SQLite under
`.runtime/` contains scheduler projections, occurrence claims, and run truth; it never replaces or
stores an authoritative definition.

## Definition filenames

An automation's lifecycle is its filename:

```text
automations/<id>.md         active
automations/<id>.paused.md  paused
```

Use lowercase kebab-case IDs. `ziggy automations list <profile>` and
`ziggy automations validate <profile> [id]` show `active`, `paused`, or `conflict` explicitly.
They inspect the Profile without creating or changing `.runtime`, SQLite, or definition files.
Symlinked Profile roots, automation roots, and definition files are rejected.

Create an active starter with:

```sh
ziggy automations create <profile> <id>
```

Creation refuses to proceed if either the active or paused form already exists. Edit definitions
with a normal editor and remove them with normal filesystem operations; Ziggy intentionally adds
no edit or remove command.

## Pause and resume

```sh
ziggy automations pause <profile> <id>
ziggy automations resume <profile> <id>
```

Pause and resume preserve the exact Markdown bytes. The transition creates a same-directory hard
link at the destination name with exclusive `EEXIST` refusal, verifies that both names identify the
same physical regular file, and only then unlinks the source name. It never renames over or silently
replaces a destination.

A paused definition is excluded from scheduler admission. On the next resident scheduler scan its
projected next occurrence is cleared. Resume makes it eligible on the next scan and scheduling
restarts at a fresh future occurrence; paused time is not catch-up work.

Manual `ziggy wake <profile> <id>` reports that a paused automation is paused rather than pretending
it is missing.

Pausing does not cancel an occurrence that was already claimed or a run that is already executing.
That run may finish normally. Pause prevents later admission. If the transition itself leaves both
filenames visible, no run is admitted from the conflicting pair.

## Conflict recovery

If both forms exist, list, validate, and scheduler discovery report one invalid conflict for the ID.
The scheduler does not run it. This can happen after a source-unlink failure: keeping both names is
the fail-closed outcome and preserves the definition bytes for recovery.

Recover manually:

1. Stop concurrent automation file operations for that Profile.
2. Compare `automations/<id>.md` and `automations/<id>.paused.md` byte-for-byte.
3. Decide whether the intended lifecycle is active or paused.
4. Remove exactly the unwanted filename with a normal filesystem command.
5. Run `ziggy automations validate <profile> <id>` and then `ziggy automations list <profile>`.

Never resolve a conflict by copying one form over the other without first inspecting both. Ziggy
will not choose or overwrite one on the operator's behalf.

## Scheduled admission and sessions

`ziggy serve <profile>` discovers active definitions and persists a future schedule cursor. When an
occurrence is due, one SQLite transaction advances that cursor and writes the claimed run before
executing a gate, creating a Pi session, printing output, or delivering it. Scheduled definitions
without a gate are recorded as `skipped-gate`; add an explicit gate such as `gate: true` only when
the scheduled model call is intended.

Every admitted model-backed run receives a fresh Pi session under
`sessions/automations/<automation-id>/`. The run ledger answers whether an occurrence was claimed,
completed, skipped, failed, or became unknown; Pi JSONL remains the only transcript and model/tool
history authority.

Inspect both authorities:

```sh
ziggy automations runs <profile> [id]
ziggy sessions list <profile>
```

## Process failure and no replay

Active scheduled rows are fenced by the resident owner UUID and PID. After a hard crash, the service
manager starts a new `serve` process. Startup changes active rows belonging to the previous resident
to terminal `unknown` with failure category `process-start`. It never returns them to `claimed` or
`running`, and the already-advanced occurrence cursor means they are not replayed.

A normal stop interrupts scoped workers and attempts one truthful terminal `failed/interrupted`
write. If the process is force-killed before that write, startup records `unknown` instead of
inferring success. There are no automatic run retries.

Manual wakes have a separate process-local owner identity. Manual recovery can mark only dead manual
owners unknown; it cannot recover, start, or finish a resident-owned scheduled claim.

## Why there is no public tick

`ziggy serve <profile>` is the supervised resident owner and the only production owner of the
internal scheduler tick. There is no public `tick`, scheduler daemon, repair, replay, or retry
command. A second tick surface would create competing admission owners and blur the existing
Profile owner contract. Use `ziggy serve status`, `ziggy automations status`, and
`ziggy automations runs` for read-only operational visibility.
