# Automation scheduler — Slice 3

## Orientation

Slice 3 adds the durable scheduling and run-accounting engine. Automation Markdown remains the
only definition authority. Pi JSONL remains the only session authority. One SQLite database under
the machine-owned Profile runtime tree becomes the only authority for schedule cursors, claims,
run states, target outcomes, and scheduler freshness.

Manual `wake` and scheduled work use the same `Automations.run` operation. The operation records
both kinds of attempt around the existing gate, Pi, print, resolution, and delivery path. A
scheduled claim commits with its cursor advance before the operation starts. No gate, Pi, channel,
or filesystem effect runs in a SQLite transaction.

This slice deliberately has no production host. It exposes a scoped Effect engine that Slice 4
will start inside the one resident Gateway owner. The engine is still demonstrable in this slice:
its fake-clock tests run the real SQLite adapter and a fake `Automations` service, while the live
manual CLI proves the shared recorder. There is no temporary daemon or scheduler command.

**Readiness: ready.** The missing Gateway host does not block focused proof or require a temporary
host. Production scheduled work remains dormant until Slice 4 calls the engine.

## Settled scope

This slice includes:

- one SQLite schema and no migration framework;
- definition discovery and per-file error isolation;
- schedule fingerprints and durable cursors;
- startup recovery, compact missed ranges, transactional claims, and same-ID exclusion;
- a timer capped at 60 seconds which never waits for a run;
- one recorded operation for manual-force and scheduled attempts;
- ordered Slice 2 target outcomes;
- read-only `automations status` and `automations runs` projections;
- fake-clock and real-SQLite proof.

This slice does not start the scheduler from `gateway`, `discord`, `slack`, or any other production
command. Slice 4 supplies the single resident Gateway owner.

## Authorities

| Fact | Sole authority | SQLite treatment |
| --- | --- | --- |
| Automation definition, prompt, gate, schedule, and delivery policy | `automations/<id>.md` | Store only discovery state, schedule fingerprint, bounded current error, and cursor. Never store a definition copy. |
| Schedule cursor and occurrence consumption | `.runtime/automation-scheduler.sqlite` | Authoritative. |
| Run lifecycle and target outcomes | `.runtime/automation-scheduler.sqlite` | Authoritative. |
| Session transcript, model output, and Pi session structure | Pi JSONL under `sessions/automations/<id>/` | Do not copy output or session JSONL into SQLite. |
| Scheduler freshness | SQLite heartbeat | Evidence only, not a lease or fencing token. |
| Resident ownership | Slice 4 Gateway lease | Not implemented or inferred here. |

A status projection may derive freshness, counts, duration, next due, and ordering. It never changes
stored state. Only the scheduler engine performs recovery or cursor transitions.

## Database contract

### Path and open modes

The exact path is:

```text
<resolved-profile>/.runtime/automation-scheduler.sqlite
```

Writable operations create `.runtime` and the database when needed, then open Bun SQLite with
`{ create: true, readwrite: true, strict: true }`. Set `busy_timeout = 1000`,
`foreign_keys = ON`, `journal_mode = DELETE`, and `synchronous = FULL` on writable connections.
Use DELETE journaling, not WAL: transactions are short, and this lets read-only commands satisfy
the stronger requirement that they never create WAL or SHM sidecars.

Read-only projections first inspect the database path without creating its parent. An absent file
is an empty successful projection. A present file opens with
`{ readonly: true, create: false, strict: true }`. Read paths do not set journal mode, initialize
schema, migrate, checkpoint, recover, or clean up. Each command uses one short deferred read
transaction and closes the connection on success, failure, or interruption.

All SQLite construction, statements, exceptions, and disposal stay in
`src/adapters/bun/automation-sqlite.ts`. The adapter exposes operation-shaped Effects. It does not
expose `Database`, statements, Promises, or a generic SQL client.

### Time and text units

- Every `*_ms` value is a non-negative SQLite `INTEGER` containing Unix epoch milliseconds in UTC.
- Cron occurrences have whole-second precision; persisted values still use milliseconds.
- Displayed timestamps use `new Date(value).toISOString()`, including three millisecond digits.
- Run IDs and fingerprints are lowercase ASCII.
- Persisted definition errors are one line, with control characters and line breaks replaced by a
  single space, then bounded to 160 Unicode code points.
- Run failure categories are stable tokens, never exception messages or adapter causes.

### Schema version 1

A new database is created at `user_version = 1` in one immediate transaction. Version 1 is the only
accepted existing version. Version 0 with no application tables is new. Any other version, missing
version-1 object, changed SQL shape, failed decode, or failed constraint is a typed
`AutomationDatabaseError`. There is no migration path in this slice.

```sql
CREATE TABLE scheduler_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  heartbeat_at_ms INTEGER CHECK (heartbeat_at_ms >= 0),
  last_tick_at_ms INTEGER CHECK (last_tick_at_ms >= 0),
  last_tick_status TEXT CHECK (last_tick_status IN ('ok', 'error')),
  last_tick_error TEXT,
  CHECK (
    (last_tick_status IS NULL AND last_tick_at_ms IS NULL AND last_tick_error IS NULL)
    OR
    (last_tick_status = 'ok' AND last_tick_at_ms IS NOT NULL AND last_tick_error IS NULL)
    OR
    (last_tick_status = 'error' AND last_tick_at_ms IS NOT NULL
      AND last_tick_error = 'definitions-unreadable')
  )
) STRICT;

CREATE TABLE automation_schedule (
  automation_id TEXT PRIMARY KEY,
  definition_state TEXT NOT NULL CHECK (definition_state IN ('valid', 'invalid', 'deleted')),
  schedule_fingerprint TEXT,
  next_scheduled_at_ms INTEGER CHECK (next_scheduled_at_ms >= 0),
  definition_observed_at_ms INTEGER NOT NULL CHECK (definition_observed_at_ms >= 0),
  definition_error TEXT,
  CHECK (
    schedule_fingerprint IS NULL
    OR (length(schedule_fingerprint) = 64 AND schedule_fingerprint NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK (
    (definition_state = 'valid' AND schedule_fingerprint IS NOT NULL
      AND next_scheduled_at_ms IS NOT NULL AND definition_error IS NULL)
    OR
    (definition_state = 'invalid' AND definition_error IS NOT NULL)
    OR
    (definition_state = 'deleted' AND next_scheduled_at_ms IS NULL
      AND definition_error IS NULL)
  )
) STRICT;

CREATE TABLE automation_run (
  run_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual-force', 'scheduled')),
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'running', 'completed', 'failed', 'skipped-gate',
    'skipped-busy', 'missed', 'unknown'
  )),
  schedule_fingerprint TEXT,
  scheduled_for_ms INTEGER CHECK (scheduled_for_ms >= 0),
  missed_through_ms INTEGER CHECK (missed_through_ms >= 0),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  started_at_ms INTEGER CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms >= 0),
  local_completed INTEGER NOT NULL DEFAULT 0 CHECK (local_completed IN (0, 1)),
  failure_category TEXT,
  gate_exit_code INTEGER,
  CHECK (
    (trigger = 'manual-force' AND schedule_fingerprint IS NULL AND scheduled_for_ms IS NULL)
    OR
    (trigger = 'scheduled' AND schedule_fingerprint IS NOT NULL AND scheduled_for_ms IS NOT NULL)
  ),
  CHECK (
    (state = 'claimed' AND started_at_ms IS NULL AND finished_at_ms IS NULL)
    OR
    (state = 'running' AND started_at_ms IS NOT NULL AND finished_at_ms IS NULL)
    OR
    (state IN ('completed', 'failed', 'skipped-gate', 'skipped-busy', 'missed', 'unknown')
      AND finished_at_ms IS NOT NULL)
  ),
  CHECK (
    (state = 'missed' AND trigger = 'scheduled'
      AND missed_through_ms IS NOT NULL AND missed_through_ms >= scheduled_for_ms)
    OR
    (state <> 'missed' AND missed_through_ms IS NULL)
  ),
  CHECK (
    (state = 'completed' AND local_completed = 1 AND failure_category IS NULL)
    OR
    (state = 'failed' AND failure_category IS NOT NULL)
    OR
    (state = 'skipped-gate' AND local_completed = 0
      AND failure_category IN ('gate-missing', 'gate-nonzero'))
    OR
    (state = 'unknown' AND local_completed = 0 AND failure_category = 'process-start')
    OR
    (state IN ('claimed', 'running', 'skipped-busy', 'missed')
      AND local_completed = 0 AND failure_category IS NULL)
  ),
  CHECK (
    (failure_category = 'gate-nonzero' AND gate_exit_code IS NOT NULL AND gate_exit_code <> 0)
    OR
    (failure_category <> 'gate-nonzero' AND gate_exit_code IS NULL)
    OR
    (failure_category IS NULL AND gate_exit_code IS NULL)
  )
) STRICT;

CREATE TABLE automation_target_outcome (
  run_id TEXT NOT NULL REFERENCES automation_run(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'failed')),
  failure_category TEXT,
  retriable INTEGER CHECK (retriable IN (0, 1)),
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, target),
  CHECK (
    (status = 'delivered' AND failure_category IS NULL AND retriable IS NULL)
    OR
    (status = 'failed' AND failure_category IS NOT NULL AND retriable IS NOT NULL)
  )
) STRICT;

CREATE INDEX automation_schedule_due
  ON automation_schedule(next_scheduled_at_ms, automation_id)
  WHERE definition_state = 'valid';

CREATE INDEX automation_schedule_invalid
  ON automation_schedule(definition_observed_at_ms DESC, automation_id)
  WHERE definition_state = 'invalid';

CREATE UNIQUE INDEX automation_run_scheduled_occurrence
  ON automation_run(automation_id, scheduled_for_ms)
  WHERE trigger = 'scheduled';

CREATE UNIQUE INDEX automation_run_active_automation
  ON automation_run(automation_id)
  WHERE state IN ('claimed', 'running');

CREATE INDEX automation_run_recent
  ON automation_run(recorded_at_ms DESC, run_id DESC);

CREATE INDEX automation_run_by_automation_recent
  ON automation_run(automation_id, recorded_at_ms DESC, run_id DESC);

PRAGMA user_version = 1;
```

These are the only four tables. There is no definition-generation table, lease table, lock table,
outbox, event table, retry table, migration table, output table, or metrics table.

`scheduler_state` may be empty after the first manual wake. The engine inserts singleton row `1`.
Historical runs and deleted schedule rows are retained; this slice adds no pruning policy.

## Identities and fingerprints

### Schedule fingerprint

The fingerprint changes only when schedule semantics change. Build this canonical value from the
already parsed `Cron`:

```text
JSON.stringify({
  version: 1,
  timezone: <named zone id>,
  seconds: <ascending numbers>,
  minutes: <ascending numbers>,
  hours: <ascending numbers>,
  days: <ascending numbers>,
  months: <ascending numbers>,
  weekdays: <ascending numbers>,
  and: <cron.and>
})
```

Hash its UTF-8 bytes with SHA-256 and store lowercase hexadecimal. Prompt, gate, broadcast, origin,
frontmatter field order, whitespace, and equivalent five- versus six-field spelling do not affect
the fingerprint. A cron semantic change or timezone change does.

### Run identity

- Scheduled attempt: `scheduled:<automation-id>:<scheduled UTC ISO instant>`.
- Manual-force attempt: `manual:<canonical lowercase UUID v4>`, generated once before admission.
- Missed range: `missed:<automation-id>:<fingerprint>:<first UTC ISO>:<last UTC ISO>`.

The scheduled occurrence identity contains only automation ID and scheduled UTC instant. The
partial unique index is the final duplicate barrier. A DST fold produces two different UTC
instants and therefore two different identities.

A missed row represents every cron occurrence for its fingerprint from `scheduled_for_ms` through
`missed_through_ms`, inclusive. It deliberately stores neither a count nor one row per slot. The
parsed cron matches the current whole-second instant or uses `Cron.prev` to find the last elapsed
occurrence without enumerating a long outage.

## Definition reconciliation

Discovery lists `automations/*.md` deterministically by filename. Every file is read and decoded
outside a transaction. One malformed or unreadable file becomes an `invalid` observation and does
not stop valid siblings. A failure to list the directory is a tick-level error; it must not mark
known definitions deleted because absence was not proved.

The filename stem is the schedule key even when its ID grammar is invalid, so status can expose
that file's bounded error. Only a successfully decoded canonical ID can become `valid`.

For one captured `observedAt`:

| Previous state | Observation | Transaction result |
| --- | --- | --- |
| absent | valid | Insert `valid`; set fingerprint; set cursor to `Cron.next(cron, observedAt)`, strictly after now; create no missed row. |
| absent | invalid | Insert `invalid` with null fingerprint/cursor and bounded error. |
| valid | same fingerprint valid | Keep the cursor, then apply due or missed rules. Update observed time. |
| valid | changed fingerprint valid | Replace fingerprint; set cursor strictly after `observedAt`; create no missed row. |
| invalid | same fingerprint valid | Preserve the old cursor, compact every occurrence at or before `observedAt` as missed even when there is only one, then resume at the first strict future occurrence. |
| invalid | changed or no prior fingerprint valid | Treat as a new schedule and start strictly after `observedAt`. |
| valid or invalid | invalid | Mark invalid and retain prior fingerprint and cursor unchanged. |
| any present state | file proved absent | Mark deleted, clear cursor and error, retain fingerprint and history. |
| deleted | valid | Start strictly after rediscovery time even when the fingerprint matches. |
| deleted | invalid | Mark invalid with no active cursor. |

A non-schedule edit retains the cursor because the fingerprint is unchanged. A schedule edit never
manufactures old history. Time spent invalid never becomes catch-up work. Deleted definitions cannot
be claimed. Claimed work is allowed to finish from a fresh read of the current Markdown; SQLite
never captures a definition copy.

## Lifecycle and transactions

### Startup ordering

`AutomationScheduler.run` performs these steps in order:

1. Capture `startupAt` once from Effect `Clock`.
2. Open or initialize the database and validate schema version 1.
3. In one immediate transaction, change every `claimed` or `running` row to `unknown`, set
   `finished_at_ms = startupAt`, and set `failure_category = 'process-start'`. Do not replay it.
4. Discover and decode every definition outside SQLite.
5. Read current schedule rows, compute reconciliation and missed proposals outside SQLite, then use
   one short immediate compare-and-set transaction to reconcile definitions. For every unchanged
   valid cursor at or before `startupAt`, insert one inclusive missed range through the cron occurrence at `startupAt` when it matches, or
   `Cron.prev(cron, startupAt)` otherwise, and advance to `Cron.next(cron, startupAt)`, the first strict
   future occurrence.
6. In that same reconciliation commit, write heartbeat and `last_tick_status = 'ok'` at
   `startupAt`.
7. Arm the timer from the committed earliest cursor.

Startup recovery is unconditional because Slice 4 guarantees that only the Gateway owner starts
an engine. Heartbeat age is never used as ownership proof. The only recoverable tick-level error is
a failure to list the definitions directory: record `last_tick_status = 'error'` with the exact
category `definitions-unreadable`, leave schedules untouched, and re-arm for 60 seconds. A database
open, schema, read, or write failure ends `run` through `AutomationSchedulerError`; the engine does
not retry or pretend it durably reported a failure it could not write.

### Ordinary timer tick

A tick captures `tickAt`, discovers definitions, and computes proposals outside the write
transaction. The immediate transaction compares every expected fingerprint and cursor before it
writes. A mismatch returns `stale`; the loop performs a fresh scan without dispatching.

For an unchanged valid cursor at or before `tickAt`:

- If only that one occurrence is due, insert either `claimed` or `skipped-busy`, then advance the
  cursor to `Cron.next(cron, scheduledFor)` in the same transaction.
- If a second occurrence is also at or before `tickAt`, insert one `missed` range covering all due
  occurrences and advance to `Cron.next(cron, tickAt)`. Do not run catch-up work.

Due candidates are applied in `scheduled_for_ms`, then `automation_id` ascending order. The
transaction may claim several unrelated IDs. After commit, the engine forks one scoped child per
`claimed` row and returns immediately to timer observation. `skipped-busy` and `missed` are already
terminal and dispatch nothing.

A forward wall-clock jump across multiple occurrences therefore creates one missed range. A
backward jump cannot move a cursor backward or satisfy `cursor <= tickAt` early.

### Same-automation exclusion

Before inserting an active claim, the transaction checks for that automation's `claimed` or
`running` row. The partial unique index enforces the same rule across processes.

- Scheduled due while busy: insert deterministic `skipped-busy` and advance the schedule cursor.
- Manual force while busy: insert a manual `skipped-busy`; do not touch a cursor.
- Different automation IDs: both may be active and run concurrently.

No SQLite transaction remains open while a gate, model, print, target resolution, or delivery runs.

### Shared recorded operation

The domain trigger is exactly:

```ts
type AutomationTrigger =
  | { readonly kind: "manual-force" }
  | {
      readonly kind: "scheduled"
      readonly scheduledFor: string
      readonly scheduleFingerprint: string
    };
```

`Automations.run(target, automationId, trigger)` remains the only execution operation. It returns
the current Slice 2 `AutomationRunOutcome`, widened only with
`{ kind: "skipped-busy" }` for admission refusal. Manual busy renders exactly
`wake skipped: automation is already running` on stderr and exits 1. Existing gate-decline,
execution, delivery rendering, and exit behavior remain unchanged.

For manual force, the operation generates its ID and transactionally inserts `claimed` or
`skipped-busy`. For scheduled work, it verifies the scheduler-created deterministic `claimed` row.
A successful admission transitions `claimed -> running` in a short transaction before reading the
definition or running the gate.

The existing execution order remains:

```text
fresh definition read/decode
-> scheduled gate-presence check
-> optional gate
-> fresh local Pi chat
-> one prompt
-> guaranteed disposal
-> print local reply once
-> resolve targets
-> deliver sequentially
```

The recorder delegates to that path exactly once. It never evaluates policy, sends, retries, or
swallows the original typed failure.

Terminal mapping is exact:

| Existing result | Stored state | `local_completed` | Run failure category |
| --- | --- | ---: | --- |
| scheduled definition has no gate | `skipped-gate` | 0 | `gate-missing` |
| gate returns nonzero | `skipped-gate` | 0 | `gate-nonzero`, plus exit code |
| executed, resolution succeeds, every target delivered or no targets | `completed` | 1 | null |
| executed, resolution fails | `failed` | 1 | existing `AutomationResolutionCategory` value |
| executed, any target fails | `failed` | 1 | first failed target's existing `AutomationDeliveryFailureCategory` by ordinal |
| typed automation or agent failure | `failed` | 0 | the existing error `_tag`; `AutomationGateFailed` adds `:<reason>` |
| Effect interruption before terminal commit | `failed` | 0 | `interrupted` |
| process dies before terminal commit | recovered as `unknown` | 0 | `process-start` |

The terminal transaction inserts every ordered `AutomationTargetOutcome` from Slice 2 and then
updates the run. Successful targets remain present when another target fails. Resolution failures
have no invented target. `retriable` is recorded as observed data only; no retry reads it.

`local_completed = 1` means the local Pi execution and local print completed, even when delivery
made the run fail. Model output is not stored. If the process dies before that fact commits, the
honest recovered state is `unknown`.

Completed, failed, skipped-gate, skipped-busy, missed, and unknown rows never transition again.
Manual runs never insert, update, or advance `automation_schedule`.

## Engine Effect API

Add one application service:

```ts
interface AutomationSchedulerShape {
  readonly run: (
    target: ProfileTarget,
  ) => Effect.Effect<never, AutomationSchedulerError>;

  readonly status: (
    target: ProfileTarget,
  ) => Effect.Effect<AutomationStatusProjection, AutomationProjectionError>;

  readonly runs: (
    target: ProfileTarget,
    automationId?: AutomationId,
  ) => Effect.Effect<ReadonlyArray<AutomationRunProjection>, AutomationProjectionError>;
}
```

`run` owns one internal scope containing exactly one timer loop and all dispatched run fibers.
Interruption closes the scope and interrupts both waits and children. Production code never calls
`Effect.runFork`, `runPromise`, or a raw timer. The only eventual production execution edge remains
`BunRuntime.runMain` in `src/main.ts`.

`status` and `runs` are one-snapshot read projections. They do not call `run`, discover definitions,
recover rows, refresh heartbeat, parse Pi JSONL, evaluate a gate, or deliver.

`AutomationSchedulerError`, `AutomationProjectionError`, and `AutomationDatabaseError` are typed
`Schema.TaggedErrorClass` values. Bun SQLite causes are captured once by the adapter. Definition
errors stay per-row observations, not engine failures.

### Timer wake calculation

After every committed startup or tick result, capture wall time again and calculate:

```text
untilDue = earliestNextDueMs - nowMs
sleepMs = earliestNextDueMs is absent
  ? 60_000
  : min(60_000, max(0, untilDue))
```

Sleep with Effect `Clock`. After waking, read wall time again and run a fresh tick; completion of a
sleep is never proof that a wall-clock deadline is due. A far-future or empty schedule therefore
rescans and heartbeats every 60 seconds. An earlier due time wakes exactly at that time. There is no
faster fixed poll and no definition-change signal in this slice: human file edits are discovered by
the bounded rescan.

The timer loop never waits for `Automations.run`. A long run for one ID cannot delay timer scans,
heartbeats, or another ID.

## Read-only CLI

The exact commands are:

```text
ziggy automations status <name|path>
ziggy automations runs <name|path> [automation-id]
```

There is no `start`, `stop`, `tick`, `daemon`, `repair`, `retry`, or `replay` action.

Both commands first validate the Profile by read-only inspection of `SOUL.md`. If the Profile is
valid and the database is absent, they exit 0 without creating `.runtime`, the database, WAL, SHM,
journal, lock, or any Profile file. An existing unreadable or malformed database is a typed failure
and exits 1; it is not treated as empty.

### Freshness

Capture `now` once before the read transaction.

- `fresh`: heartbeat age is from 0 through 90,000ms.
- `stale`: heartbeat age is greater than 90,000ms.
- `unknown`: heartbeat is absent or future-dated.

Scheduler display is `active` only for fresh, `stale` only for stale, and `unknown` otherwise. Tick
status is separately `ok`, `error`, or `unknown`. Heartbeat is evidence, not a lease.

### Status output

Field order is fixed:

```text
profile: /profiles/pal
scheduler: active
heartbeat: fresh (2026-07-30T10:15:00.000Z)
tick: error (2026-07-30T10:15:00.000Z; definitions-unreadable)
definitions: 2 valid, 1 invalid, 3 deleted
definition error: broken-note 2026-07-30T10:14:00.000Z invalid automation broken-note
next due: 2026-07-30T10:16:00.000Z (daily-note)
active runs: 1
latest run: manual:550e8400-e29b-41d4-a716-446655440000 daily-note running manual-force 2026-07-30T10:14:00.000Z
latest error: scheduled:weekly-review:2026-07-30T09:00:00.000Z weekly-review failed ProviderCallError
```

Missing values render exactly:

```text
heartbeat: unknown
tick: unknown
definition error: none
next due: none
latest run: none
latest error: none
```

An absent database also renders `scheduler: unknown`, zero definition counts, and
`active runs: 0`.

Definition counts include retained deleted rows. `definition error` selects the newest invalid row
by `definition_observed_at_ms DESC, automation_id ASC`. `next due` selects valid rows by
`next_scheduled_at_ms ASC, automation_id ASC`. Active count includes all claimed and running rows.
Latest run uses `recorded_at_ms DESC, run_id DESC`.

`latest error` compares the newest failed, missed, or unknown run with a failed last tick by event
time; a run wins an equal timestamp. A run uses exactly
`latest error: <run-id> <automation-id> <state> <category|->`; a tick uses exactly
`latest error: tick <ISO> definitions-unreadable`. Reasons are scheduler-owned category tokens or
the bounded definition message. Model output and adapter causes are never printed.

### Runs output

The default and hard limit is 10. There is no option to change it and no pagination. Optional `id`
uses the existing automation ID decoder.

Runs are ordered by `recorded_at_ms DESC, run_id DESC`. Each row prints:

```text
<run-id> <automation-id> <state> <trigger> scheduled <ISO|-> through <ISO|-> recorded <ISO> started <ISO|-> duration <integer-ms|-> reason <category|-> local <completed|->
```

Then target rows print in persisted `ordinal`, with target as a defensive tie-breaker:

```text
  delivery <canonical-target> delivered reason - retriable -
  delivery <canonical-target> failed reason <existing-category> retriable <true|false>
```

A row with no target outcomes prints exactly `  delivery none`. Duration is
`finished_at_ms - started_at_ms`; a running row uses captured `now - started_at_ms`; otherwise `-`.
A missed row uses `scheduled` for the first endpoint and `through` for the inclusive last endpoint.
Manual rows show `scheduled - through -`.

No matches or an absent database prints exactly:

```text
no automation runs
```

## Exact implementation files

Production changes are limited to:

1. `src/domain/automation.ts` — trigger, attempt outcome, persisted projection schemas, fingerprint
   and run-ID helpers, scheduler/database tagged errors.
2. `src/adapters/bun/automation-sqlite.ts` — scheduler filesystem inspection, schema version 1,
   bracketed connections, short transactions, startup/reconcile/claim/transition operations, and
   read-only snapshots.
3. `src/application/automations.ts` — one recorded run operation around the existing executor,
   scheduled gate requirement, terminal mapping, and target-row persistence.
4. `src/application/automation-scheduler.ts` — definition discovery, reconciliation decisions,
   scoped timer, dispatch, and projection service.
5. `src/faces/automation-cli.ts` — manual busy rendering plus exact status and runs text.
6. `src/main.ts` — wire the service and add only the two read commands.
7. `LOG.md` — append the completed logical block without changing the existing Effect audit.

Focused tests are limited to:

1. `src/domain/automation.test.ts`.
2. `src/adapters/bun/automation-sqlite.test.ts`.
3. `src/application/automations.test.ts`.
4. `src/application/automation-scheduler.test.ts`.
5. `src/faces/automation-cli.test.ts`.

No dependency or lockfile change is allowed. Do not add a repository layer, generic SQLite service,
ORM, migration helper, scheduler host, or second execution service.

## Focused proof

### Domain

- Equivalent five- and six-field schedules and field whitespace produce the same fingerprint.
- Cron or named timezone semantics change the fingerprint.
- DST-fold occurrences produce distinct deterministic scheduled IDs.
- Manual IDs have the exact UUID-v4 form.
- Result-to-terminal mapping uses Slice 2 resolution, target, retriable, and typed-error vocabulary.

### Real SQLite adapter

- Schema initializes atomically at exactly `user_version = 1`; rollback leaves no partial rows.
- A scheduled claim and cursor advance commit together; a forced rollback commits neither.
- Two concurrent claimants produce one deterministic occurrence and zero duplicate dispatches.
- A manual and scheduled race for the same ID yields one active row and one `skipped-busy` row;
  different IDs can both become active.
- Target outcomes retain ordinal, successful rows, failed rows, existing category, and retriable flag.
- Connections close after success, typed failure, and interruption.
- Version mismatch and malformed rows fail decode.

### Recorded execution

- Manual force creates one audit row, changes no schedule row, and keeps current CLI semantics.
- Scheduled work without a gate becomes `skipped-gate` before Pi construction.
- Gate nonzero, gate infrastructure failure, agent failure, resolution failure, no-target success,
  delivery success, and partial delivery map exactly to the table above.
- Partial delivery stores every ordered target, marks the run failed, and keeps
  `local_completed = 1`.
- The automation Markdown bytes remain unchanged.

### Engine with TestClock and real SQLite

- First discovery after old theoretical cron history creates no missed row and starts strictly
  after discovery time.
- A semantic schedule change starts strictly after change time and never claims the old cursor.
- Prompt/gate/broadcast edits retain the cursor.
- Delete stops future claims and retains history; recreate does not revive the old cursor.
- One invalid file exposes its bounded error while a valid sibling still claims.
- Startup converts claimed and running rows to unknown with zero replay.
- A long outage creates one exact missed range and advances to the first future occurrence.
- One live due occurrence claims once; two or more elapsed occurrences become one missed range.
- Same ID does not overlap; different IDs dispatch concurrently.
- A run blocked on `Deferred` does not prevent another claim or the 60-second heartbeat.
- No schedules and far-future schedules rescan at 60 seconds, not 59 seconds.
- Backward wall time does not claim early; a forward jump creates a missed range.
- Interrupting the engine cancels its timer and scoped children.

### Read-only projections

- Snapshot the whole Profile tree by relative path, type, size, mtime, and content hash before and
  after both commands with no database. Prove exact equality and absence of `.runtime`.
- Repeat with a fixture database and prove no database, journal, WAL, SHM, lock, directory, or
  Profile mutation.
- Fake-time boundaries at 0ms and 90,000ms are fresh; 90,001ms is stale; missing and future are
  unknown.
- Status field order, deterministic ties, invalid definition selection, latest error selection, and
  empty values match the exact text.
- More than 10 mixed runs prove the hard bound, optional filter, stable ordering, missed range,
  manual formatting, local truth, and persisted target order.
- Missing tables, wrong version, invalid rows, and unreadable state fail instead of looking empty.

Run the focused files first:

```sh
bun test \
  src/domain/automation.test.ts \
  src/adapters/bun/automation-sqlite.test.ts \
  src/application/automations.test.ts \
  src/application/automation-scheduler.test.ts \
  src/faces/automation-cli.test.ts
```

Then run:

```sh
bun run check
bun test ./src ./extensions && bun run test:helpers
```

## Hard size ceiling

The implementation may add at most **1,250 nonblank production lines** across the six named
production files and at most **1,100 nonblank test lines** across the five named test files. The
combined ceiling is **2,350 nonblank lines**. `LOG.md` and this document do not count.

Measure added nonblank lines against commit `cbd6512`. If the ceiling cannot be met, stop and remove
an abstraction or split later visibility work; do not exceed it and do not add a framework.

## Excluded work

Do not add retries, catch-up execution, replay, delivery reattempt, an outbox, a service manager, an
OS scheduler, RPC, generation fencing, drift repair, a startup fuse, an ORM, event sourcing, a
migration framework, Gateway or channel changes, a public scheduler command, a dashboard, a metrics
backend, log aggregation, configurable history limits, pagination, JSON output, a definition
snapshot table, or a second session/output authority.

## Residual boundary

Until Slice 4 starts `AutomationScheduler.run` under the single Gateway lease, scheduled rows are
created only by tests. Manual `wake`, status, and runs are live. Heartbeat is intentionally not a
lease, and this slice makes no multi-resident ownership claim.

There are no open implementation decisions in Slice 3.
