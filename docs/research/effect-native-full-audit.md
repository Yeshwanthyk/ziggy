# Effect-native full-repository audit — current adjudication

Date: 2026-08-07

Reviewed implementation HEAD: `ec13a93` (implementation baseline `d8718c1`; `ec13a93` adds the
finite-Schema corrections and the first documentation adjudication). The closeout after this review
changes tracked documentation only.

## Conclusion

Ziggy is now **Effect-native at the shipped core execution, cancellation, publication, and resource
boundaries** that motivated this audit. The old Pi-auth Promise leak, scheduler publication races,
unbracketed automation chat, coarse automation scan, Promise-shaped Discord/Slack sockets, raw-fetch
policy conflict, weak automation writes, and silent cleanup paths were corrected by
`11554fc..d8718c1`. `src/main.ts` remains the only production orchestration execution edge;
`Effect.runPromise` remains only in required Pi callback bridges and tests.

This is not a claim that every host dependency is capability-injected. Four boundaries remain
explicit:

1. PID liveness is conservative evidence, not durable process-instance identity — **deferred** until
   a reproducible PID-reuse collision makes a portable identity/migration contract necessary.
2. Gateway release is read/compare/unlink and cannot guarantee conditional unlink against an
   adversarial external pathname replacement during release — **narrow-documented** because the
   current bounded contender protocol has no such actor.
3. `src/application/profiles.ts` still owns the large Profile/skill filesystem workflow, and
   application composition still selects concrete adapters — **deferred** until a second
   implementation or real test-isolation pressure appears.
4. Five Effect Language Service suggestions are intentionally retained because the proposed
   replacements change exact value types, violate repository lint policy, or remove rollback —
   **narrow-documented**, with `bun run typecheck` still exiting 0.

The checkout has **122 tracked code-like files**: 84 TypeScript, 21 MJS, 11 Python, and 6 shell
files. Core `src` contains **38 production TypeScript files** and **24 TypeScript test files**. The
pinned Effect source is `vendor/effect` commit
`6184a7dc53cb9310e299b65ad6d6c712c2cbf202` (`effect@4.0.0-beta.99`).

## Verification snapshot

- Workflow focused proof: **62 passed, 0 failed** for the adjudicated scheduler/run/SQLite/Gateway/
  Pi/socket witnesses; no duplicate harness was added.
- Independent workflow state proof: **41 passed, 0 failed** across automation SQLite, Gateway
  ownership, scheduler, and automation runs.
- Independent workflow core proof: **72 passed, 0 failed** across scheduler, automation runs,
  SQLite, Gateway ownership/gate, Pi memory/prompt, and Discord/Slack sockets.
- Closeout `bun run test`: **182 Bun tests passed, 0 failed**, followed by all Here Now, telephony,
  and skill-creator helper suites passing.
- Closeout `bun run check`: **passed** (format check, lint, and typecheck). Typecheck emitted the five
  informational suggestions recorded below and exited 0.
- Closeout `git diff --check`: **passed**.

## Commits adjudicated since `c7335bd`

| Commit | Current effect | Proof retained |
|---|---|---|
| `11554fc` | Makes claim commit → scoped-worker registration and run → terminal publication interruption-safe; brackets automation chat; bounds Gateway handoff retry. | Scheduler committed-claim interruption; run execution/terminal interruption; Gateway `EEXIST → ENOENT` handoff tests. |
| `f7b580a` | Converts Pi auth runtime creation/check/login once inside the Pi adapter; application auth delegates Effects. | Typed missing Profile, create-runtime, unknown provider, unsupported type, login, and cancellation tests. |
| `558a11d` | Adds the missing per-provider auth-status failure witness. | `could not check provider auth` preserves the rejected cause. |
| `03cb552` | Rejects Lossless Claw and Skill Curator symlink escapes. | External-session-tree and Profile-skill symlink tests. |
| `70587f2` | Publishes telephony state/secrets and skill archives privately and atomically. | Mode, unchanged-bytes, invalid-frontmatter, and no-partial-archive helper tests. |
| `79bbb36` | Bounds extension subprocess trees and curl operations; closes temporary response/call-file paths. | Uncooperative descendant, missing executable, failed calls-file, and hanging-curl tests. |
| `1125841` | Replaces Discord/Slack Promise socket surfaces with scoped Effects, bounded queues, Schema decoding, tagged errors, and typed HTTP operations. | Authentication, malformed frame, reconnect, interruption, overflow, timeout, and application transport tests. |
| `96135cd` | Preserves terminal publication failure and stops classifying provider errors from message text. | Interrupted terminal-write failure and misleading vendor-wording tests. |
| `d819615` | Makes Pi memory lock/read/write/prompt work Effect-shaped behind required Pi callbacks; adds cancellation cleanup. | Memory concurrency, overflow, waiting-lock interruption, prompt abort/listener cleanup, and refresh tests. |
| `60be120` | Rolls back partially registered Discord/Slack listeners and reports reconnect-close cleanup failures. | Deterministic partial-acquisition and reconnect-cleanup tests for both sockets. |
| `c165de6` | Preserves boundary causes and reports non-benign candidate, signal, Pi, Profile-extension, and socket cleanup failures. | Candidate cleanup and process-group/fallback signal failure tests. |
| `d2660c8` | Adds domain-owned automation mutation/completion schemas and regains interruption between definition reads. | Malformed transition, fail-closed persisted row, and sequential-read cancellation tests. |
| `77d2cdd` | Removes low-confidence lint heuristics, covers `src`, `extensions`, and `tooling`, and narrows raw fetch to Telegram. | `bun run lint`; full `bun run check`; candidate-file assertion retained. |
| `d8718c1` | Moves automation definitions/broadcasts and Gateway config filesystem mechanics into focused FS adapters. | Application filesystem scan leaves only the Profile workflow; full check/test. |
| `ec13a93` | Corrects finite numeric Schemas and records the first current adjudication without changing the retained runtime mechanisms. | Typecheck exit 0 with the five documented informational suggestions. |

## Current action matrix

`Fixed` means the old finding is closed at reviewed HEAD. `Keep` means the current mechanism is
intentional. `Narrow-document` and `Defer` are explicit boundaries, not untracked gaps.

| Historical item | Files / methods at reviewed HEAD | Evidence, commit, and pinned source | Disposition |
|---|---|---|---|
| 1. Pi auth adapter shape | `src/adapters/pi/auth.ts` — `makePiAuth`, `listAuthStatus`, `loginProvider`; `src/application/auth.ts` | `f7b580a`, `558a11d`; seven focused auth tests. Promise-producing Pi calls are adapted once. | **Fixed.** |
| 2. Application filesystem ownership | `src/adapters/fs/automation-files.ts`; `src/adapters/fs/gateway-config.ts`; `src/application/profiles.ts` | `d8718c1`; live scan finds native filesystem imports only in `profiles.ts` among production application files. Pinned `FileSystem.ts` and `platform-bun/src/BunFileSystem.ts` remain reference implementations. | **Fixed for automation/Gateway; defer Profile extraction and broader Layers.** No second implementation or isolation failure justifies moving the whole Profile workflow now. |
| 3. Promise-shaped Discord/Slack sockets | `src/adapters/{discord,slack}/socket.ts` — `open*Socket`, `next`, `close` | `1125841`, `60be120`; pending-receive, overflow, close-timeout, partial-listener, reconnect-cleanup tests. Pinned `Effect.ts:1166-1206`; `Queue.ts:562,1114`. | **Fixed; keep current socket boundary.** |
| 4. Socket/network Schema decoding | Discord Gateway/READY/Hello/message decoders; Slack envelope/events/message decoders | `1125841`; malformed Discord fails through the receive channel and malformed unacknowledged Slack input is deliberately ignored. Pinned `Schema.ts:1368-1375`. | **Fixed.** |
| 5. Socket typed errors | `DiscordSocketError`, `SlackSocketError` in their socket adapters | `1125841`; typed authentication, malformed-frame, queue-overflow, fatal-close, and close-timeout exits. Pinned `Schema.ts:12981-12997`. | **Fixed.** |
| 6. Raw HTTP ownership | `src/adapters/telegram/api.ts` — `request`; Discord/Slack API and socket adapters | `1125841`, `77d2cdd`; source scan finds core raw `fetch` only in Telegram; `no-raw-fetch.mjs` allows exactly that path. | **Fixed; keep Telegram as the sole core raw-fetch boundary.** Standalone extension executables retain their own HTTP/process boundaries. |
| 7. Pi memory Promise island | `src/adapters/pi/pi-agent.ts` — memory DB acquisition, read/write, `buildMemoryPrompt`, tool callback | `d819615`; memory lock interruption/concurrency/overflow tests. Pinned `Effect.ts:6677-6681` for `acquireUseRelease`. | **Fixed; keep the required ToolDefinition Promise callback bridge.** |
| 8. Provider failure classification by message text | `src/adapters/pi/pi-agent.ts` — provider failure mapping | `96135cd`; `misleading vendor wording remains a provider call failure with stable copy`. | **Fixed.** |
| 9. Boundary causes | `src/domain/{gateway,profile}.ts`; Gateway/Profile config and filesystem mappings | `c165de6`; tagged errors retain `Schema.Defect` causes without unstable user copy. Pinned `Schema.ts:12981-12997`. | **Fixed.** |
| 10. Lint architecture claims | `package.json`; `.oxlintrc.json`; `tooling/oxlint/effect-plugin.mjs`; retained rules | `77d2cdd`; lint covers `src extensions tooling`; check formats the same code-like trees; low-confidence Promise-client and shape/message heuristics were removed. | **Keep reduced policy.** It is guardrail coverage, not complete architectural proof; defer a fixture/type-provenance project. |
| A. Claim commit → worker registration | `src/application/automation-scheduler.ts` — `scan`, `registerClaims` | `11554fc`; committed-claim interruption waits until `forkScoped` registration. Pinned `Effect.ts:7362-7366` (`uninterruptibleMask`) and `8642-8657` (`forkScoped`). | **Fixed; keep.** Restore interruptibility inside the worker; never extend the mask over gate/model/delivery. |
| B. One truthful terminal publication | `src/application/automations.ts` — `makeAutomations().run` | `11554fc`, `96135cd`; execution interruption, terminal-publication interruption, and terminal-write-failure tests prove one attempt and truthful failure. Pinned `Effect.ts:7362-7366`. | **Fixed; keep.** |
| C. Automation chat lifetime | `src/application/automations.ts` — `openChat → prompt → dispose` | `11554fc`, `96135cd`; disposal is observed on interruption. Pinned `Effect.ts:6677-6681`. | **Fixed; keep.** |
| D. Durable process-instance identity | `src/adapters/bun/process.ts` — `makeLocalProcessAlive`; `automation-sqlite.ts` — `recoverAutomationRuns`; `gateway-owner.ts` — `pidIsAlive` | `local PID liveness proves only ESRCH dead and otherwise stays conservative`. No portable process-start token or migration contract exists. | **Defer.** PID is evidence, not identity. Do not add an OS-specific token or second durable owner authority without a reproducible collision witness. |
| E. Gateway release TOCTOU | `src/adapters/bun/gateway-owner.ts` — `release` | Existing foreign-owner test replaces before release reads. Read/compare/unlink cannot condition unlink on the same inode against an external mid-release replacement. | **Narrow-document.** The guarantee applies to current internal contenders, not an adversarial external replacer. Do not replace the lock protocol solely for an actor the system does not have. |
| F. Gateway handoff | `gateway-owner.ts` — bounded acquisition loop; `gateway-owner.test.ts` | `11554fc`; `retries when the previous owner releases after a link conflict`. | **Fixed; keep two-attempt internal handoff.** |
| G. Concrete adapter selection | `automation-scheduler.ts`, `automations.ts`, `resident-gateway.ts`, application composition | Tests can inject focused runtime/file capabilities, but application services still choose concrete Bun/FS/channel/Pi adapters. | **Defer.** Introduce more capabilities/Layers only when a second implementation or concrete isolation failure appears. |
| H. Coarse uncancellable definition scan | `src/adapters/bun/automation-sqlite.ts` — `discoverAutomationSources` | `d2660c8`; `Effect.forEach` adapts each signal-aware `readFile`; deterministic interruption resumes between reads. | **Fixed.** |
| I. Candidate cleanup suppression | `src/adapters/bun/gateway-owner.ts` — candidate finalizer | `c165de6`; only `ENOENT` is benign; unexpected failure is reported and the candidate remains inspectable. Pinned `Effect.ts:6684-6693`. | **Fixed; keep best-effort reporting.** |
| J. Process signaling suppression | `src/adapters/bun/{automation-gate,process}.ts` | `c165de6`; both group and fallback failure witness; `ESRCH` remains benign. | **Fixed; keep reporting policy.** |
| K. Write-side automation contracts | `src/domain/automation.ts` — `AutomationScheduleMutation`, `AutomationRunTerminal`, `AutomationRunCompletion`; SQLite decoders | `d2660c8`; malformed mutations/completions are rejected before transaction writes. Pinned `Schema.ts:1368-1375,12981-12997`. | **Fixed; keep.** Do not schema-wrap transient commit results or capability objects. |
| L. Stale scheduler plan | `docs/plans/automation-scheduler.md` | `ec13a93` marks Slice 3 historical; the current-state addendum records Gateway hosting and residual boundaries. | **Fixed.** Keep settled Slice 3 history rather than rewriting it as a second live spec. |

## Lower-priority and standalone findings

| Prior observation | Current evidence | Disposition |
|---|---|---|
| Gateway runtime callbacks (`makeOwnerId`, `now`, `pidIsAlive`) can throw | They are injected synchronous host operations; no expected recoverable failure witness exists. | **Defer** until one is observed; do not add typed error classes speculatively. |
| SQLite close and Profile staging cleanup | SQLite close remains a scope finalizer; Profile staging and extension-selection cleanup are logged best effort. | **Intentional keep.** Add typed propagation only with deterministic close failure and a caller recovery path. |
| Automation projection/trigger manual types | Persisted and write-side shapes are Schema-owned; transient command/capability values are not persisted. | **Keep.** Do not duplicate transient contracts as runtime schemas. |
| `Cause.hasInterruptsOnly` maps interrupt-only Gateway teardown to exit 0 | No internal path intentionally interrupts the main Gateway fiber for a non-shutdown reason. | **Keep**, revisit only if that execution path changes. |
| Distributed CLI/environment parsing | Existing commands remain boundary-decoded enough for current behavior; no failure in this adjudication depends on a new command union. | **Defer** outside this outcome. |
| Telegram batch concurrency differs from Discord/Slack | Telegram intentionally waits for its current batch while Discord/Slack fork scoped message workers; no backpressure failure was part of this adjudication. | **Defer** until channel load makes the policy decision observable. |
| `ZiggyAgentShape` imports Pi-owned chat vocabulary; `FileSystemCauseDetails`; `RecentIds` manual interfaces | Each has one implementation and no runtime-unsafe external shape. | **Defer** stylistic type derivation; no new abstraction. |
| Telegram finite numeric schemas | `ec13a93` uses `Schema.Finite` plus exact safe-integer/range checks. | **Fixed.** |
| API `safeCause` deliberately redacts to an `Error` message | Structured causes may contain credentials; current stable tagged fields carry recovery meaning. | **Intentional keep** pending a proven safe structured-redaction contract. |
| Lossless Claw session symlink traversal | Session-root and descendant symlinks are rejected/skipped. | **Fixed** in `03cb552`; external-tree test passes. |
| Lossless Claw synchronous refresh/search | The repository-owned Pi package still performs synchronous filesystem/SQLite work inside its required tool callback. | **Defer** worker/process migration until measured blocking is load-bearing; do not treat it as a core Promise leak. |
| Skill Curator symlink escape | Canonical containment, `O_NOFOLLOW`, and parent revalidation protect list/read/write. | **Fixed** in `03cb552`; symlink-root/directory tests pass. |
| Telephony non-atomic/private state | Same-directory `0600` temporary files, fsync, replace, and final chmod. | **Fixed** in `70587f2`; helper tests pass. |
| Skill archive partial publication | Sibling temporary archive is atomically replaced only after successful validation/build. | **Fixed** in `70587f2`; invalid frontmatter leaves no archive. |
| Agent Browser, Diffs, Open Computer Use subprocess lifetime | Abort/timeout terminate the process group and escalate to `SIGKILL`; settlement and cleanup are bounded. | **Fixed** in `79bbb36`; descendant tests pass. |
| Open Computer Use failed-start calls file | Shared cleanup runs on startup error and exit. | **Fixed** in `79bbb36`; missing-executable test passes. |
| Here Now unbounded curl/temp responses | Shared connect/overall timeouts and `EXIT` cleanup trap. | **Fixed** in `79bbb36`; hanging-curl helper test passes. |
| Web Search `--n` has no upper bound | It remains a standalone executable concern and was not changed by the core adjudication. | **Defer** until the provider/tool limit is a witnessed failure; do not expand this closeout. |

## Test-gap adjudication

- Global networking patches from the old socket tests were replaced by injected Effect-shaped
  dependencies in `1125841` — **fixed**.
- Pi auth now asserts exact typed exits, including status-check failure — **fixed** in `f7b580a` and
  `558a11d`.
- Automation publication, chat cleanup, PID conservatism, Gateway handoff/candidate cleanup,
  write-boundary rejection, socket partial acquisition/close, Pi prompt cancellation, extension
  containment, atomic publication, process descendants, and bounded curl all have focused witnesses
  — **fixed/keep**.
- Broader exact-Exit rewrites for unrelated Profile/resource tests and replacing the existing TUI
  timing smoke were not needed to prove an adjudicated invariant — **deferred**, not missing proof for
  this outcome.
- Tests, required Pi callbacks, and standalone executable entrypoints remain valid Promise/Effect
  execution edges — **intentional keep**.

## Current file and method inventory

| Area | Current owner / methods | Classification |
|---|---|---|
| Scheduler publication | `src/application/automation-scheduler.ts` — `scan`, `registerClaims`, `makeAutomationScheduler` | **Keep** interruption-safe publication. |
| Recorded automation run | `src/application/automations.ts` — `makeAutomations().run`, chat bracket, terminal publication | **Keep** one truthful terminal attempt. |
| Durable automation store | `src/adapters/bun/automation-sqlite.ts` — `commitScheduleTick`, `recoverAutomationRuns`, `makeAutomationRunStore`, `discoverAutomationSources` | **Keep** transactions/schema validation/cancellation; **defer** process identity. |
| Automation domain | `src/domain/automation.ts` — mutation, terminal, completion, projection Schemas | **Keep** domain-owned persisted/write shapes. |
| Gateway ownership | `src/adapters/bun/gateway-owner.ts` — `acquire`, `inspectExistingOwner`, `release` | **Keep** bounded handoff; **narrow-document** external release TOCTOU. |
| Process cleanup | `src/adapters/bun/process.ts`; `automation-gate.ts` | **Keep** ESRCH-only benign classification and reporting. |
| Focused FS adapters | `src/adapters/fs/automation-files.ts`; `gateway-config.ts`; `profile-extensions.ts` | **Keep** current boundaries and logged best-effort cleanup. |
| Remaining application FS | `src/application/profiles.ts` — Profile registry, skill staging/promotion/rollback | **Defer** extraction until justified; retain rollback semantics. |
| Pi auth | `src/adapters/pi/auth.ts`; `src/application/auth.ts` | **Fixed/keep** one adapter Promise bridge. |
| Pi agent/memory/resources | `src/adapters/pi/pi-agent.ts`; `resources.ts`; `ziggy-tui-extension.ts`; terminal auth interaction | **Keep** scoped Effects behind Pi-required callbacks. |
| Discord/Slack transport | `src/adapters/{discord,slack}/{api,socket}.ts`; application gateway services | **Fixed/keep** typed HTTP, Effect sockets, bounded queues, scoped cleanup. |
| Telegram transport | `src/adapters/telegram/api.ts`; `src/application/gateway.ts` | **Keep** sole approved core raw-fetch adapter. |
| Composition/execution | `src/application/{agent,resident-gateway}.ts`; `src/main.ts` | **Keep** current composition; **defer** generic Layers; `BunRuntime.runMain` remains the production orchestration edge. |
| Domain/faces/total helpers | Remaining `src/domain/*`, `src/faces/automation-cli.ts`, `recent-ids.ts`, FS cause helper | **Keep** total calculations and Schema-owned boundary data; no speculative Effects. |
| Repository Pi packages | Changed extension files listed in the commit table | **Fixed/keep** package-local process/FS boundaries; Lossless Claw blocking and Web Search bound remain explicit deferrals. |
| Tooling | `package.json`, `.oxlintrc.json`, `tooling/oxlint/**` | **Keep reduced policy**, no new fixture/type-analysis project. |

All 38 production `src` files fall into the owners above. No production Effect executor was added:
`BunRuntime.runMain` is in `src/main.ts`; the two `Effect.runPromise` calls in
`src/adapters/pi/pi-agent.ts` terminate required Pi Promise callbacks, matching
`docs/research/pi-sdk-surface.md`.

## TypeScript Effect suggestions

`bun run typecheck` exits 0 and currently reports exactly five informational diagnostics:

1. `src/adapters/fs/automation-files.ts:59` — `Effect.succeed(undefined)` preserves
   `Effect<string | undefined, ...>`; `Effect.void` changes the success type to `void` under exact
   optional/value contracts.
2. `src/adapters/pi/pi-agent.ts:374` — same exact `string | undefined` reason.
3. `src/application/profiles.ts:577` — the `Effect.catch` performs rollback and then re-fails;
   `Effect.mapError` is not behaviorally equivalent.
4. `src/application/profiles.ts:585` — `Effect.catch(() => Effect.void)` is retained because the
   repository's `no-effect-escape-hatch` policy rejects `Effect.ignore`.
5. `src/main.ts:80` — same intentional catch-to-void policy.

Disposition: **narrow-document**. Do not optimize for an empty suggestion list by changing values,
rollback, or typed-error policy.

## Pinned Effect references

- `vendor/effect/packages/effect/src/Effect.ts:1166-1206` — callback adaptation and interruption
  cleanup.
- `vendor/effect/packages/effect/src/Effect.ts:6398-6403` — scoped resource ownership.
- `vendor/effect/packages/effect/src/Effect.ts:6677-6681` — `acquireUseRelease`.
- `vendor/effect/packages/effect/src/Effect.ts:6684-6693` — finalizer registration.
- `vendor/effect/packages/effect/src/Effect.ts:7362-7366` — `uninterruptibleMask` and local restore.
- `vendor/effect/packages/effect/src/Effect.ts:8642-8657` — `forkScoped`.
- `vendor/effect/packages/effect/src/Schema.ts:1368-1375` — unknown-input decoding to Effect.
- `vendor/effect/packages/effect/src/Schema.ts:12981-12997` — tagged typed errors.
- `vendor/effect/packages/effect/src/Queue.ts:562,1114` — dropping queues and shutdown.
- `vendor/effect/packages/effect/src/FileSystem.ts` and
  `vendor/effect/packages/platform-bun/src/BunFileSystem.ts` — reference filesystem capabilities.

## Current recommendations, in exact remaining order

1. **Durable process-instance identity versus PID-only recovery — defer.** Keep PID as conservative
   evidence; add no platform token or registry without a reproducible collision and migration
   contract.
2. **Gateway release TOCTOU and bounded handoff — narrow-document/keep.** Keep the two-attempt
   internal contender protocol. The release guarantee excludes an external mid-release pathname
   replacer.
3. **Remaining application filesystem imports and concrete adapter selection — defer.** Keep the
   Profile workflow and current composition until a second implementation or isolation failure
   earns focused capabilities.
4. **Cleanup observability — keep.** Preserve current reporting and intentional best-effort
   finalizers; add typed propagation only with an operator recovery path.
5. **Write-side schema/type ownership — keep.** Persisted/write transitions remain domain-Schema
   owned; transient return values remain static types.
6. **Pi memory/prompt/resource boundaries — keep.** Preserve the narrow required Promise callbacks
   and current scoped cleanup; do not build another agent loop.
7. **Socket partial acquisition/callback cleanup — keep.** Preserve one Effect-shaped transport
   boundary and bounded cleanup; do not add a second socket abstraction.
8. **Reduced lint policy/tooling coverage — keep.** Do not start a fixture or type-provenance project
   in this adjudication.
9. **TypeScript Effect suggestions — narrow-document.** Keep the five semantically intentional
   advisories.
10. **Historical scheduler plan — fixed.** Retain the Slice 3 freeze plus its concise current-state
    addendum; use live source for present behavior.
11. **Audit accuracy — fixed.** This matrix, inventory, commit evidence, verification counts, and
    recommendations supersede the old gap list.

## Overengineering boundary

Do not add a process-start registry, second durable owner authority, directory/OS lock protocol,
generic filesystem Layer family, duplicate socket abstraction, lint fixture/type-provenance project,
or fake Effect wrapper around Pi-required callbacks without the concrete witness named above. The
remaining deferred items are decision records, not permission to start later roadmap work.
