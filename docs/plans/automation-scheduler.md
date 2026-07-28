# Automation scheduler implementation plan

Status: planned only. Before implementation, replace the stale-file lock references below with
the stable hidden-runtime locking approach now used by memory writes; do not copy the removed
compare-and-delete takeover algorithm.

## Context

Ziggy automations are manual-only today. `ziggy wake <name|path> <automation-id>` is the only
face that calls `Automations.wake`, so the user invocation itself supplies the authorization to
start an LLM turn. The governing invariant is:

> No LLM call without user input or a passed wake-gate.

That invariant is currently true by topology, not by the `Automations` service contract.
`Automations.wake` receives only a profile and automation id, so it cannot distinguish a manual
wake from a future scheduled wake. A scheduler that reused the service unchanged could therefore
reach Pi without user input and, for an automation with no gate, without any wake-gate at all. This
is stateful-audit finding 4 (`docs/research/stateful-audit.md:12`) and the missing enforcement point
is stated explicitly at `docs/research/stateful-audit.md:53-58`.

The coverage audit describes the same gap from the automation side. Ziggy has strict flat
frontmatter and a working gate, but no cron scheduler, dedupe, provenance, or list/inspect face
(`docs/research/starman-coverage-audit.md:86-98`). Its recommended reference shape is deliberately
small: Ziggy wake plus Hermes's claim discipline and Starman's stable trigger identity, not
OpenClaw's large scheduling subsystem (`docs/research/starman-coverage-audit.md:223-233`).
The detailed wake-gate finding calls for trigger provenance and Hermes's locked
advance-before-execute pattern before a scheduler ships
(`docs/research/starman-coverage-audit.md:174-183`).

Record these reference practices in the implementation comments and tests:

- Hermes advances `next_run_at` under a file lock before executing. This is at-most-once:
  a crash after the advance skips that run, and restart never replays the claimed due slot.
- Hermes uses run claims with a TTL for one-shot jobs.
- Hermes never constructs the agent for a declined gate or a `no_agent` run.
- Starman dedupes by `[automationId, revision, triggerKind, triggerId]`.
- Starman persists gate evidence with each run.

This slice adopts advance-before-run and stable trigger ids. It does not add one-shots, revisions,
run records, or `no_agent`, so TTL claims, revision-aware dedupe, and persisted gate evidence remain
future constraints rather than invented partial implementations.

## Current state

### Domain and parsing

`AutomationFileSchema` accepts exactly `version`, optional `gate`, optional `telegram-chat`, and a
non-empty prompt. `onExcessProperty: "error"` makes every unknown frontmatter key fail closed
(`src/domain/automation.ts:13-23`).

`parseAutomationFile` implements a deliberately small flat `key: value` format. It rejects missing
delimiters, malformed or duplicate keys, converts the two known scalar types, trims the Markdown
body into `prompt`, and decodes the result through the strict schema
(`src/domain/automation.ts:76-140`). The `Automation` value currently carries only id, version,
gate, Telegram chat id, and prompt (`src/domain/automation.ts:25-33`).

Effect's pinned Cron implementation accepts five fields, with seconds defaulting to zero, or six
fields with explicit seconds; invalid expressions return `CronParseError` in a `Result`
(`vendor/effect/packages/effect/src/Cron.ts:540-610`). `Cron.match` checks an instant against the
parsed schedule (`vendor/effect/packages/effect/src/Cron.ts:640-717`), while `Cron.prev` returns the
strictly previous scheduled instant (`vendor/effect/packages/effect/src/Cron.ts:763-786`).

### Wake path

`AutomationsShape.wake` currently takes only `(target, automationId)` and returns `void`
(`src/application/automations.ts:28-37`). `readAutomation` validates the id, reads
`<profile>/automations/<id>.md`, maps missing/read failures into typed errors, and parses the file
fresh on every wake (`src/application/automations.ts:42-62`).

The gate runs `/bin/sh -c` in the profile directory with a 30-second timeout
(`src/application/automations.ts:64-114`). Its shipped semantics are:

- clean exit `0`: proceed;
- clean nonzero exit: decline before `agent.openChat`;
- spawn failure: warn and proceed;
- timeout: warn and proceed.

The warning text and fail-open behavior are at `src/application/automations.ts:116-121`. The
decline occurs at `src/application/automations.ts:154-163`, and only afterward does wake call
`agent.openChat`, prompt the fresh automation session, print the reply, and optionally deliver it
to Telegram (`src/application/automations.ts:148-189`). This ordering is the seam that must continue
to prove zero Pi construction for a declined gate.

`AutomationsLive` acquires `ZiggyAgent` once as an application capability, but no Pi chat/runtime is
opened until `agent.openChat` is called (`src/application/automations.ts:191-196`).

### Resident gateway and CLI

`Gateway.runLoop` is already the resident process abstraction
(`src/application/gateway.ts:24-31`). Its scoped implementation owns live chat handles and their
finalizer, then long-polls Telegram forever (`src/application/gateway.ts:180-242`). The scheduler
must have its own clock-driven loop; tying it to `getUpdates` would make schedule latency depend on
Telegram long-poll timing.

The CLI advertises manual `wake` and the three resident gateway faces, but no automation
list/inspect command (`src/main.ts:27-38`). The manual wake branch passes no provenance
(`src/main.ts:169-177`). The Telegram gateway branch loads config and yields the infinite gateway
loop (`src/main.ts:179-188`).

All application services are obtained before command dispatch (`src/main.ts:54-62`). Live layers
are currently composed through nested `Layer.merge` calls (`src/main.ts:240-267`), and process
teardown treats interruption of gateway commands as a clean exit (`src/main.ts:269-281`).

There is already a local precedent for crash-safe replacement: write a unique sibling temporary
file, `sync`, close, and rename over the target (`src/adapters/pi/pi-agent.ts:194-215`). There is
also a local exclusive-create lock with bounded wait and stale-lock recovery
(`src/adapters/pi/pi-agent.ts:225-274`). The schedule state implementation should reuse this shape
without importing Pi adapter internals.

## Locked decisions

1. Frontmatter gains one optional `cron:` key. Parse it with `Cron.parse` from the pinned `effect`
   package. Keep the existing flat parser and keep `onExcessProperty: "error"`; no YAML library,
   timezone key, or permissive unknown-key behavior is introduced.
2. Existing gate behavior stays byte-for-byte equivalent in outcome: nonzero exit declines;
   spawn failure and timeout warn and fail open.
3. Scheduling runs only inside the resident `ziggy gateway` process. There is no daemon, launch
   agent, socket, or second executable. Start one scheduler fiber in the gateway command's scope;
   do not start schedulers from `ziggy discord`, `ziggy slack`, TUI, `run`, `wake`, list, or inspect.
4. `wake` gains a trigger parameter:
   `{ kind: "manual" | "schedule", id: string }`. Every wake log line includes both fields.
   Scheduled trigger ids are the scheduled firing instant's canonical `Date.toISOString()` value.
5. A scheduled wake with no configured gate is declined before `agent.openChat`. Manual wake with
   no gate continues to work. This is the enforcement added by provenance: scheduled work must pass
   through the configured gate policy, while manual work is authorized by user input. For this
   slice, spawn-failure and timeout count as an admitted gate evaluation because the locked shipped
   policy is fail-open; the warning must make that evidence visible.
6. The scheduler stores `<profile>/automations/.schedule-state.json` as one JSON object mapping
   automation id to `lastFiredAt` ISO string. `lastFiredAt` is the scheduled slot, not claim time,
   start time, or completion time.
7. Claim a due slot by atomically updating that state file before calling `Automations.wake`.
   Crash after the state write and before/during wake intentionally loses that run. Restart never
   replays it.
8. A process-local `Set<AutomationId>` prevents overlapping scheduled runs of the same automation
   id. It is not a cross-process run-history mechanism.
9. The CLI adds read-only plural `automations` list and inspect forms. Neither command reads or
   reports `.schedule-state.json`.

## Steps

Implement in four logical blocks. Each block should leave `bun run check` green; add focused tests
with the block that introduces the invariant. Expected implementation time is about four to six
hours, including tests and the two restart proofs.

### 1. Domain: cron and trigger identity

Modify `src/domain/automation.ts`.

1. Import `Cron` and `Result` from `effect`.
2. Add `cron: Schema.optional(Schema.String.check(Schema.isMinLength(1)))` to
   `AutomationFileSchema`. Do not special-case it in the line parser: it remains a string like
   `gate`, while `version` and `telegram-chat` retain their existing scalar conversions.
3. After strict frontmatter decoding, parse a present cron expression with `Cron.parse`. Convert a
   failed `Result` into `AutomationInvalid` with:
   - `path: filePath`;
   - a stable message naming the automation id and invalid cron expression;
   - the `CronParseError` as `cause`.
   Do not call `Cron.parseUnsafe`, throw, or accept the file with an inactive schedule.
4. Represent the validated schedule without reparsing at every consumer. Use a domain value such
   as:

   ```ts
   export interface AutomationCron {
     readonly expression: string;
     readonly schedule: Cron.Cron;
   }
   ```

   Add optional `cron?: AutomationCron` to `Automation`. The original expression is the CLI
   projection; `schedule` is the scheduler/wake authority.
5. Add the provenance type:

   ```ts
   export type AutomationTrigger =
     | { readonly kind: "manual"; readonly id: string }
     | { readonly kind: "schedule"; readonly id: string };
   ```

   Keep it in the domain because the CLI face, scheduler, wake service, and logs must agree on the
   same identity.
6. Add a helper that validates a schedule trigger id as a canonical ISO instant. Parse it as a
   `Date`, require a finite timestamp, and require `date.toISOString() === trigger.id`. This keeps
   scheduled ids stable rather than accepting multiple strings for one instant.
7. Interpret cron expressions in the gateway process's local timezone because no timezone field is
   part of this slice. `Cron.parse(expression)` must therefore be called without a timezone
   argument. The trigger id remains UTC ISO, so dedupe is stable across display timezone and DST
   transitions.

Acceptance for this block:

- old automation files still parse unchanged and have `cron === undefined`;
- `cron: * * * * *` parses and retains the exact expression;
- five- and six-field Effect cron expressions are accepted;
- empty, malformed, or out-of-range cron expressions return `AutomationInvalid`;
- an unknown key still returns `AutomationInvalid`.

### 2. Application: wake contract, inventory, scheduler, and state

#### 2.1 Extend `Automations`

Modify `src/application/automations.ts`.

1. Change `wake` to:

   ```ts
   readonly wake: (
     target: ProfileTarget,
     automationId: string,
     trigger: AutomationTrigger,
   ) => Effect.Effect<AutomationWakeOutcome, AutomationError>;
   ```

2. Return a small, non-persisted `AutomationWakeOutcome` that makes gate behavior testable:
   completed, missing-gate decline, nonzero-gate decline, or completed-after-fail-open. Include the
   trigger and gate evidence needed for logs, but do not turn it into run history.
3. Prefix every wake log with one stable label, for example:
   `[wake] <automation-id> trigger=<kind>:<id>`. Apply it to gate decline, gate fail-open,
   dispose failure, skipped Telegram delivery, and completion output. Avoid a log line that loses
   provenance.
4. Preserve the current gate implementation and timeout. Refactor only enough to produce the
   outcome/log evidence; do not change exit-code, spawn-failure, or timeout decisions.
5. Before running a gate for a scheduled trigger:
   - validate the trigger id as canonical ISO;
   - require `automation.cron`;
   - require the scheduled instant to match the automation's currently parsed cron using
     `Cron.match`.

   Missing cron or a no-longer-matching instant is a fail-closed scheduled decline before
   `agent.openChat`. This is the revision-recheck substitute available in the current format. It
   catches removal or most cron edits between scan and wake. It cannot distinguish two revisions
   whose cron expressions both match the same instant; true revision-aware dedupe remains out of
   scope.
6. For a scheduled automation with no `gate`, log `gate missing — no model call` and return the
   missing-gate outcome before `agent.openChat`.
7. Manual triggers keep shipped behavior: no gate means proceed; a configured gate still runs and
   can decline or fail open.
8. Keep `readAutomation` as the single parser path. Add:
   - `scan(target): Effect<ReadonlyArray<AutomationScanEntry>, AutomationFileSystemError>`;
   - `list(target): Effect<ReadonlyArray<Automation>, AutomationError>`;
   - `inspect(target, automationId): Effect<Automation, AutomationError>`.

   `scan` reads `<profile>/automations`, considers only regular `*.md` entries, validates each
   basename as an automation id, and parses every file through `readAutomation`. Each
   `AutomationScanEntry` is either a parsed automation or a typed per-file failure, so callers can
   choose their policy without duplicating filesystem traversal. A missing directory returns an
   empty list; failure to read the directory itself remains a typed effect failure. Ignore dotfiles
   and `.schedule-state.json`.

   `inspect` delegates to `readAutomation`. `list` delegates to `scan`, fails on the first
   per-file failure, extracts parsed automations, and sorts by id. The scheduler also delegates to
   `scan`, logs each per-file failure, and continues with the valid entries. This preserves strict
   CLI validation while preventing one bad file from disabling unrelated schedules.

Gate ordering is non-negotiable: every decline path must return before the current `openChat`
boundary at `src/application/automations.ts:165-170`.

#### 2.2 Add the scheduler service

Add `src/application/automation-scheduler.ts`. Keep it separate from
`src/application/gateway.ts`: `automations.ts` currently imports Telegram helpers from
`gateway.ts` (`src/application/automations.ts:17`), so importing `Automations` back into
`gateway.ts` would create an avoidable application-module cycle.

Define `AutomationScheduler` with:

```ts
readonly runLoop: (target: ProfileTarget) => Effect.Effect<never>;
```

`AutomationSchedulerLive` depends on `Automations`. The production loop is:

1. Run a scan immediately on startup.
2. Sleep one second.
3. Run another scan.
4. Repeat forever.

One second matches Effect Cron's six-field, seconds-capable grammar. A cycle must not wait for a
scheduled wake to finish; claim and fork due wakes in the current scope. Catch and log individual
automation failures so one invalid file, gate failure, Pi failure, or Telegram delivery failure
does not kill either the scheduler loop or Telegram gateway.

Factor one deterministic `runScheduleCycle` seam that receives the current instant and a wake
capability. Production supplies the Effect clock and `Automations.wake`; tests supply a fixed
instant and a counter/failing wake. Do not use real sleeps or wall-clock minute boundaries in unit
tests.

#### 2.3 Compute one due slot

For every valid automation with `cron`:

1. Compute the latest scheduled instant at or before the cycle's current whole second. Because
   `Cron.prev` is strict, use the next whole-second boundary as its exclusive upper bound:

   ```ts
   const upperBound = new Date(Math.floor(now.getTime() / 1_000) * 1_000 + 1_000);
   const firingInstant = Cron.prev(automation.cron.schedule, upperBound);
   ```

   This includes a match in the current second without selecting a future second.
2. Convert `firingInstant` once with `toISOString()`. That exact string is both the state value and
   `{ kind: "schedule", id }`.
3. Compare instants by parsed epoch milliseconds, not lexicographic strings.
4. A slot is claimable only when it is strictly newer than the stored `lastFiredAt`.
5. When state has no entry, claim only this latest slot. Do not enumerate or replay every missed
   slot. Thus starting at `12:00:30` for `* * * * *` claims `12:00:00` once; restarting before
   `12:01:00` computes the same slot and skips it.
6. If the host clock moves backward or state contains a later firing instant, do nothing until cron
   produces a strictly later slot.

This is at-most-once scheduling, not catch-up scheduling.

#### 2.4 Persist the claim before execution

The state path is exactly:

```text
<profile>/automations/.schedule-state.json
```

The on-disk shape is exactly:

```json
{
  "daily-summary": "2026-07-25T13:00:00.000Z"
}
```

Implement the boundary as follows:

1. Decode unknown JSON through Effect Schema as a record of valid automation ids to canonical UTC
   ISO strings. Missing file means `{}`. Malformed JSON, an invalid key, a non-string value, or a
   noncanonical date fails closed: log the state error and fire nothing in that cycle. Never replace
   unreadable state with `{}`.
2. Use `<profile>/automations/.schedule-state.lock` to serialize
   read/check/write claims. Acquire with exclusive create, bounded retry, and stale-lock recovery,
   following the local lock shape at `src/adapters/pi/pi-agent.ts:225-274`. Always release in an
   `ensuring`/`finally`.
3. Re-read and decode state inside the acquired lock. Do not make a claim decision from a snapshot
   read before the lock.
4. If the candidate is newer, update only that id in memory and serialize keys in lexical order
   with a trailing newline.
5. Write a unique temporary sibling, sync and close it, then rename over
   `.schedule-state.json`, following `src/adapters/pi/pi-agent.ts:194-215`. Clean up the temporary
   file on ordinary failure.
6. Release the lock before executing the automation.
7. Only after the rename succeeds may the scheduler call:

   ```ts
   automations.wake(target, automation.id, {
     kind: "schedule",
     id: firingInstant.toISOString(),
   })
   ```

8. If the process crashes after step 5, the slot stays claimed and is skipped after restart. If
   state persistence fails, do not call wake.

Keep old ids in the state file when an automation is deleted. This avoids a cleanup
read/modify/write path and keeps re-adding the same id from replaying an old slot. The file is an
idempotency cursor, not a catalog or history.

#### 2.5 Prevent same-process overlap

`AutomationSchedulerLive` owns one `Set<AutomationId>` for its lifetime.

1. Check the set before trying to claim.
2. Add the id before forking the claimed wake.
3. Remove it in `Effect.ensuring` after success, typed failure, defect handling, or interruption.
4. While present, later cycles log or silently report `already in flight` and do not start another
   run for that id.
5. Different automation ids may run concurrently.

The durable state normally suppresses the same slot; the in-flight set additionally protects
against a later slot arriving while a long run is still active. Manual `ziggy wake` runs in another
process and is intentionally outside this process-local set.

#### 2.6 Start the scheduler in the gateway scope

Modify `src/main.ts`, not the Telegram polling loop.

1. Obtain `AutomationScheduler` beside the existing application services at
   `src/main.ts:54-62`.
2. In only the `case "gateway"` branch, wrap residency in `Effect.scoped`, fork
   `automationScheduler.runLoop(target)` with `Effect.forkScoped`, then yield
   `gateway.runLoop(target, config)`.
3. The scope ties scheduler interruption to gateway shutdown. A scheduler defect must be caught and
   logged inside its loop so it cannot silently disappear while Telegram continues.
4. Compose one shared `ZiggyAgent` layer, one `AutomationsLive` layer built from it, and one
   `AutomationSchedulerLive` layer built from that same automations layer. Replace only enough of
   the nested composition at `src/main.ts:240-267` to avoid constructing parallel service graphs.
5. Keep the clean gateway-interrupt teardown behavior at `src/main.ts:269-281`.

Do not add scheduler behavior to `src/application/gateway.ts`; its responsibility remains Telegram
session ownership and polling. The scheduler lives in the gateway process because `main.ts` owns
both scoped fibers.

### 3. Faces: automation list and inspect

Modify `src/main.ts`.

Add these usage lines:

```text
ziggy automations <name|path>        list profile automations
ziggy automations <name|path> <id>   inspect one automation
```

Add a strict `case "automations"`:

1. Require the profile argument and allow at most one following id. Extra arguments print the exact
   usage and set exit code 1.
2. With no id, call `automations.list(target)`. Print one tab-separated line per automation, sorted
   by id:

   ```text
   <id>    <cron expression|manual>    gate:<yes|no>    telegram-chat:<number|->
   ```

   If none exist, print `no automations`.
3. With an id, call `automations.inspect(target, id)` and print:

   ```text
   id: <id>
   version: 1
   cron: <expression|manual>
   gate: <command|->
   telegram-chat: <number|->
   prompt-head: <head>
   ```

4. Define `prompt-head` as the first 160 Unicode code points after collapsing all whitespace runs
   to one space and trimming. Append `…` only when content was truncated. Never print the full
   prompt.
5. Generate the manual wake trigger at the CLI boundary with `randomUUID()` and pass
   `{ kind: "manual", id }` to `automations.wake`. A UUID identifies the user invocation without
   pretending wall-clock time is a durable schedule id.
6. Keep list and inspect read-only. They do not create the automations directory, state file,
   sessions, or registry entries.

### 4. Tests and verification

Add focused Bun tests. Prefer deterministic dependency seams over subprocess sleeps.

#### Domain tests: `src/domain/automation.test.ts`

1. Existing frontmatter without cron parses as manual.
2. Valid five-field and six-field expressions parse through `Cron.parse`.
3. Invalid cron returns `AutomationInvalid`; assert the typed tag and stable message.
4. Empty cron fails.
5. Unknown frontmatter still fails closed after `cron` is added.
6. Canonical schedule trigger ISO validation accepts `Date#toISOString()` and rejects aliases,
   invalid dates, and noncanonical offsets.

#### Wake tests: `src/application/automations.test.ts`

Build `AutomationsLive` with a fake `ZiggyAgentShape` whose `openChat` increments a counter.

1. Scheduled trigger plus `gate: exit 1` returns declined, logs trigger provenance, and leaves the
   `openChat` counter at zero.
2. Scheduled trigger plus no gate returns missing-gate decline and leaves the counter at zero.
3. Scheduled trigger whose instant no longer matches the parsed cron returns stale-trigger decline
   and leaves the counter at zero.
4. Manual trigger plus no gate reaches `openChat` once.
5. Gate exit `0` reaches `openChat` once.
6. Spawn failure and timeout still warn and reach `openChat` once. Use an injected gate runner or
   process seam so the timeout test does not wait 30 seconds.

The key assertion is zero calls to `openChat`, not merely no prompt call: that proves gate-declined
work never constructs the Pi chat/runtime.

#### Scheduler tests: `src/application/automation-scheduler.test.ts`

Use a temporary profile, fixed instants, and a fake wake capability.

1. First cycle for `* * * * *` claims the latest minute, writes its exact ISO to state, then invokes
   wake with the same schedule trigger id.
2. Simulated crash: make wake defect immediately after invocation. Assert the state already contains
   the slot. Run another cycle at the same instant and assert wake was not invoked again. This proves
   advance-before-run.
3. Restart within the same minute reads state and does not re-fire.
4. A later minute fires exactly once and advances state.
5. Two cycles while the first wake is unresolved never overlap the same id; a different id can run.
6. Corrupt state fails closed and remains byte-for-byte unchanged.
7. State write failure invokes wake zero times.
8. A missing automations directory is an empty successful cycle.
9. One invalid automation logs a diagnostic without preventing a different valid due automation
   from being claimed.
10. A deleted id remains in state after another id advances.

#### CLI tests or captured-face assertions

Cover exact sorted list columns, exact inspect fields, 160-code-point prompt truncation, empty list,
extra-argument usage failure, and manual UUID provenance. If `main.ts` is not currently
subprocess-testable, extract only pure projection functions; do not introduce a CLI framework.

#### Repository gate and logical commits

After each logical block:

```sh
bun test
bun run check
git diff --check
```

Before committing, inspect the full dirty tree and stage only the scheduler block plus its matching
`LOG.md` entry. Do not absorb pre-existing worktree changes. Suggested commits:

1. `feat(automation): add cron and trigger provenance`
2. `feat(automation): add resident at-most-once scheduler`
3. `feat(cli): add automation list and inspect`

## Proof

The implementation is accepted only after both automated and gateway-level proof.

### Proof A: declined gate constructs no Pi runtime

Create a profile automation `every-minute.md`:

```md
---
version: 1
cron: * * * * *
gate: exit 1
---
Reply with the current minute.
```

Start `ziggy gateway <profile>` before a minute boundary and observe the next scheduled slot.
Required evidence:

1. The gateway process logs one line containing:
   `[wake] every-minute trigger=schedule:<scheduled-ISO> ... gate declined — no model call`.
2. `.schedule-state.json` contains that same scheduled ISO before the decline log.
3. No new file appears under `<profile>/sessions/automations/every-minute/`.
4. The focused fake-agent test reports `openChat` count `0`.

The log is operator evidence; the fake-agent counter is the definitive zero-model-construction
proof.

### Proof B: successful gate fires once and restart does not replay

Change only the gate to `gate: exit 0`. At the next minute:

1. The gateway logs one scheduled trigger id.
2. Exactly one fresh automation session is created.
3. The fake-agent/integration counter records exactly one model run.
4. `.schedule-state.json` contains the firing instant before the session/model side effect.

Stop and restart the gateway within that same minute:

1. The scheduler computes the same latest firing instant.
2. The stored value is equal, so no second wake log, session, or model call occurs.
3. At the following minute, exactly one new run occurs and state advances to the new ISO.

Capture the relevant log lines, state file, and before/after session-file counts in the
implementation handoff. `bun test`, `bun run check`, and `git diff --check` must all pass.

## Out of scope

Run history: no run records, result ledger, gate-evidence persistence, or `automations runs` face.

Webhooks: no external trigger protocol, HTTP listener, signature verification, or webhook claims.

Broadcast receipts: Telegram delivery stays as shipped; no idempotent receipt or replay authority.

`no_agent` runs: every accepted wake remains a Pi prompt run; script-only automation is not added.
