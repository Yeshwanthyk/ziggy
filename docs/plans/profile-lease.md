# Profile lease implementation plan

## Goal

Enforce the specification invariant that once a resident channel gateway exists for a Profile,
that gateway is the sole resident owner of the Profile's live sessions.

The implementation adds one Profile-scoped lease at:

```text
<profile>/.runtime/gateway.lock
```

Telegram, Discord, and Slack gateways must acquire the lease before entering their resident loop.
Local TUI and `run` faces must refuse to start while a live lease exists unless the operator passes
`--force`. `wake` remains allowed because it creates a fresh isolated session and memory writes are
now merge-safe under entry operations.

This is an ownership guard, not an attach protocol. It closes the current concurrency hole without
claiming to implement the eventual “local faces attach to the resident gateway” architecture.

## Context and audit evidence

The architecture changes ownership when residency begins: local faces initially own their
in-process runtimes, but after the first channel requires an independent lifetime, the resident
gateway owns live sessions and local faces eventually attach
(`docs/research/minimal-ziggy-scout.md:9`). Ziggy explicitly owns this process-ownership policy
(`docs/research/minimal-ziggy-scout.md:15`), and the Gateway walking-skeleton proof requires that
the gateway exclusively own live sessions (`docs/research/minimal-ziggy-scout.md:69`).

That transition is not enforced today. The audit's invariant table says the gateway owns its
per-chat handles but there is no Profile lease or local-face routing check
(`docs/research/stateful-audit.md:51-60`). Scenario a demonstrates that a gateway and TUI use
different session files but can still overlap as live Profile runtimes and historically raced on
shared memory (`docs/research/stateful-audit.md:64-68`). Scenario d shows that `run -c` does not
attach to or continue a gateway chat: Pi searches only direct session children and selects the
newest root session by mtime (`docs/research/stateful-audit.md:87-91`).

The Starman comparison identifies its PID-and-token Profile lock with stale takeover as the direct
reference and calls the missing Ziggy lock a real gap
(`docs/research/starman-coverage-audit.md:35-45`). Its cross-system session comparison concludes
that Ziggy's per-chat directories and in-process semaphores are otherwise appropriate at this
scale; the missing part is the cross-face lease
(`docs/research/starman-coverage-audit.md:212-221`).

The lease therefore enforces process ownership even though session JSONL files do not directly
collide. It also prevents an unforced local runtime from holding a stale prompt and writing Profile
memory concurrently with a resident gateway.

## Current state

### Runtime construction

`askOnce` creates or continues a root session under `<profile>/sessions`, constructs a Profile
runtime, and hands it to Pi print mode (`src/adapters/pi/pi-agent.ts:404-457`). `openTui` always
creates a new root session and enters Pi's interactive mode
(`src/adapters/pi/pi-agent.ts:647-669`). `openChat` creates or continues a runtime in a
caller-selected nested session directory and returns a long-lived prompt/dispose handle
(`src/adapters/pi/pi-agent.ts:607-645`).

There is intentionally no ownership check in any of those Pi adapter functions. `openChat` is
shared by resident gateways and isolated automation wakes, so placing the lease guard there would
incorrectly block `wake`. The enforcement boundary must distinguish faces before they reach the Pi
adapter.

### Resident gateway ownership

The Telegram run loop is already scoped, installs a finalizer for all chat handles, lazily opens
one long-lived chat handle per chat, and polls forever
(`src/application/gateway.ts:164-186`, `src/application/gateway.ts:188-240`). This scope is the
correct owner of lease acquisition and release.

Discord and Slack follow the same shape: each run loop is scoped, owns its socket and chat handles,
and blocks forever receiving channel input (`src/application/discord-gateway.ts:187-246`;
`src/application/slack-gateway.ts:191-251`). All three resident channel commands therefore need the
same Profile lease, rather than channel-specific lock files.

### Existing lock idiom

The shipped memory lock already demonstrates the local filesystem idiom to reuse:

- derive a sibling lock path and create its parent directory;
- create the lock with exclusive `open(..., "wx")`;
- write the current PID and close the file;
- on `EEXIST`, inspect the existing file and retry after stale removal;
- tolerate `ENOENT` races while inspecting/removing;
- unlink in `finally`.

The implementation is at `src/adapters/pi/pi-agent.ts:217-274`, and its scoped use around the
read/mutate/atomic-replace operation is at `src/adapters/pi/pi-agent.ts:319-350`. Its tests show the
repository's temporary-directory and post-release assertions
(`src/adapters/pi/memory-lock.test.ts:1-30`, `src/adapters/pi/memory-lock.test.ts:32-84`).

The Profile lease must reuse the exclusive-create, stale-inspection, and cleanup shape, but it must
not copy the memory lock's time-only eviction rule. A resident lease is live when its recorded PID
is live.

### CLI enforcement points

The current CLI advertises TUI, `run`, `wake`, and all three resident gateway commands without a
force flag (`src/main.ts:27-38`). `run` parses only `-c`/`--continue` before calling `runOnce`
(`src/main.ts:151-167`); `wake` directly invokes the automation service
(`src/main.ts:169-177`); Telegram, Discord, and Slack each load config then enter their independent
resident loop (`src/main.ts:179-207`); and the default branch opens the TUI directly
(`src/main.ts:213-217`).

Expected failures are rendered centrally through tagged-error handlers
(`src/main.ts:219-239`), services are composed before the single production execution edge
(`src/main.ts:240-269`), and resident commands already have interruption-aware teardown
(`src/main.ts:269-281`). The lease service and its errors should join these existing boundaries
instead of creating a second runtime edge.

## Locked decisions

1. **One path, one holder.** The lease path is exactly
   `<profile>/.runtime/gateway.lock`. Every resident channel gateway uses this same path. A live
   holder blocks every other Telegram, Discord, or Slack gateway for that Profile.

2. **Exclusive acquisition and scoped release.** Acquisition creates `.runtime/` recursively,
   then creates `gateway.lock` with `wx`. The file is removed when the acquiring Effect scope
   closes normally or through interruption. A crash or `kill -9` can leave the file behind, so
   stale takeover is required.

3. **Record format.** Store one newline-terminated JSON object:

   ```json
   {"pid":12345,"startedAt":"2026-07-25T14:30:00.000Z"}
   ```

   `pid` is a positive integer and `startedAt` is the acquisition time in ISO-8601 UTC form. The
   timestamp is diagnostic acquisition metadata; heartbeats update filesystem mtime rather than
   rewriting the record.

4. **Liveness is authoritative.** Probe the recorded PID with `process.kill(pid, 0)`. A successful
   call means alive, `EPERM` also means alive, and only `ESRCH` means the process no longer exists
   and the lease may be taken over. Any other probe failure is an expected typed lease error, not
   permission to delete the file.

5. **Mtime is a secondary signal.** Keep the memory lock's mtime-age idiom, but do not let age alone
   evict a PID that probes alive. The holder refreshes `gateway.lock` mtime on its scoped heartbeat
   cycle: touch immediately, every resident receive/poll iteration, and at least every 10 seconds
   through a scoped heartbeat fiber. Treat 60 seconds without a heartbeat as old. Inspection
   reports whether that heartbeat is fresh or old, while the PID probe decides whether takeover is
   safe. A dead PID is stale even if its mtime is recent, which makes post-`kill -9` recovery
   immediate.

6. **Single-holder stale takeover only.** Ziggy does not copy Starman's owner token, takeover
   marker, or contested-takeover protocol. A stale file is removed and acquisition retries with
   `wx`; ordinary simultaneous acquisition still has one winner. Do not add a second lock,
   takeover journal, or distributed consensus mechanism in this slice.

7. **Resident gateways fail closed.** Telegram, Discord, and Slack acquire the lease at startup
   before opening sockets, polling, or creating Pi chat handles. If a live holder exists, startup
   exits non-zero with the holder PID, timestamp, Profile path, and a clear “one resident gateway
   per Profile” message.

8. **TUI and `run` guard; `wake` does not.** TUI and `run` inspect the lease before constructing a
   Pi runtime. With a live holder they exit non-zero unless `--force` is present. `--force` leaves
   the resident lease untouched and prints a warning that concurrent memory writers can overwrite
   each other's facts. `wake` does not inspect or acquire this lease.

9. **One Profile, not one channel.** Different channel gateways do not get independent leases.
   Running Telegram and Discord as separate resident processes for one Profile is refused in this
   slice.

## State and transition contract

The authoritative state is the existence and decoded contents of
`<profile>/.runtime/gateway.lock`, interpreted together with local PID liveness. Mtime is derived
heartbeat state. Error messages, warnings, and process exit codes are projections, not ownership
authority.

The implementation must preserve these invariants:

- At most one successfully acquired resident gateway lease exists for a Profile.
- No resident loop opens a socket, polls a channel API, or creates a Pi runtime before acquisition.
- A live or `EPERM` PID is never evicted automatically, regardless of mtime age.
- An `ESRCH` PID can be removed and replaced through a new exclusive create.
- A holder only heartbeats or releases the same `pid` plus `startedAt` record it acquired; it must
  never touch a replacement record.
- TUI and `run` do not construct a runtime when inspection reports a live holder and `--force` is
  absent.
- `--force` never removes, rewrites, heartbeats, or acquires the gateway lease.
- `wake` behavior is unchanged.

The meaningful transitions are:

1. **Absent → held:** a gateway creates the directory and lock with `wx`, writes and syncs the
   record, closes the handle, and enters the resident loop.
2. **Held → refreshed:** the owner verifies the record still matches its acquisition record, then
   updates mtime.
3. **Held → absent:** scoped shutdown verifies ownership and unlinks the lock; `ENOENT` is
   idempotent success.
4. **Crash-held → stale → held:** a new gateway or local-face inspection reads the record, gets
   `ESRCH`, removes the stale file, and retries inspection/acquisition.
5. **Held → refused local face:** inspection gets alive or `EPERM`; TUI/`run` returns a typed
   refusal that the CLI prints.
6. **Held → forced local face:** the same inspection result is converted only at the face into a
   warning and permission to continue.

Malformed or unreadable lease content must fail closed with a message naming the path. Do not
silently delete it: there is no trustworthy PID to probe. The operator can inspect and remove a
corrupt file manually.

## Implementation steps

### Step 1: Add the domain lease contract

Create `src/domain/profile-lease.ts`.

Define:

- `ProfileLeaseRecord` and its Effect Schema for `{ pid, startedAt }`;
- a compiled decoder for the newline-terminated JSON representation;
- `ProfileLeaseStatus` as an explicit union covering `absent`, `live`, and `stale`, with decoded
  record, lock path, mtime, heartbeat age, and liveness result where applicable;
- named 10-second heartbeat-interval and 60-second heartbeat-staleness constants;
- tagged expected errors for live-holder refusal, invalid lease content, filesystem operations,
  and unsupported liveness-probe failures.

Use `Schema.TaggedErrorClass`, following the current domain error style at
`src/domain/gateway.ts:1-9` and `src/domain/agent.ts:4-29`. Keep structured fields such as
`profilePath`, `lockPath`, `holderPid`, and `startedAt`; callers must not parse user-facing message
strings to decide behavior.

Keep only data, decoding, classifications, and pure decision helpers in the domain module. Do not
import `node:fs`, call `process.kill`, run Effects, or encode CLI behavior there.

Define a pure local-face decision over `(lease status, force)`:

- absent or stale: allow;
- live plus `force: false`: refuse with `ProfileLeaseHeld`;
- live plus `force: true`: allow with a warning payload containing the holder metadata.

This makes refusal and override behavior directly unit-testable without starting Pi or a real
gateway.

Acceptance for this step:

- invalid PID, missing timestamp, invalid ISO timestamp, extra/malformed JSON, and non-object input
  fail decoding;
- live/stale decision tests do not inspect error-message text;
- domain code has no host imports.

### Step 2: Implement the Bun lease adapter and Effect service

Create `src/adapters/bun/profile-lease.ts` for host operations and
`src/application/profile-lease.ts` for the Effect-native capability used by the CLI and gateways.

The application service should expose:

```text
inspect(target) -> lease status
hold(target) -> scoped lease handle
```

The scoped handle exposes a `heartbeat` Effect and the decoded acquisition record. `hold` must use
`Effect.acquireRelease` or the pinned Effect v4 equivalent so release is tied to the surrounding
scope. Confirm the exact API against `vendor/effect` before implementation; do not add another
`Effect.run*` edge.

Adapter acquisition algorithm:

1. Resolve `join(target.path, ".runtime", "gateway.lock")` and create `.runtime/` recursively.
2. Generate the record once using `process.pid` and `new Date().toISOString()`.
3. Open with `wx`, write the JSON plus trailing newline, sync, and close.
4. If writing or syncing fails after creation, close the handle and best-effort unlink only the
   file created by this attempt, then return a typed filesystem error.
5. On `EEXIST`, read, stat, decode, and probe the existing holder.
6. If the file disappears during read/stat, retry from exclusive create.
7. If the PID is alive or probing returns `EPERM`, fail with `ProfileLeaseHeld`.
8. If probing returns `ESRCH`, unlink the stale path, tolerate `ENOENT`, and retry exclusive
   creation.
9. Bound filesystem-churn retries to eight attempts, waiting 25 milliseconds only after a
   retryable `ENOENT`/stale-removal race, then return a typed acquisition failure instead of
   spinning forever.

Inspection uses the same read/stat/decode/probe path. When it finds `ESRCH`, it removes the stale
file and returns `absent` after rechecking; this is what lets TUI start immediately after a crashed
gateway. A live but old heartbeat remains `live`, with the old-heartbeat fact included for
diagnostics.

Heartbeat and release must first re-read and decode the current path and compare both `pid` and
`startedAt` with the acquired record:

- on an exact match, heartbeat uses `utimes` to refresh mtime and release unlinks;
- on `ENOENT`, heartbeat reports lease loss and release is idempotent;
- on a different valid record, heartbeat reports lease loss and release leaves the replacement
  untouched;
- on invalid content, neither operation deletes the path.

Use the same error-code normalization style as `src/adapters/pi/pi-agent.ts:217-220`. Do not expose
raw Promise-returning filesystem operations through the application service; adapt them once with
Effect at the Bun boundary.

Acceptance for this step:

- a successful scope writes the exact record and removes it on scope close;
- a second holder sees the first as live and cannot enter;
- a dead holder is replaced;
- `EPERM` is classified live;
- an old mtime plus a live PID does not permit takeover;
- heartbeat advances mtime without changing file bytes;
- release cannot delete a different replacement record.

### Step 3: Acquire the lease in every resident gateway

Inject `ProfileLease` into `GatewayLive`, `DiscordGatewayLive`, and `SlackGatewayLive`.

For each run loop, acquire `hold(target)` as the first operation inside its existing
`Effect.scoped` region:

- Telegram: before allocating chat state or entering `getUpdates`
  (`src/application/gateway.ts:180-240`);
- Discord: before opening the socket (`src/application/discord-gateway.ts:187-198`);
- Slack: before `authTest` and socket creation (`src/application/slack-gateway.ts:191-201`).

Keep the lease scope outside and longer-lived than every socket, poll, and chat-handle scope. On
normal interruption, close channel resources and chat handles, then release the lease. If finalizer
ordering matters in Effect v4, acquire the lease first so it is released last.

Refresh mtime once immediately after acquisition and on every resident receive/poll cycle:

- before each Telegram long-poll attempt;
- before each Discord socket receive;
- before each Slack socket receive.

Start one shared scoped heartbeat fiber owned by `ProfileLease`, not three channel-specific timers.
It touches the lease every 10 seconds so idle sockets and long network failures remain fresh. The
fiber must stop with the lease scope, and heartbeat failure must fail the resident scope rather
than leave an unleased gateway running. Receive/poll loops still heartbeat before each iteration so
the file also records active channel progress.

Widen each gateway error union to include the lease errors that can escape startup or heartbeat.
Do not catch a lease-loss error inside the current per-message error handlers: lease loss is fatal
to the resident process, not a single-message failure.

Acceptance for this step:

- Telegram blocks Discord and Slack on the same Profile, and vice versa;
- no channel network operation occurs when acquisition fails;
- interruption removes the lease;
- `kill -9` leaves the file for stale takeover;
- a heartbeat failure terminates the resident process.

### Step 4: Guard TUI and `run`, and add `--force`

Update CLI usage and argument parsing in `src/main.ts`.

Use these user-facing forms:

```text
ziggy <name|path> [--force]
ziggy run [--force] [-c|--continue] <name|path> <prompt...>
```

For `run`, parse only leading recognized flags before the Profile argument so prompt text may still
contain the literal string `--force`. Accept `--force` and `-c`/`--continue` in either order, reject
duplicates and unknown leading flags with the usage message, and preserve the current prompt join
behavior. For TUI, accept only an optional trailing `--force`; reject additional trailing
arguments.

Before `agent.runOnce` at `src/main.ts:160-165` and before `agent.openTui` at
`src/main.ts:213-216`:

1. resolve the Profile target;
2. inspect the lease;
3. remove and recheck an `ESRCH` stale lease through the service;
4. apply the domain local-face decision;
5. refuse before Pi runtime construction, or print the force warning and continue.

Use stable copy:

```text
profile <path> is owned by resident gateway pid <pid> since <startedAt>; stop the gateway or rerun with --force
```

For an override, print to stderr:

```text
warning: --force is opening <path> while resident gateway pid <pid> is live; concurrent memory writers may overwrite each other's facts
```

For a second gateway, use:

```text
resident gateway pid <pid> already owns <path> since <startedAt>; only one resident gateway may run per profile
```

Add lease tags to the central `Effect.catchTags` handler at `src/main.ts:219-239` and provide the
lease Layer through the existing composition at `src/main.ts:240-267`.

Do not:

- add the guard to `PiAgent.askOnce`, `PiAgent.openTui`, or `PiAgent.openChat`;
- change `wake` at `src/main.ts:169-177`;
- acquire a local-face lease;
- remove the gateway lease when `--force` is used;
- silently downgrade lease decode/filesystem/probe failures to “no gateway.”

Acceptance for this step:

- TUI and both fresh and continuing `run` refuse before model/runtime setup under a live lease;
- `--force` prints exactly one warning and then follows the existing TUI/`run` path;
- `wake` follows its existing path without a lease check;
- malformed lease state fails closed with the lock path in the message.

### Step 5: Add focused invariant tests

Add `src/adapters/bun/profile-lease.test.ts` for the host lifecycle and
`src/domain/profile-lease.test.ts` for decoding and local-face decisions. Add a CLI-focused test
only if the parsing cannot be exercised as a pure exported helper without importing and executing
`src/main.ts`.

Required cases:

1. **Acquire/release:** in a temporary Profile, a scoped acquisition creates
   `.runtime/gateway.lock` with the current PID and a valid ISO timestamp; a second acquisition
   fails as held; closing the scope removes the file.
2. **Stale takeover:** create a record for a child process that has definitely exited, set its
   mtime old, acquire, and assert the new record contains the test process PID. Do not rely on a
   guessed “probably unused” PID.
3. **Liveness precedence:** a record for the current live process with an old mtime still refuses
   takeover. Test the `EPERM` branch through an injected liveness-probe seam or a deterministic
   adapter unit, not an OS-permission assumption.
4. **Heartbeat/ownership:** force the acquired file mtime old, heartbeat, assert mtime advances and
   bytes do not change; replace the record and assert the old holder's heartbeat/release cannot
   touch it.
5. **Local refusal/force:** a live status plus `force: false` produces the tagged refusal; the same
   status plus `force: true` produces allow-with-warning metadata; absent and dead-stale statuses
   allow without a warning.

Keep tests deterministic: inject clock/liveness functions at the narrow Bun adapter seam where
needed, use temporary directories, and avoid real model, Telegram, Discord, or Slack calls. Follow
the cleanup style in `src/adapters/pi/memory-lock.test.ts:8-30`.

After implementation, run:

```sh
bun test
bun run check
```

`bun run check` is the repository gate defined at `package.json:7-13`; it covers formatting, lint,
and typechecking but not tests, so both commands are required.

## Proof

Use an initialized, model-configured Profile that also has one resident channel configured. The
examples use Telegram, but Discord or Slack must prove the same lease behavior.

### Normal refusal and scoped release

Terminal 1:

```sh
bun src/main.ts gateway <profile>
```

Confirm `<profile>/.runtime/gateway.lock` exists and contains the gateway PID plus acquisition
timestamp.

Terminal 2:

```sh
bun src/main.ts <profile>
```

Expected result: Ziggy exits non-zero before opening Pi TUI and prints:

```text
profile <resolved-path> is owned by resident gateway pid <pid> since <timestamp>; stop the gateway or rerun with --force
```

Also prove `run`:

```sh
bun src/main.ts run <profile> "lease proof"
```

Expected result: the same refusal occurs before any model call or new session file.

Back in terminal 1, interrupt the gateway with Ctrl-C. Confirm
`<profile>/.runtime/gateway.lock` is gone. Starting the TUI now must follow its normal path.

### Force warning

With the gateway running:

```sh
bun src/main.ts <profile> --force
```

Expected result: Ziggy prints the concurrent-memory-writer warning exactly once and then opens the
TUI. Exiting that forced TUI must not remove or modify the gateway's lease.

### Crash and stale takeover

Start the gateway again, read the PID from `gateway.lock`, and terminate it with `kill -9`. Confirm
the lock file remains. Then run:

```sh
bun src/main.ts <profile>
```

Expected result: inspection probes the recorded PID, receives `ESRCH`, removes the stale lease, and
starts the TUI without requiring `--force`. There must be no fixed wait for mtime expiry.

Exit the TUI, restart the gateway, and confirm it can acquire a fresh lease at the same path.

## Open questions

1. Should TUI and `run` later route through the resident gateway instead of refusing? That is the
   specification's eventual “local faces attach” model
   (`docs/research/minimal-ziggy-scout.md:9`). It requires an attach protocol, session identity,
   replay/reconnect semantics, and outcome handling, so it is explicitly out of scope here.

2. Should multiple channel gateways for one Profile eventually share one lease? **Recommendation:
   yes.** One resident process per Profile should host all enabled channels under one lease. The
   current separate `gateway`, `discord`, and `slack` commands can enforce the one-process rule now;
   later consolidation can compose their channel loops inside that single owner.

## Out of scope

- An RPC/socket attach protocol or routing local prompts through the gateway.
- A stable `main` session or changes to Pi's `continueRecent` semantics.
- Owner tokens, takeover markers, contested takeover, multi-host leases, or distributed locking.
- Guarding or routing `wake`; it remains a fresh isolated automation session.
- Further memory freshness or merge changes beyond the already shipped entry-operation locking.
- Telegram update idempotency, durable delivery receipts, session JSONL repair, or wake claims.
- A `doctor` command, manual lease-management command, or channel-configuration consolidation.
- Changes to Pi adapter runtime construction unless a compile-time error proves they are necessary.
