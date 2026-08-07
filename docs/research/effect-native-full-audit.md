# Effect-native full-repository audit

Date: 2026-08-06

Historical baseline: 2026-08-07 — commits `7e41cfd..2bd88da`. Current adjudication: HEAD `d8718c1`.

## Conclusion

Ziggy is **not yet Effect-native throughout its core architecture**.

The domain model is mostly sound and `src/main.ts` remains the only production Effect execution edge. This report's baseline findings are historical: the scheduler publication windows, chat acquisition gap, Pi memory Promise island, application automation/config filesystem reads, and Promise-shaped Discord/Slack socket contracts were corrected in the subsequent commits listed below. The remaining architectural pressure is narrower: Profile workflow filesystem ownership, concrete adapter selection in application composition, PID-only recovery identity, the Gateway pathname protocol, and deliberately low-confidence lint heuristics. The raw-fetch rule now matches the written Telegram-only policy.

The current checkout contains **122 tracked code-like files** with `.ts`, `.mjs`, `.py`, or `.sh` extensions (excluding `vendor/effect`). This adjudication inspects the seven commits after the historical audit, current tests and scans, and the pinned Effect submodule; it does not repeat the original repository-wide inventory.

### Historical verification snapshot

- Historical reviewed HEAD: `2bd88da` (`docs: record gateway lifecycle completion`).
- Historical `bun run test`, `bun run typecheck`, `bun run check`, and `git diff --check 7e41cfd..2bd88da`: **passed**.
- Current verification and dispositions are recorded in **Current HEAD adjudication** below.

The earlier snapshot at `70adab8` remains the baseline for findings 1–10. The recent-commit addendum below updates that baseline for the durable automation scheduler, SQLite ledger, resident Gateway, Profile owner record, process-group gate termination, new CLI projections, and lifecycle recovery.

## Recent-commit addendum: durable scheduler and resident Gateway

### Scope

Nine commits landed after audit commit `7e41cfd`:

| Commit | Change | Audit effect |
|---|---|---|
| `cbd6512` | Terminate automation gate process groups | Strengthens timeout/interruption cleanup; swallowed signaling failure remains. |
| `bfc6650` | Freeze scheduler Slice 3 plan | Useful historical design, but now stale after Slice 4 composition. |
| `dbf9f0b` | Durable automation scheduler engine | Adds SQLite authority, scheduler service, lifecycle recorder, projections, CLI, and new Effect boundaries. |
| `287ae00` | Slice 3 correctness correction | Prevents recovery of owners considered alive and hardens lifecycle writes; PID reuse remains ambiguous. |
| `e7c4ba1` | Projection invariants | Strengthens read-side Schema validation and completion ordering. |
| `ccf459e` | Resident Gateway composition | Adds one resident owner, scheduler/channel supervision, and shutdown ownership. |
| `4ae4f7a` | Dangling-config fail-closed behavior | Correctly blocks all runtime work before ownership, but extends application filesystem ownership. |
| `317f176` | Run lifecycle recovery | Improves dead-owner recovery and truthful terminal failure handling; interruption publication gaps remain. |
| `2bd88da` | Lifecycle completion log | Documents the slice but does not update the frozen scheduler plan or this audit. |

The delta changes 21 files and adds 4,764 lines. `LOG.md` records the slice history, and `docs/plans/automation-scheduler.md` is the changed design document assessed below. Four new production surfaces require explicit classification:

- `src/adapters/bun/automation-sqlite.ts`
- `src/adapters/bun/gateway-owner.ts`
- `src/application/automation-scheduler.ts`
- `src/application/resident-gateway.ts`

**Complete 21-file delta**

| File | Disposition in this report |
|---|---|
| `LOG.md` | Commit history; new audit entry appended without changing the existing operator-projections entry. |
| `docs/plans/automation-scheduler.md` | New stale-spec finding L. |
| `src/adapters/bun/automation-gate.ts` | Keep process-group termination; action J for signaling-failure observability. |
| `src/adapters/bun/automation-gate.test.ts` | Keep real process-group proof; add deterministic group/fallback failure cases. |
| `src/adapters/bun/automation-sqlite.ts` | New authority; findings A, D, G, H, K and lower-priority close policy. |
| `src/adapters/bun/automation-sqlite.test.ts` | Strong transaction/schema proofs; add instance-identity and invalid-write proofs. |
| `src/adapters/bun/gateway-owner.ts` | Findings D, E, F, I and runtime-throw observation. |
| `src/adapters/bun/gateway-owner.test.ts` | Strong exclusion/release proof; add PID reuse, handoff, TOCTOU, cleanup cases. |
| `src/adapters/bun/process.ts` | Existing swallowed-kill finding remains and now affects process-group fallback. |
| `src/application/automation-scheduler.ts` | Findings A and G; scoped worker ownership is otherwise sound. |
| `src/application/automation-scheduler.test.ts` | Strong TestClock/concurrency proof; missing commit-to-fork interruption case. |
| `src/application/automations.ts` | Findings B, C, G; prior application filesystem finding remains. |
| `src/application/automations.test.ts` | Prior unsafe tree helper is gone; add interruption/publication and chat-bracket proofs. |
| `src/application/resident-gateway.ts` | Finding G; extends application filesystem/cause-preservation findings. |
| `src/application/resident-gateway.test.ts` | Strong supervision/preflight proof; strengthen exact failure assertions and SIGTERM. |
| `src/domain/automation.ts` | Finding K and schema/type ownership re-evaluation; persisted read schemas are a strength. |
| `src/domain/automation.test.ts` | Keep parsing/fingerprint proofs. |
| `src/domain/gateway.ts` | Existing `GatewayConfigError` cause gap remains; `GatewayOwnerError` is structured. |
| `src/faces/automation-cli.ts` | Keep pure bounded projection rendering. |
| `src/faces/automation-cli.test.ts` | Keep exact deterministic rendering/projection proofs. |
| `src/main.ts` | Sole execution edge remains; distributed CLI/env decoding finding grows. |

### Authoritative state and transition map

**Authorities**

- `.runtime/automation-scheduler.sqlite` owns schedule cursors, occurrence claims, run lifecycle, target outcomes, and scheduler heartbeat evidence.
- `.runtime/gateway-owner.lock` is the Profile's resident-process exclusion marker.
- automation Markdown remains the definition authority; SQLite stores observations and run truth, not a second editable definition.
- `automations status` and `runs` are read-only projections over SQLite plus current observation time.

| Transition | Actor | Guard | Atomic write/publication | Recovery/proof |
|---|---|---|---|---|
| Reconcile definitions | scheduler | Profile definition scan completed | schedule rows and tick state | invalid/unreadable definitions become explicit state; scan failure re-arms at 60s |
| Claim occurrence | SQLite adapter | expected schedule row still matches; no active same-ID run | cursor advancement and `claimed` row in one `IMMEDIATE` transaction | stale proposal retries; missed range is compacted, never replayed |
| Register run worker | scheduler Effect | committed claim returned | scoped child fiber | **gap:** interruption can occur after claim commit but before child registration |
| Start run | automation service | matching `claimed` row, fingerprint, owner | `claimed → running` | dead owners later become `unknown` |
| Execute | automation service | running row | gate, Pi, print, delivery outside DB transaction | scoped/finalized resources should publish one truthful terminal state |
| Finish | run store | matching running row and owner | terminal row plus ordered target outcomes in one transaction | terminal DB failure is surfaced and not followed by a fabricated retry |
| Recover active run | scheduler/manual admission | owner PID considered dead | `claimed/running → unknown` | **gap:** PID reuse can make an orphan appear live forever |
| Acquire resident | Gateway owner adapter | owner path absent | hard-link candidate to owner pathname | malformed/stale records fail closed; operator removes stale record |
| Release resident | scope finalizer | record owner ID matches handle | unlink owner pathname | **gap:** read/compare/unlink is not atomic against pathname replacement |

**Safety invariants already enforced**

1. Cursor advancement and occurrence claim commit together.
2. One active run per automation is enforced by a partial unique SQLite index.
3. Gateway ownership, scheduler workers, and channel workers are scope-owned.
4. Gate/model/delivery work does not run inside SQLite transactions.
5. Unknown interrupted work is not replayed as if it had never started.
6. Read projections validate persisted rows and do not create an absent database or sidecars.
7. Scheduler failure interrupts channel siblings before Gateway owner release.
8. Expected channel failures are isolated from scheduler and healthy channels.

### New P1 findings

#### A. Claim commit and child registration are not interruption-atomic

**Files and methods**

- `src/application/automation-scheduler.ts:151-171` — `scan`
- `src/application/automation-scheduler.ts:187-225` — `cycle`
- `src/adapters/bun/automation-sqlite.ts:255-354` — `commitScheduleTick`

`commitScheduleTick` advances the schedule cursor and inserts `claimed` rows before `cycle` forks the corresponding `automations.run` workers. The parent remains interruptible between the commit and each `Effect.forkScoped`.

If interrupted in that window, the claim belongs to the still-live Gateway PID but no child exists to start or finish it. Dead-owner recovery will not touch it, and the active-run index makes future occurrences `skipped-busy` until the Gateway process exits.

**Target shape**

Protect only the publication window with `Effect.uninterruptibleMask`: commit claims, register one scoped child for every returned claim, and restore interruptibility inside each child's actual run. Alternatively, compensate every unregistered claim before allowing interruption. Do not make gate/model/delivery execution uninterruptible.

**Missing proof**

Pause immediately after the SQLite commit, interrupt the scheduler scope, and prove every committed claim has either a registered scoped child or a compensating terminal transition.

#### B. Run terminal publication has an interruption gap

**File and method**

- `src/application/automations.ts:253-393` — `makeAutomations.run`

`Effect.onInterrupt` currently wraps `execute`, while the success-path `finish(intent.terminal, intent.targets)` runs afterward. Interruption after `execute` returns—or while the final terminal write is pending—can leave the row `running`. Later recovery records `unknown/process-start`, not the intended truthful `failed/interrupted` state.

**Target shape**

Model the post-`start` lifecycle as one bracketed transition with exactly one terminal publication attempt on success, typed failure, or interruption. An `onExit`/`acquireUseRelease`-style owner may be appropriate, but it must preserve the existing invariant that a failed terminal DB write is surfaced and is not followed by a fabricated second finish.

**Missing proof**

Interrupt during prompt, after execution intent, and while terminal persistence is suspended. Assert the exact number of terminal attempts and the chosen persisted state.

#### C. Chat acquisition and disposal are not structurally bracketed

**File and method**

- `src/application/automations.ts:311-331` — `openChat`, `prompt`, `dispose`

`openChat` is yielded before `prompt(...).pipe(Effect.ensuring(dispose))` is constructed. The code usually reaches the ensuring region immediately, but the acquisition-to-finalizer-registration window is not protected by the resource combinator intended for this invariant.

**Target shape**

Use `Effect.acquireUseRelease` for `openChat → prompt → dispose`, with an explicit policy for prompt failure plus disposal failure. Keep disposal before print/delivery if that ordering is intentional.

**Missing proof**

Interrupt immediately after successful acquisition and during prompt; assert `dispose` exactly once.

#### D. PID liveness is not a durable owner identity

**Files and methods**

- `src/adapters/bun/automation-sqlite.ts:212-233` — `recoverAutomationRuns`
- `src/adapters/bun/gateway-owner.ts:49-56` — `pidIsAlive`
- `src/adapters/bun/gateway-owner.ts:80-105` — `inspectExistingOwner`

Both authorities treat `process.kill(pid, 0)` success as proof that the original owner still exists. A reused PID can make an orphaned run permanently active and a stale Gateway record permanently held by an unrelated process.

**Target state**

Persist a non-reusable process-instance identity alongside the PID. Resident scheduled runs can use the authoritative Gateway instance token; manual runs need the short-lived CLI process's own instance token. Where available, include OS process-start identity for diagnostics. Recovery should compare instance identity rather than infer identity from PID or heartbeat; heartbeat remains evidence, not a lease.

**Missing proof**

Simulate a live numeric PID with a mismatched process/instance identity and prove the old ownership is classified stale or uncertain rather than live.

#### E. Gateway release can unlink a replacement owner record

**File and method**

- `src/adapters/bun/gateway-owner.ts:151-172` — `release`

Release reads the pathname, compares `ownerId`, then later unlinks the pathname. A replacement between comparison and unlink can be removed by the old owner. The current “foreign owner” test replaces the record before release reads it and does not exercise this TOCTOU.

**Target shape**

Use an ownership protocol whose release is conditional on the same filesystem identity that was verified, or serialize replacement/removal through an atomic directory protocol. If that is intentionally out of scope, weaken the claimed guarantee and document manual replacement as unsafe during release.

**Missing proof**

Pause after owner verification, replace the pathname, resume release, and prove the replacement survives.

### New P2 findings

#### F. Normal Gateway handoff can fail spuriously

**Files and methods**

- `src/adapters/bun/gateway-owner.ts:138-145` — failed hard-link path
- `src/adapters/bun/gateway-owner.ts:77-85` — owner inspection

A contender may receive `EEXIST`, then the winner may release before the contender reads the owner file. `ENOENT` is currently translated to `unreadable`, so an ordinary handoff can fail even though ownership is available.

**Target shape**

Retry the complete atomic acquisition in a bounded loop only for the `EEXIST → ENOENT` race. Continue failing closed for malformed records and non-`ENOENT` inspection failures.

#### G. New application services depend directly on concrete host adapters

**Files and methods**

- `src/application/automation-scheduler.ts:2-14` — direct imports from `automation-sqlite`
- `src/application/resident-gateway.ts:1-66` — direct Node filesystem adaptation
- `src/application/automations.ts:81-156` — existing definition/broadcast filesystem adaptation

The new APIs return Effects, so no Effect execution escapes, but application orchestration still selects Bun/SQLite/Node implementations directly. Scheduler policy cannot be tested independently from the real SQLite store, and resident preflight owns host error-code interpretation.

**Target shape**

Add Effect-native capabilities/Layers for the automation ledger, definition source, projection store, and resident Gateway config store. Keep reconciliation, scheduling, supervision, and product policy in application services; keep SQLite/Node details in adapters.

#### H. Definition discovery is one coarse, uncancellable Promise workflow

**File and method**

- `src/adapters/bun/automation-sqlite.ts:456-469` — `discoverAutomationSources`

The entire directory traversal and sequential file-read loop is hidden in one async `Effect.tryPromise`, and its cancellation signal is ignored. The Promise boundary is correctly located in an adapter, but orchestration cannot regain interruption control between files.

**Target shape**

Adapt `readdir` and each `readFile` separately, then orchestrate with `Effect.forEach`. Pass cancellation signals where the host API supports them; otherwise at least restore cancellation between reads.

#### I. Candidate cleanup discards every failure

**File and method**

- `src/adapters/bun/gateway-owner.ts:121-148` — `acquire` final cleanup

`Effect.promise(() => unlink(candidate).catch(() => undefined))` converts all candidate cleanup outcomes into infallible success. Unexpected permission or filesystem failure leaves hidden candidate files.

**Target shape**

Use a typed cleanup Effect, ignore only verified `ENOENT`, and log unexpected cleanup failures before satisfying the infallible finalizer requirement.

#### J. Process-group cleanup still swallows signaling failures

**Files and methods**

- `src/adapters/bun/automation-gate.ts:37-42` — process-group signal and fallback in `liveHost.kill`
- `src/adapters/bun/process.ts:30-36` — `killProcess`

The process-group behavior is a real improvement and the integration test proves a representative shell and child die. However, both group signaling and fallback child signaling can fail silently for non-`ESRCH` causes.

**Target shape**

Treat already-exited `ESRCH` as benign. Surface or log `EPERM` and unexpected failures, and test the path where both group and fallback signals fail.

#### K. Write-side lifecycle contracts are weaker than persisted schemas

**Files and symbols**

- `src/adapters/bun/automation-sqlite.ts:236-240` — `ScheduleOccurrence`, `ScheduleMutation`, `ScheduleCommitResult`
- `src/adapters/bun/automation-sqlite.ts:371-373` — `AutomationRunStore`, `RunTerminal`
- `src/domain/automation.ts:136-198` — trigger/projection types

Read-side persisted data is Schema-decoded and strongly checked, but write-side interfaces allow invalid fingerprints, failure categories, and terminal field combinations. A trusted internal caller can persist data that makes later projections fail closed.

**Target shape**

Move transition inputs to domain-owned schemas or tagged terminal variants that make invalid combinations unrepresentable. Decode at the transaction boundary and map validation failure into a typed transition/database error.

#### L. The frozen scheduler plan is no longer the current specification

**File**

- `docs/plans/automation-scheduler.md`

The document still says there is no production host, scheduled work is dormant, resident ownership is not implemented, and recovery/schema details that later commits changed. Mark it explicitly as a historical Slice 3 freeze or add a Slice 4/current-state section. Agents must not treat its stale statements as live architecture.

### Lower-priority recent observations

- `GatewayOwnerRuntime.makeOwnerId`, `now`, and `pidIsAlive` may throw outside their nominal typed contract. Either make the injected runtime Effect-shaped or adapt each call with `Effect.try`.
- `db.close(false)` runs in `Effect.sync`; an unexpected close throw becomes a defect. Confirm Bun's contract or translate recoverable close failures according to the adapter policy.
- `AutomationStatusProjection` and `AutomationTrigger` remain manual types adjacent to schema-owned persisted concepts; re-evaluate with `effect-schema-inferred-types` rather than retaining the old unconditional keep decision.
- `Cause.hasInterruptsOnly` in Gateway teardown maps any interrupt-only exit to zero, not only OS-signal intent. This is acceptable while no internal path intentionally interrupts the main Gateway fiber, but should be revisited if that changes.
- CLI/environment parsing remains distributed across `src/main.ts`; the new `gateway`, `automations status`, and `automations runs` branches increase the value of one decoded command union.

### Recent changes that should remain

1. `Effect.acquireRelease` correctly ties Gateway ownership to the resident scope.
2. `Effect.scoped` and unbounded `Effect.all` correctly supervise scheduler and channel branches; scheduler failure interrupts siblings before owner release.
3. `Effect.forkScoped` correctly owns workers once they have been registered.
4. SQLite claim/cursor commits use one short `IMMEDIATE` transaction.
5. SQLite connections use `Effect.acquireUseRelease`; no resident connection is leaked.
6. Synchronous Bun SQLite calls are appropriate at the adapter boundary. Wrapping them in fake Promises would not make them cancellable.
7. Read-only projections open with `create: false`, validate schema/rows, and do not initialize an absent database.
8. TestClock-based scheduler tests prove capped wake timing and interruption.
9. Process-group termination materially improves gate descendant cleanup.
10. Terminal DB failure is attempted once and is not hidden by a fabricated second terminal write.
11. Preflight happens before owner acquisition, and a dangling config prevents owner/scheduler/channel side effects.
12. Pure CLI projection rendering remains total synchronous work and does not need Effect.

### Recent test gaps

| File | Existing strength | Missing/weak proof |
|---|---|---|
| `src/application/automation-scheduler.test.ts` | TestClock timing, independent IDs, outage compaction, fatal DB propagation | commit-to-fork interruption; several assertions inspect partial projections |
| `src/application/automations.test.ts` | fresh run, recovery, truth-preserving terminal failure, ordered delivery | interruption after execution and during terminal commit; immediate post-acquire chat interruption |
| `src/adapters/bun/automation-sqlite.test.ts` | schema freeze, transactional claim, exclusion, recovery, projection fail-closed | PID reuse/instance identity; invalid write-side transitions; full plan-promised tree snapshot |
| `src/adapters/bun/gateway-owner.test.ts` | one-owner exclusion, interruption release, malformed/stale fail-closed | release TOCTOU; `EEXIST → ENOENT` handoff; PID reuse; cleanup failure |
| `src/application/resident-gateway.test.ts` | preflight ordering, branch supervision, CLI/signal integration | several config failures assert a broad tag rather than exact path/message/cause; SIGTERM path |
| `src/adapters/bun/automation-gate.test.ts` | real process-group timeout and direct interruption | both group and fallback signaling failure; deterministic error classification |

## Governing source of truth

The assessment uses:

- `.agents/skills/effect-runtime-boundaries/SKILL.md`
- `.agents/skills/effect-client-wrapper/SKILL.md`
- `.agents/skills/effect-raw-fetch-boundary/SKILL.md`
- `.agents/skills/effect-schema-boundaries/SKILL.md`
- `.agents/skills/effect-schema-inferred-types/SKILL.md`
- `.agents/skills/effect-value-inferred-types/SKILL.md`
- `.agents/skills/effect-typed-errors/SKILL.md`
- `.agents/skills/effect-tests/SKILL.md`
- `.agents/skills/typescript-type-safety/SKILL.md`
- `docs/research/minimal-ziggy-scout.md`
- `docs/research/pi-sdk-surface.md`
- pinned `vendor/effect` commit `6184a7dc53cb9310e299b65ad6d6c712c2cbf202`

Primary Effect references:

- `vendor/effect/packages/effect/src/Effect.ts:824-947` — `Effect.promise` and `Effect.tryPromise`.
- `vendor/effect/packages/effect/src/Effect.ts:1164-1207` — `Effect.callback` with interruption cleanup.
- `vendor/effect/packages/effect/src/Effect.ts:6400-6734` — `scoped`, `acquireRelease`, `acquireUseRelease`, `addFinalizer`.
- `vendor/effect/packages/effect/src/Effect.ts:8610-8660` — `forkScoped`.
- `vendor/effect/packages/effect/src/Stream.ts:743-784,1591-1612` — callback streams and event-listener lifetime.
- `vendor/effect/packages/effect/src/Queue.ts:441-599,694,982,1077,1114` — bounded queues and shutdown.
- `vendor/effect/packages/effect/src/Schedule.ts:1270,1645,1763,1823` — retry schedules.
- `vendor/effect/packages/effect/src/Schema.ts:1351-1376,12958-13015` — decoding and tagged errors.
- `vendor/effect/packages/effect/src/FileSystem.ts` and `vendor/effect/packages/platform-bun/src/BunFileSystem.ts` — Effect-native filesystem capability.
- `vendor/effect/packages/effect/src/unstable/process/ChildProcessSpawner.ts:226-247` — scoped process lifetime and `spawn` contract.
- `vendor/effect/packages/effect/src/unstable/http/HttpClient.ts` and `unstable/http/FetchHttpClient.ts` — Effect HTTP capability.
- `vendor/effect/packages/platform-bun/src/BunRuntime.ts` and `platform-node-shared/src/NodeRuntime.ts:22-59` — production execution edge.

## Act now: core Effect architecture

### 1. Make Pi auth adapter Effect-shaped

**Files and methods**

- `src/adapters/pi/auth.ts`
  - `requireSoul`
  - `listAuthStatus`
  - per-provider `Promise.all(... async ...)` callback
  - `loginProvider`
- `src/application/auth.ts`
  - `status`
  - `login`

**Current shape**

`src/adapters/pi/auth.ts` exports `Promise` operations and owns `async`/`await`, `try/catch`, and thrown tagged failures. `src/application/auth.ts` then wraps those exported Promises with `Effect.tryPromise`.

**Why it is wrong**

Pi's Promise is not converted exactly once inside the Pi adapter. Promise rejection, cancellation, and Pi-specific operation details escape into application orchestration.

**Target shape**

- Make `listAuthStatus` and `loginProvider` return typed `Effect.Effect` values directly.
- Wrap `ModelRuntime.create`, `runtime.checkAuth`, and `runtime.login` exactly once in `src/adapters/pi/auth.ts` with `Effect.tryPromise` and the supplied abort signal where supported.
- Preserve unknown rejected values in tagged error `cause` fields.
- Make `AuthLive` delegate to adapter Effects without another Promise bridge.

**Proof**

Focused adapter tests should assert exact typed `Exit` values for missing Profile, unknown provider, unsupported auth type, create-runtime failure, login failure, and interruption.

---

### 2. Move filesystem ownership out of application services

**Files and methods**

- `src/application/profiles.ts`
  - `readText`, `lstatPath`, `canonicalPath`
  - Profile registry reads/writes
  - skill discovery/copy/staging/promotion/cleanup operations
  - all direct `node:fs/promises` imports and `Effect.tryPromise` sites
- `src/application/automations.ts`
  - `readAutomation`
  - `resolveTargets` broadcasts file read
- `src/application/gateway.ts`
  - `loadGatewayConfig`
- `src/application/discord-gateway.ts`
  - `loadDiscordGatewayConfig`
- `src/application/slack-gateway.ts`
  - `loadSlackGatewayConfig`
- `src/application/resident-gateway.ts`
  - `validateProfile`
  - `configPresent`
  - `loadResidentGatewayConfig`

**Current shape**

Application modules import `node:fs/promises` or otherwise own filesystem Promise adaptation, host error-code interpretation, and persistence mechanics.

**Why it is wrong**

Application services should orchestrate Effect-native capabilities. They currently act as filesystem adapters, coupling product flows to Node/Bun APIs and forcing host failures to be classified at the wrong layer.

**Target shape**

Build small named Effect capabilities under `src/adapters/fs/`, not one generic dumping-ground API:

1. gateway configuration store;
2. automation definition/broadcast store;
3. Profile registry store;
4. skill tree store;
5. extension selection/package store.

Use the pinned `FileSystem` service and Bun layer where practical. Keep policy and workflow ordering in application modules; move Node `Dirent`, `Stats`, Promise, atomic file, and platform error details outward.

**Proof**

Application tests should use test Layers against the same Effect-shaped contracts. Adapter tests should cover atomic replacement, containment, missing files, malformed input, and cleanup.

---

### 3. Replace Promise-shaped Discord and Slack socket clients

**Files and methods**

- `src/adapters/discord/socket.ts`
  - `DiscordSocket.next(): Promise<DiscordInboundMessage>`
  - `DiscordSocket.close(): Promise<void>`
  - `openDiscordSocket`
  - `connect`, `enqueue`, `fail`, heartbeat/reconnect timer helpers
- `src/adapters/slack/socket.ts`
  - `SlackSocket.next(): Promise<SlackInboundMessage>`
  - `SlackSocket.close(): Promise<void>`
  - `openSlackSocket`
  - `connect`, `enqueue`, `fail`, reconnect helpers
- `src/application/discord-gateway.ts`
  - `DiscordTransport.openSocket`
  - `makeDiscordGateway` socket acquisition/finalizer
  - `socket.next()` bridge
- `src/application/slack-gateway.ts`
  - `SlackTransport.openSocket`
  - `makeSlackGateway` socket acquisition/finalizer
  - `socket.next()` bridge

**Current shape**

Both socket adapters expose Promise methods. Internally they maintain waiter arrays, raw Promise constructors/resolution/rejection, mutable buffers, timers, event listeners, reconnect state, and WebSocket ownership. Application code adapts `next` later and uses `Effect.promise` for `close`.

**Why it is wrong**

- Promise/resource ownership escapes the adapter.
- Interrupted `next()` waits are not independently removed.
- `Effect.promise(() => socket.close())` is only correct for a Promise guaranteed not to reject; otherwise rejection becomes a defect.
- `close()` can wait forever for a close event.
- inbound arrays are unbounded.

**Target shape**

- Expose a scoped Effect-native socket operation, e.g. `openSocket(...): Effect<Socket, SocketError, Scope>` with `next: Effect<Inbound, SocketError>`.
- Use `Effect.acquireRelease` for listener/WebSocket lifetime.
- Use `Effect.callback`, `Stream.callback`, or `Stream.fromEventListener` for callback adaptation.
- Use a bounded `Queue` with an explicit backpressure/drop policy instead of arrays plus pending Promises.
- Run heartbeat/reconnect workers with `Effect.forkScoped`.
- Use `Clock`, `Schedule.exponential`, and `Schedule.jittered` instead of raw timers and `Math.random` in Effect orchestration.
- Bound close finalization; consume/log cleanup failure before supplying an infallible finalizer.

**Proof**

Test exact typed exits for authentication failure, malformed frames, retryable close, interruption of a pending receive, close timeout, buffer policy, and scoped worker cleanup without patching globals.

---

### 4. Decode socket/network input once with Effect Schema

**Files and methods**

- `src/adapters/discord/socket.ts`
  - `parseJson`
  - manual `isRecord`/field probes
  - gateway frame, READY, Hello, and inbound event decoding
- `src/adapters/slack/socket.ts`
  - `parseJson`
  - manual envelope/event/connection response probes

**Current shape**

External JSON is parsed with `JSON.parse` and repeatedly inspected using manual shape guards. Slack silently drops malformed frames; Discord often reduces parse failures to generic strings.

**Target shape**

Define boundary-owned schemas, compile `Schema.decodeUnknownEffect(Schema.fromJsonString(...))` once at module scope, and map failures to structured tagged socket errors. Decide explicitly which successfully decoded variants are ignored and which are fatal.

---

### 5. Replace ordinary socket Errors with tagged failures

**Files and methods**

- `src/adapters/discord/socket.ts` — `DiscordSocketError`
- `src/adapters/discord/socket-error.ts` — `normalizeDiscordSocketError`
- `src/adapters/slack/socket.ts` — `SlackSocketError`, `normalizeSlackSocketError`

**Current shape**

Socket errors extend `Error`, encode important distinctions as free text, and discard unexpected causes.

**Target shape**

Use `Schema.TaggedErrorClass` with stable fields: operation/stage, reason literal, retriable, optional close code, and `cause: Schema.Defect()`. Translate to channel-level errors only when the translation adds product meaning.

---

### 6. Settle and enforce raw HTTP ownership

**Files and methods**

- approved today by skill:
  - `src/adapters/telegram/api.ts` — `request`
- conflicting raw fetches:
  - `src/adapters/discord/api.ts` — `request`
  - `src/adapters/discord/socket.ts` — `connect`
  - `src/adapters/slack/api.ts` — `request`
  - `src/adapters/slack/socket.ts` — `connect`
- policy implementation:
  - `tooling/oxlint/effect/rules/no-raw-fetch.mjs`
  - `.agents/skills/effect-raw-fetch-boundary/SKILL.md`

**Current shape**

The skill says Telegram API is Ziggy's sole raw-fetch boundary. The lint rule globally approves Telegram plus two Discord files, while Slack uses local suppressions. Socket connection fetches do not pass an interruption signal.

**Target shape**

Choose one policy before changing code:

1. preserve the written invariant and route Discord/Slack through Effect `HttpClient`; or
2. explicitly document one raw boundary per vendor and narrow the allowlist accordingly.

Do not retain the current contradiction. In either shape, sockets should consume typed HTTP operations rather than own fetch and response decoding.

---

### 7. Shrink the Pi memory Promise island

**Files and methods**

- `src/adapters/pi/pi-agent.ts`
  - `atomicReplace`
  - `delay`
  - `releaseMemoryLock`
  - `acquireMemoryLock`
  - `createMemoryWriteTool.execute`
  - `readMemoryDocument`
  - `buildMemoryPrompt`

**Current shape**

A required Pi tool callback returns a Promise, but many internal helpers also own Promises, `async`/`await`, nested `try/catch`, `.catch`, manual timeout/lock/release, and silent cleanup suppression.

**Boundary distinction**

Pi's `ToolDefinition.execute` is genuinely Promise-shaped. The callback edge is valid; the whole internal workflow does not need to remain a Promise island.

**Target shape**

Implement lock acquisition/use/release and atomic filesystem operations as typed Effects with `acquireUseRelease`/`acquireRelease`. Convert the final Effect only at the Pi callback boundary. Do not erase cleanup failures without an explicit logging/best-effort policy.

---

### 8. Stop classifying Pi failures by unknown message text

**File and methods**

- `src/adapters/pi/pi-agent.ts`
  - `causeMessage`
  - `isProviderConfigFailure`
  - `providerError`

**Current shape**

Unknown rejected values are stringified and matched against fragments such as `no api key`, `credential`, and `authentication failed` to select product error tags.

**Why it is wrong**

Recovery and user-visible behavior depend on unstable third-party wording.

**Target shape**

Use structured Pi outcomes/error classes where available. Otherwise classify conservatively by known operation context and preserve the unknown value only as `cause`; do not parse it for product behavior or copy.

---

### 9. Preserve external causes in gateway/Profile failures

**Files and symbols**

- `src/domain/gateway.ts` — `GatewayConfigError`
- `src/application/gateway.ts` — config read/decode error mapping
- `src/application/discord-gateway.ts` — config read/decode error mapping
- `src/application/slack-gateway.ts` — config read/decode error mapping
- `src/application/resident-gateway.ts` — `validateProfile` and `configPresent`
- `src/domain/profile.ts` — `ProfileFileSystemError`
- `src/application/profiles.ts` — `fileSystemError`

**Current shape**

Filesystem and Schema causes are frequently discarded in favor of stable messages and sometimes a code.

**Target shape**

Keep stable user-facing fields, but add/preserve `cause: Schema.Defect()` at the boundary. Split missing/invalid errors only if callers have meaningfully different recovery paths.

---

### 10. Repair custom lint so `check` means what it claims

**Primary files/symbols**

- `tooling/oxlint/effect/utils.mjs` — `isAdapterFile`, `isTestLike`, Promise helpers
- `tooling/oxlint/effect/rules/no-native-promise-ownership.mjs`
- `tooling/oxlint/effect/rules/no-try-catch-or-throw.mjs`
- `tooling/oxlint/effect/rules/no-promise-catch.mjs`
- `tooling/oxlint/effect/rules/no-promise-client-surface.mjs`
- `tooling/oxlint/effect/rules/no-raw-fetch.mjs`
- `tooling/oxlint/effect/rules/no-effect-execution-boundary.mjs`
- `tooling/oxlint/effect/rules/no-unsupported-effect-api.mjs`
- `tooling/oxlint/effect/rules/no-unknown-shape-probing.mjs`
- `tooling/oxlint/effect/rules/no-unknown-error-message.mjs`
- `package.json`, `tsconfig.json`, `.oxlintrc.json`, `.oxfmtrc.json`

**Observed gaps**

1. Most Promise/throw/error/shape rules return early for every `src/adapters/**` file.
2. Promise surface detection mostly recognizes narrowly named `*Client`/exported `*Sdk` interfaces, missing exported functions, type aliases, `*Socket`, factories, inferred async exports, and `PromiseLike`.
3. Raw-fetch policy contradicts the skill and ignores extensions.
4. `isTestLike` exists but most rules do not apply a deliberate test policy, creating false positives and suppression pressure.
5. Rules rely heavily on identifier spelling/suffixes rather than import provenance or types.
6. File-wide disables exempt unrelated future code.
7. No rule fixture/test harness exists.
8. `tooling/**/*.mjs` is outside the normal lint/typecheck/format scope.
9. The architecture spec says custom rule suites were not planned, yet the repository now depends on 23 custom Effect rules without their validation burden.

**Target shape**

Either retire low-confidence heuristic rules or explicitly own the suite:

- remove blanket adapter exemptions;
- permit only exact external callback/bridge contexts;
- structurally inspect exported Promise surfaces independent of names;
- encode approved execution/test locations;
- narrow suppressions to the exact line/callback;
- add valid/invalid fixtures for every retained rule;
- include tooling in format/lint/type verification;
- add a repository assertion for the selected raw-fetch policy.

## Defer: smaller core corrections

| File | Symbol/method | Correction |
|---|---|---|
| `src/application/agent.ts` | `ZiggyAgentShape`, `ChatHandle`, `ChatSessionMode` imports | Move the stable Effect-native chat contract inward; let the Pi adapter implement it instead of owning application vocabulary. |
| `src/adapters/fs/cause.ts` | `FileSystemCauseDetails` | Derive the static type from the owning Schema, resolving optional `code` normalization deliberately. |
| `src/adapters/bun/recent-ids.ts` | `RecentIds` | If the factory remains the only implementation, derive with `ReturnType<typeof makeRecentIds>`. Keep operations synchronous; they are total local work. |
| `src/adapters/bun/process.ts` | `killProcess` | Return an Effect or explicitly model/log non-benign kill failure instead of swallowing every throw; `automation-gate.ts` process-group fallback must not report cleanup as complete when both group and child signals fail. |
| `src/adapters/fs/profile-extensions.ts` | `replaceExtensionSelection` finalizer | Separate close/remove cleanup, eliminate nested Promise `.catch`, and choose typed propagation or logged best effort. |
| `src/adapters/telegram/api.ts` | numeric schemas and `TelegramApiError` fields | Use/reuse finite numeric schemas consistently; current safe-integer checks already reject non-finite IDs, so prioritize unconstrained error fields. |
| `src/main.ts` | argv/env parsing | Decode CLI/environment input once into a tagged command union rather than distributing positional string checks. |
| `src/application/gateway.ts` | Telegram message batch concurrency | Decide whether batch backpressure is intentional; Discord/Slack use `forkScoped`, while Telegram waits for the batch. |
| `src/adapters/*/api.ts` | `safeCause` | Preserve structured sanitized causes where possible without retaining tokens; document the security trade-off if lossy redaction remains. |

## Tests that should be strengthened

These are not reasons to migrate test harness Promises into production Effects. Tests are approved execution edges.

| File | Current test/helper | Correction |
|---|---|---|
| `src/adapters/discord/socket.test.ts` | global `fetch` patch | Inject typed HTTP/socket capability and assert exact typed `Exit`; do not patch process-global networking. |
| `src/adapters/pi/resources.test.ts` | invalid selection/containment cases | Assert complete expected `Exit.fail(...)` values instead of reducing failures to booleans. |
| `src/application/profiles.test.ts` | refusal/invalid-selection cases | Assert exact recoverable domain failure plus unchanged filesystem bytes. |
| `src/adapters/pi/ziggy-tui-extension.test.ts` | `Bun.sleep(1)` | Inject deterministic scheduling rather than relying on a one-millisecond timing guess. |
| `extensions/skill-creator/.../test_package_skill.py` | global `sys.modules` replacement | Exercise the real validator; add one invalid-frontmatter integration case that creates no archive. |

## Intentional Promise/non-Effect boundaries — keep

Not every `Promise`, `async`, `throw`, Python exception, shell exit, or raw HTTP use in this repository should become an Effect.

### Required Pi Promise callbacks

Keep a narrow bridge for:

- `src/adapters/terminal/auth-interaction.ts` — Pi `AuthInteraction.prompt` contract.
- `src/adapters/pi/pi-agent.ts`:
  - Pi `ToolDefinition.execute` callbacks;
  - agent runtime factory callback;
  - registered extension command handlers.
- Pi SDK methods such as session/runtime operations and `InteractiveMode.run` are Promise-returning APIs that require one adapter bridge.
- `before_agent_start` permits either synchronous or Promise results; it is a valid Pi integration boundary, but not a mandatory Promise callback.
- executable Pi extension entrypoints under `extensions/*/index.ts` where Pi requires Promise-returning tool execution.

The correction is to keep the callback edge small, not to pretend Pi returns Effects.

### Standalone executables and scripts

The Python/shell/MJS executables under `extensions/**` and `skills/**` own process-specific boundaries and are not imported into Ziggy application/domain code. They need ordinary boundary hygiene, not wholesale Effect migration.

### Tests

Bun tests may use `async`, `await`, `Promise.all`, and `Effect.runPromise`/`runPromiseExit` at the test execution edge. Test doubles should still implement the same Effect-shaped consumer contracts production uses.

### Total synchronous domain work

Keep total calculations such as memory operations, ID sanitization, target parsing internals, and bounded recent-ID Set operations as plain synchronous TypeScript when wrapping them adds no failure, requirement, resource, scheduling, or observability value.

## Non-Effect issues found in standalone extensions

These are real fixes, but they are **not evidence that core Ziggy should wrap every extension in Effect**.

| Priority | File and method | Issue | Smallest correction |
|---|---|---|---|
| P1 | `extensions/lossless-claw/src/store.ts` — `discoverSessionFiles` | Follows directory symlinks outside the Profile. | Reject symlinks or canonicalize every target and prove containment. |
| P1 | `extensions/lossless-claw/index.ts` tool `execute` methods; `store.ts` refresh/search | Synchronous recursive IO/SQLite blocks Pi and ignores cancellation. | Move work behind a worker/child process with signal propagation. |
| P1 | `extensions/telephony/.../telephony.py` — `_upsert_env_file`, `_save_state` | Credentials/state written non-atomically and without enforced `0600`. | Same-directory `0600` temp, fsync, `os.replace`, chmod existing files. |
| P1 | `extensions/skill-curator/index.ts` — `skillFilePath`, `atomicWrite`, `writeProfileSkill` | Symlinked skill directories can escape the Profile. | Reject symlink roots/parents and verify canonical containment before operations. |
| P2 | `extensions/agent-browser/index.ts`, `extensions/diffs/index.ts`, `extensions/open-computer-use/index.ts` — `execute` | Timeout/abort sends only SIGTERM and can remain pending forever. | Escalate to process-tree SIGKILL after a grace period and guarantee one settlement/finalizer. |
| P2 | `extensions/open-computer-use/bin/open-computer-use-wrapper.mjs` | Startup-error path leaks temporary call files. | Shared idempotent cleanup on both `error` and `exit`. |
| P2 | `extensions/here-now/.../drive.sh`, `publish.sh` | Curl has no connect/overall timeout; temporary response cleanup is incomplete. | Centralize bounded curl options and use an EXIT trap. |
| P3 | `extensions/web-search/bin/web-search.ts` — `parseArgs` | `--n` has no upper bound. | Clamp to the intended provider/tool maximum. |
| P3 | `extensions/skill-creator/.../package_skill.py` — `package_skill` | Failure can leave a partial final archive. | Write a sibling temporary archive and atomically replace on success. |

## File coverage

All 37 production `src` files are classified below: 28 with action items and 9 as keep.

### Core production files with action items

- `src/adapters/bun/automation-gate.ts`
- `src/adapters/bun/automation-sqlite.ts`
- `src/adapters/bun/gateway-owner.ts`
- `src/adapters/bun/process.ts`
- `src/adapters/bun/recent-ids.ts`
- `src/adapters/discord/api.ts`
- `src/adapters/discord/socket-error.ts`
- `src/adapters/discord/socket.ts`
- `src/adapters/fs/cause.ts`
- `src/adapters/fs/profile-extensions.ts`
- `src/adapters/pi/auth.ts`
- `src/adapters/pi/pi-agent.ts`
- `src/adapters/slack/api.ts`
- `src/adapters/slack/socket.ts`
- `src/adapters/telegram/api.ts`
- `src/application/agent.ts`
- `src/application/auth.ts`
- `src/application/automation-scheduler.ts`
- `src/application/automations.ts`
- `src/application/discord-gateway.ts`
- `src/application/gateway.ts`
- `src/application/profiles.ts`
- `src/application/resident-gateway.ts`
- `src/application/slack-gateway.ts`
- `src/domain/automation.ts`
- `src/domain/gateway.ts`
- `src/domain/profile.ts`
- `src/main.ts`

### Core production files reviewed as keep

- `src/adapters/pi/resources.ts` — Promise wrapped at adapter and only Effect exposed.
- `src/adapters/pi/ziggy-tui-extension.ts` — required Pi/TUI callback boundary.
- `src/adapters/terminal/auth-interaction.ts` — required Pi Promise callback boundary.
- `src/domain/agent.ts`
- `src/domain/discord.ts`
- `src/domain/memory.ts`
- `src/domain/slack.ts`
- `src/domain/telegram.ts`
- `src/faces/automation-cli.ts`

### Test files with action items

- `src/adapters/bun/automation-gate.test.ts`
- `src/adapters/bun/automation-sqlite.test.ts`
- `src/adapters/bun/gateway-owner.test.ts`
- `src/adapters/discord/socket.test.ts`
- `src/adapters/pi/resources.test.ts`
- `src/adapters/pi/ziggy-tui-extension.test.ts`
- `src/application/automation-scheduler.test.ts`
- `src/application/automations.test.ts`
- `src/application/profiles.test.ts`
- `src/application/resident-gateway.test.ts`
- `extensions/skill-creator/skills/skill-creator/scripts/test_package_skill.py`

All other test files, including `src/domain/automation.test.ts` and `src/faces/automation-cli.test.ts`, were reviewed and are acceptable execution boundaries for their current contracts.

### Tooling/config files with action items

- `.oxlintrc.json`
- `.oxfmtrc.json`
- `package.json`
- `tsconfig.json`
- `tooling/oxlint/effect-plugin.mjs`
- `tooling/oxlint/effect/utils.mjs`
- all rules under `tooling/oxlint/effect/rules/`, with highest priority on the rules named in finding 10.

`tooling/oxlint/no-unsafe-typescript-syntax.mjs` was also reviewed; keep its narrow TypeScript-safety role, while adding tooling-wide verification as described above.

### Extension files with non-Effect action items

- `extensions/agent-browser/index.ts`
- `extensions/diffs/index.ts`
- `extensions/here-now/skills/here-now/scripts/drive.sh`
- `extensions/here-now/skills/here-now/scripts/publish.sh`
- `extensions/lossless-claw/index.ts`
- `extensions/lossless-claw/src/store.ts`
- `extensions/open-computer-use/bin/open-computer-use-wrapper.mjs`
- `extensions/open-computer-use/index.ts`
- `extensions/skill-creator/skills/skill-creator/scripts/package_skill.py`
- `extensions/skill-curator/index.ts`
- `extensions/telephony/skills/telephony/scripts/telephony.py`
- `extensions/web-search/bin/web-search.ts`

The remaining extension executables were inspected and classified as intentional Pi/process boundaries with no Effect migration required:

- `extensions/agent-browser/bin/agent-browser-wrapper.mjs`
- `extensions/diffs/bin/diffs.py`
- `extensions/executor/index.ts`
- `extensions/github-pr-triage/bin/gh-prs.py`
- `extensions/github-pr-triage/index.ts`
- `extensions/github/index.ts`
- `extensions/hyperframes/skills/hyperframes/scripts/setup.sh`
- `extensions/linear/index.ts`
- `extensions/linear/scripts/linear_api.py`
- `extensions/skill-creator/skills/skill-creator/scripts/init_skill.py`
- `extensions/skill-creator/skills/skill-creator/scripts/quick_validate.py`
- `extensions/tmux/skills/tmux/scripts/find-sessions.sh`
- `extensions/tmux/skills/tmux/scripts/wait-for-text.sh`
- `extensions/web-search/index.ts`

`skills/google-workspace/scripts/google_api.py` is likewise an intentional standalone script boundary.

## Recommended correction order

1. **Close scheduler publication gaps**: make claim commit → child registration interruption-safe, then bracket running → one truthful terminal publication.
2. **Bracket automation chat lifetime** with `acquireUseRelease` and prove immediate post-acquire interruption.
3. **Strengthen resident identity** beyond PID-only liveness for both Gateway ownership and active automation rows.
4. **Fix the Gateway owner protocol races**: bounded `EEXIST → ENOENT` handoff retry and a release protocol that cannot unlink a replacement owner.
5. **Make cleanup failure observable** for candidate files, process-group signaling, chat disposal, and database close according to explicit best-effort/typed policies.
6. **Introduce Effect capabilities/Layers** for automation ledger/definition/projection stores and resident Gateway config; remove direct concrete adapter selection from application services.
7. **Split definition discovery into cancellable Effect orchestration** rather than one coarse async Promise workflow.
8. **Make write-side scheduler/run transitions schema-owned** so invalid terminal and mutation combinations cannot enter SQLite.
9. **Update or supersede `docs/plans/automation-scheduler.md`** so agents do not use the historical Slice 3 freeze as the current architecture.
10. **Repair lint policy/gaps** enough that adapter directories are not blanket exemptions and tests have an explicit policy.
11. **Convert Pi auth adapter and application auth** to one Effect bridge.
12. **Replace Discord/Slack Promise socket contracts** and settle raw HTTP ownership.
13. **Move remaining Profile filesystem mechanics** from application to focused adapters, including Gateway and automation config/definition reads.
14. **Shrink the Pi memory Promise island**, preserve structured causes, and repair smaller schema/type ownership issues.
15. Address standalone extension reliability/security findings separately; do not mix them into the core Effect migration.

## Current HEAD adjudication — d8718c1

This section supersedes the historical action order above. It is deliberately a disposition, not a
second repository-wide audit.

| Item | Current evidence | Disposition |
|---|---|---|
| Scheduler publication and chat lifetime | `automation-scheduler.ts` wraps commit plus registration in `Effect.uninterruptibleMask`, restoring interruption only in registered workers. `automations.ts` uses `Effect.acquireUseRelease` for chat and one uninterruptible terminal publication path. Tests cover commit interruption, immediate cleanup, terminal interruption, and terminal-write failure. | **Keep.** The mechanism matches pinned `Effect.ts:7362-7366`, `6677-6681`, and `8642-8657`. |
| Durable process-instance identity | Scheduler and Gateway recovery still use PID liveness. `isLocalProcessAlive` treats only `ESRCH` as dead and remains conservative for unknown signal errors; the focused test proves that policy. There is no portable current process-start identity capability or migration contract. | **Defer.** PID reuse is a real theoretical ambiguity, but adding an OS-specific start token or a second registry without a live collision witness would be a larger authority change. Keep fail-closed recovery and document that PID is evidence, not identity. |
| Gateway handoff and release | Acquisition retries the complete `EEXIST → inspect → ENOENT → link` sequence twice (`gateway-owner.ts`), with a deterministic handoff test. Release still performs read/compare/unlink; the foreign-record test proves the normal replacement-before-read case, not an adversarial mid-release replacement. | **Narrow-document.** The internal contender protocol is bounded and fail-closed. A truly conditional unlink needs a different lock authority (for example a directory/OS lock), not a safe local patch to pathname unlink; no current actor replaces a held record mid-release. |
| Application filesystem and concrete adapter selection | Automation definitions/broadcasts and Gateway config now live under `src/adapters/fs/`. `src/application/profiles.ts` remains a direct Node filesystem workflow, and application services still select concrete Bun/FS/channel/Pi adapters. | **Defer.** The remaining Profile workflow has one implementation and no current failure or test-isolation pressure that justifies a generic Layer family. Do not call this fully Effect-capability-independent. |
| Cleanup observability | Candidate-file cleanup, process-group signaling, Pi memory/runtime cleanup, and socket close cleanup report unexpected failures; only `ENOENT` is benign in the new candidate path. Database close and Profile staging cleanup remain best-effort host finalizers. | **Keep current policy; defer expansion.** Existing logs preserve operational evidence. Add typed propagation only when a deterministic close failure or an operator recovery path exists. |
| Write-side schema/type ownership | `AutomationScheduleMutation`, `AutomationRunTerminal`, and `AutomationRunCompletion` are domain-owned schemas; the SQLite boundary decodes mutation and completion inputs before transactions. `ScheduleCommitResult` and capability interfaces are transient contracts, not persisted shapes. | **Keep.** The original weak-write finding is closed without adding a schema for an internal return value. |
| Pi memory, prompt, and resources | Memory lock/write/read/prompt composition is Effect-shaped through the Pi callback bridge. Runtime disposal is scoped/best-effort logged, prompt interruption uses `Effect.callback`, and resource stats remain a single Pi/filesystem adapter bridge. Required Pi Promise callbacks remain at the edge. | **Keep.** Pinned `Effect.ts:1166-1206` explicitly supports callback registration cleanup; no second loop or resource authority is warranted. |
| Discord/Slack sockets | Both expose `next`/`close` as Effects, use bounded dropping queues, scope heartbeat/reconnect supervisors, clean partial listener acquisition, and bound close callbacks. Focused tests cover partial acquisition, pending receive, close timeout, and cleanup reporting. | **Keep.** This is the intended callback boundary under pinned `Effect.ts:1166-1206`; `Queue.dropping`/`shutdown` are available at `Queue.ts:562`, `1114`. |
| Lint and tooling | `bun run lint` checks `src`, `extensions`, and `tooling`; `bun run check` formats those same code-like trees. The old low-confidence Promise-client and heuristic rules were removed. Raw fetch now approves only `src/adapters/telegram/api.ts`, matching the raw-fetch skill. Adapter exemptions remain intentional for host callback/Promise mechanics. | **Keep reduced policy.** A fixture harness and deeper type-provenance rules would be a new tooling project, contrary to the minimal architecture; current coverage is explicit, not proof of every architectural invariant. |
| TypeScript Effect suggestions | Current `bun run typecheck` is exit-0 with five non-fatal suggestions: two `Effect.succeed(undefined)` cases whose exact `string | undefined` contract rejects `Effect.void`, two `Effect.catch(() => Effect.void)` cases retained because the repository lint policy rejects `Effect.ignore`, and one rollback-preserving `Effect.catch` in `profiles.ts` where `Effect.mapError` would not preserve rollback. Finite Schema suggestions were corrected. | **Narrow-document.** The remaining suggestions are semantically intentional; do not distort value types or remove rollback to make the diagnostic list empty. |
| Scheduler plan and audit accuracy | `docs/plans/automation-scheduler.md` is explicitly marked a historical Slice 3 freeze. This report now labels its old snapshot and records current HEAD `d8718c1`, seven-commit dispositions, and the current 122-file count. | **Keep documentation correction.** Current source and this adjudication supersede the historical action list. |

### Focused current proof

- `bun run typecheck` passes (exit 0; five informational Effect suggestions described above).
- The existing focused witnesses cover scheduler claim registration, terminal publication, gateway
  handoff, socket partial acquisition/close cleanup, Pi memory interruption, and persisted write
  validation; no duplicate test harness or new external credential proof was added.
- The pinned source used for the adjudication is `vendor/effect` commit
  `6184a7dc53cb9310e299b65ad6d6c712c2cbf202`: `Effect.ts:1166-1206, 6677-6681, 7362-7366,
  8642-8657`; `Schema.ts:1368-1375, 12981-12997`; and `Queue.ts:562, 1114`.
