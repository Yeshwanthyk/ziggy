# Effect-native full-repository audit

Date: 2026-08-06

## Conclusion

Ziggy is **not yet Effect-native throughout its core architecture**.

The domain model is mostly sound and `src/main.ts` is correctly the only production Effect execution edge, but application services still adapt Node/Bun/Pi Promises themselves, Discord and Slack expose Promise-shaped socket clients, and multiple adapters own raw fetch, callback, timer, and cleanup lifecycles manually. The custom lint suite does not prove otherwise because it broadly exempts `src/adapters/**`, recognizes only narrow Promise surface names, and contradicts the repository's raw-fetch skill.

The current checkout contains **116 tracked code-like files** with `.ts`, `.mjs`, `.py`, or `.sh` extensions (excluding `vendor/effect`). Eight read-only scouts inspected every production source, every extension/script, every test/helper, all lint/config surfaces, the concurrent automation changes, and the pinned Effect submodule. The audit also ran repository checks and tests.

### Current verification snapshot

- `bun run test`: **passed** — 97 Bun tests plus all shell/Python helper suites.
- `bun run typecheck`: **passed** with Effect Language Service suggestions.
- `bun run check`: **passed**.

The checkout changed during the audit. The final verification used commit `70adab8` (`Implement progressive automation force runs`); transient automation compile/lint failures observed while that commit was being assembled are not findings in this report. The final automation code removes the unsafe assertions, uses `Predicate.isTagged`, has concrete config capability types, and carries targeted test-boundary suppressions.

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
| `src/adapters/bun/process.ts` | `killProcess` | Return an Effect or explicitly model/log non-benign kill failure instead of swallowing every throw. |
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
| `src/application/automations.test.ts` | `tree` helper | Traverse with `Dirent`; do not interpret every read failure as a directory. |
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

All 33 production `src` files are classified below: 22 with action items and 11 as keep.

### Core production files with action items

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
- `src/application/automations.ts`
- `src/application/discord-gateway.ts`
- `src/application/gateway.ts`
- `src/application/profiles.ts`
- `src/application/slack-gateway.ts`
- `src/domain/gateway.ts`
- `src/domain/profile.ts`
- `src/main.ts`

### Core production files reviewed as keep

- `src/adapters/bun/automation-gate.ts` — valid narrow Bun process bridge; current interface Promise is adapter-host-owned and only `run` escapes as Effect.
- `src/adapters/pi/resources.ts` — Promise wrapped at adapter and only Effect exposed.
- `src/adapters/pi/ziggy-tui-extension.ts` — required Pi/TUI callback boundary.
- `src/adapters/terminal/auth-interaction.ts` — required Pi Promise callback boundary.
- `src/domain/agent.ts`
- `src/domain/automation.ts` — current schema-derived/tagged model is substantially improved.
- `src/domain/discord.ts`
- `src/domain/memory.ts`
- `src/domain/slack.ts`
- `src/domain/telegram.ts`
- `src/faces/automation-cli.ts`

### Test files with action items

- `src/adapters/discord/socket.test.ts`
- `src/adapters/pi/resources.test.ts`
- `src/adapters/pi/ziggy-tui-extension.test.ts`
- `src/application/automations.test.ts`
- `src/application/profiles.test.ts`
- `extensions/skill-creator/skills/skill-creator/scripts/test_package_skill.py`

All other test files, including `src/faces/automation-cli.test.ts`, were reviewed and are acceptable execution boundaries for their current contracts.

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

1. **Repair lint policy/gaps** enough that adapter directories are not blanket exemptions and tests have an explicit policy.
2. **Convert Pi auth adapter and application auth** to one Effect bridge.
3. **Move gateway config and automation filesystem reads** behind focused Effect-native filesystem capabilities.
4. **Replace Discord/Slack Promise socket contracts** with scoped Effect/Queue/Stream contracts.
5. **Settle raw HTTP ownership** and refactor socket connection HTTP behind typed operations.
6. **Move the rest of Profile filesystem mechanics** from application to adapters in vertical slices.
7. **Shrink the Pi memory Promise island** and make cleanup policy explicit.
8. **Preserve structured causes and repair smaller schema/type ownership issues.**
9. Address standalone extension reliability/security findings separately; do not mix them into the core Effect migration.
