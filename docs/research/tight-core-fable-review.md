# Fable review of the tight-core audit

2026-09-29. Second opinion on `tight-core-alignment-audit.md`, framed around rebuilding the core rather than patching it. Read-only review; claims spot-checked (runPromise bridges, print-mode console patch, per-handle UI semaphore). Caveat on decision 1 (drop the writer lease): the 2026-09-28 LOG entry deliberately made the resident optional for extensions and `wake` conversation delivery, and added the writer lease to support that. Dropping the lease means reversing that decision.

## 1. Verdict on the audit

**Facts: accurate. Frame: wrong.** The audit reproduces five real defects and reads every file honestly, but it then instructs "preserve" for exactly the machinery that makes the core unreadable. Its "Preserve these invariants" list (`tight-core-alignment-audit.md:219-230`) enshrines session writer leases, package runtime leases, Opening/Live/Closing registry states, extension generation binding, quarantine and exact rollback as "necessary policy". None of those appear in the spec (`minimal-ziggy-scout.md`). They are accreted defences from the parallel-stream "core review" (`docs/plans/core-review.md`) and LOG entries such as "concurrent writers silently fork a session" (`LOG.md:1068`). Each was a reasonable local fix; together they are a second runtime on top of Pi.

What the audit gets right:
- A02 (listing prunes the registry concurrently, `profiles.ts:315-348`) and A05 (unbounded `agent_run` parent copy, `specialist.ts:898`) are real, cheap, and survive any rebuild. Do them.
- The failing quarantine test is a contract mismatch: `selectSessionModel` (`models.ts:95`) tolerates "no default model" and `openChat` only fails on Pi's fallback message (`pi-agent.ts:1217`). A rebuilt open path should fail typed at open when the Profile has no resolvable model.
- The diagnostic triage is sensible and not overclaimed.

What evaporates if you rebuild instead of patch:

| Finding | Why it disappears |
|---|---|
| A01 writer-release ordering | No cross-process writer lease in the rebuilt session (see section 6, decision 1). |
| A03 memory lock symlink | No SQLite lock artifact for memory docs; in-process semaphore + `O_NOFOLLOW` write + rename. |
| A04 registry handle leak | Registry shrinks to a Map with `Effect.acquireRelease`; the handoff bug is structural to the 3-state machine. |
| A06 stale branch read | `profile-runtime-directory.ts` is deleted; resident holds one `Map<ProfileId, Branch>` directly. |
| A07 owner-bound Promise runner | The 17 `runPromise` escapes (`chat-runtime-binding.ts:41,56,67,70,78,118,141`, `pi-agent.ts:302,1185,1404`, `specialist.ts:407`) exist only to interpose lease transitions in Pi callbacks. No lease, no bridges. The remaining legitimate bridges are tool `execute` callbacks (memory_write, agent_run) and can use one `FiberSet.makeRuntimePromise` per runtime scope. |
| A08 preflight loader invalidation | Preflight is deleted; admission is "decode, resolve, copy, hand paths to Pi, fail closed on diagnostics". |
| D01 handle forwarding | `ZiggyAgentLive` (`agent.ts:177-204`) and `runtime.ts:34-50` are pure forwarding; the Pi module implements `ZiggyAgent` directly. |
| L04 thinking Promise | Gone with the rewrite of controls. |

Where "tighten" is the wrong call: the audit says "Do not begin by splitting `pi-agent.ts`... First make its acquisition/stop/lease contract singular" (`:158`). The singular contract is: **there is no lease contract**. That is a smaller change than making the current one consistent across 6 paths (`pi-agent.ts:1192,1203,1410,271,327,1508,1535`, `specialist.ts:407,433`, `session-lease.ts:270`).

## 2. Why is it shaped like this?

Read `git log`: a sequence of extractions ("Extract Pi prompt turn lifecycle", "Separate Pi chat session binding", "Transfer writer leases across Pi session replacement", "Quarantine packages that break during runtime rebuilds", "Prove resume serialization and interruption with controlled interleavings"). Each commit answered a review finding with a new module and a new lock, never by removing a requirement. The spec's ownership rule ("the resident gateway is the only interactive session owner", `minimal-ziggy-scout.md:9`) was never used to delete anything.

| Concept | Problem it solves | Does Pi already solve it? | Essential? | Minimal version |
|---|---|---|---|---|
| **ZiggyAgent** (`application/agent.ts`) | Client-neutral service every face uses | n/a, this is the spec's one contract | Yes | Keep the *interface*. Delete `ZiggyAgentLive` forwarding (`:177-204`); the Pi module provides the layer. |
| **PiAgent** (`pi-agent.ts`, 1590) | Build Pi runtime per Profile; open/print/specialist paths | Pi builds runtimes; Ziggy adds Profile policy | The policy is essential, the module is not | One `openSession` (~250 lines): resolve model via `ModelRuntime`/`SettingsManager`, compose loader options, `createAgentSessionRuntime`, return a `Session`. `askOnce` = open + prompt + close (delete the `runPrintMode` path and its `console.error`/`newSession` monkeypatches at `:319-359`). |
| **SessionRuntime / RuntimeSession** (`runtime.ts`, 50) | Nothing; aliases `events`/`close` onto `ChatHandle` | n/a | No | Delete. |
| **ChatHandle** | The per-session handle faces hold | Pi's `AgentSession` is the same shape with Promise API | Yes, as the shim type | Keep as the public name; it becomes the *only* handle type. |
| **chat-registry** (914) | Resident-owned live sessions: shared open, replay for reconnecting UI clients, capacity, automation destinations | No | Partly | ~250 lines: `Map<key, Live \| Deferred>`, `getOrOpen` with `Deferred` dedupe, bounded replay ring, scoped teardown. Move `rememberDestination` (automation) out. Drop channel/registry "ownership" split; every entry is `acquireRelease`d by the registry. |
| **session-lease** (322) + `makeSessionLeaseTransitions` | Two processes opening the same JSONL fork it | Pi does not lock sessions (only auth/settings use `proper-lockfile`) | No, given the spec | Replace with one rule: `run -c`/ACP refuse to open a `sessions/local/**` directory when `gateway-owner` (`adapters/bun/gateway-owner.ts:130,249`) says a resident is live. Automation `wake` without resident writes to its own fresh session (already does). That covers the real incident in `LOG.md:1068`. |
| **profile-runtime-lease** (131) + **profile-runtime-lock** (85) | Pin package folders while any runtime runs so `extensions update` cannot swap them | No | No | Spec: `update` "replace a stopped Profile's managed bundled copy". `update` checks the gateway owner and refuses if running; copies into `<id>.new` then renames. Residual race with a concurrent `ziggy run` is acceptable. |
| **profile-extension-lock** (318) | Serialise `extensions add/remove` across processes | No | Marginal | Atomic write of `extensions.json` (temp + rename). Two humans typing `extensions add` concurrently is not a supported scenario. |
| **chat-runtime-binding** (217) | Re-`bindExtensions` after Pi replaces the session; wrap `newSession/fork/switchSession` with lease reserve/transition/poison; serialise controls | Pi: `setRebindSession`, `switchSession`, `newSession` exist; Pi already serialises with its own queue | The rebind hook (10 lines) is essential; the rest is lease plumbing | `runtime.setRebindSession(resubscribe)`; expose `resume(ref)` = `runtime.switchSession(path)`. One `Semaphore(1)` for controls is fine. Note `ui-gateway/sessions.ts:152-154` adds a *third* semaphore per handle. |
| **prompt-turn** (100) | Turn a `prompt()` into "final assistant text or typed error" | Pi: `agent_settled` event, `waitForIdle()` | Yes (small) | Keep the shape (`Effect.callback` over `subscribe` + `agent_settled`) but share the projector with the handle instead of creating a second one (`prompt-turn.ts:31` vs `pi-agent.ts:832`). ~60 lines. |
| **chat-event-projector** (173) | Bounded `ChatEvent` union from `AgentSessionEvent` | No (Pi events are richer) | Yes | Keep as is. |
| **specialist** (1010) | `agent_run`, `agent_discuss`, direct run, policy selection | Pi builds child runtimes; `parentSession` header supported | Essential feature, bloated impl | `selectSpecialist` (`:680-811`) resolves models through a *parent runtime*; `runSpecialist` (`pi-agent.ts:1516-1543`) builds and disposes an entire Pi runtime with `SessionManager.inMemory` just to read `services.modelRuntime`. Use `ModelRuntime.create` (as `models.ts:176` already does). Child = `openSession` with `{ systemPrompt, model, thinking, tools, noTools: "all", parentSession }`. Discussion = loop over that. ~350 lines total. |
| **profile-extensions** admission/preflight/rollback (1272 + fs 711 + preflight 314 + diagnostics 223 + tool 798 + lock 318 = 3,636) | Select/copy packages, validate before select, roll back on failure, quarantine broken packages, pause package-owned automations | Pi: loader diagnostics, `pi.extensions` manifest, `additionalExtensionPaths`/`additionalSkillPaths` | Selection + copy + fail-closed is essential; preflight-in-a-temp-agentDir, generations, rollback journals, quarantine and automation-ownership are invented | `extensions.ts` ~350 lines: decode `extensions.json`, resolve id → Profile shelf else bundled, copy required + selected, produce loader options. At open: if Pi reports a diagnostic for an admitted package, fail typed with the diagnostic (the owner then removes it). `doctor` runs the same open and reports. The agent-facing `profile-extension-tool` becomes a bundled package that shells out to `ziggy extensions add/remove` (it is a Profile-mutating operation and should go through the CLI face). |
| **memory-write-tool** (655) | `memory_write` Pi tool: read, apply op, cap, atomic publish, per-doc lock, backups | No | Yes (spec primitive 4) | ~180 lines: validate input; per-document in-process `Semaphore`; read with `O_NOFOLLOW`; apply pure op from `domain/memory.ts` (keep, it is good); reject over cap; write `.tmp` + `rename`. No SQLite, no backups, no hardlinks. |
| **sessions / session-history / transcript-lines / session-discovery / session-name / session-lineage** (~1,320) | Read-only list/show; find recent; naming; parent links | Pi: `SessionManager.list(cwd, dir)` (read-only), `SessionManager.open`, `parseSessionEntries`, `continueRecent`, `appendSessionInfo` | list/show essential; the rest mostly | `sessions.ts` ~250 lines: `lstat` root + files (reject symlinks), then `SessionManager.open` per file and project id/parent/timestamps/entry count/model changes/usage. Delete the streaming JSONL scanner and cursor/digest history cache unless the UI depends on `readSessionHistory` (it does: `ui-gateway`); if so keep a 100-line "last N user/assistant texts" projection over `getEntries()`. |
| **profile-runtime-directory** (78) | Map of resident branches | n/a | No | Delete; resident holds the Map. |
| **automation-result** (142) + `appendAutomationResult` (`pi-agent.ts:933-1066`) | Deliver a wake result into a live conversation idempotently | Pi: `sendCustomMessage` | Product feature, keep small | Keep `sendCustomMessage` + receipt check (~60 lines) on the handle. Drop the poison flag and the triple re-verification. |

Serialisation stack today for one UI control: registry `statePermit` → `ui-gateway/sessions.ts` per-handle semaphore → `binding.withControl` semaphore → Pi's own queue. Four layers. One is enough (Pi's), plus one Ziggy semaphore for `resume`.

## 3. Target core

Core = "everything under `ZiggyAgent` plus Profile policy". Faces, gateways, UI protocol, scheduler, self-update, resident service ops stay where they are and are not counted.

```
src/core/                                      ~lines
  profile.ts        target/name resolution, init (SOUL only), registry list  250   (from domain/profile + application/profiles, A02 fixed: list is read-only)
  memory.ts         scopes, doc paths, caps, pure ops (keep domain/memory), read/write fs  450
  agents.ts         agents/<id>.md parse + policy validation (keep fs/profile-agents)  500
  extensions.ts     decode extensions.json, resolve shelf/catalog, copy, loader options  350
  models.ts         ModelRuntime/SettingsManager over Profile paths (keep adapters/pi/models)  450
  auth.ts           keep adapters/pi/auth  330
  sessions.ts       read-only list/show/history via Pi parse  300
  pi/runtime.ts     THE Pi importer: openSession, Session handle, projector, prompt-turn  550
  pi/tools.ts       memory_write, agent_run, agent_discuss (+ ziggy_help, pi_docs stay as inline ext)  450
  agent.ts          ZiggyAgent service + errors (domain/agent kept)  150
  composition.ts    per-command layers  120
                                                            ≈ 3,900 vs 17,255 today
```

**The one contract** (faces already code against ~this; `ChatHandle` keeps its name so nothing recompiles):

```ts
interface ZiggyAgentApi {
  open: (target: ProfileTarget, opts: {
    sessionDirectory: string; mode: "continue" | "fresh";
    context: ChatContext; model?: ChatModelOverride; name?: string;
    agentId?: string;                     // specialist rail: policy from agents/<id>.md
  }) => Effect<ChatHandle, ZiggyAgentError, Scope>;   // scoped: close is a finalizer
  runOnce: (target, prompt, opts) => Effect<string, ZiggyAgentError>;      // open+prompt+close
  runSpecialist: (target, agentId, task, ctx) => Effect<ProfileAgentRunResult, ...>; // open(agentId, fresh)+prompt+close
}
interface ChatHandle { prompt; steer; followUp; abort; subscribe; isIdle; modelState; setModel; setThinkingLevel; resume; currentSession; appendAutomationResult; dispose }
```

`openChat`/`openSpecialistChat` become 5-line shims over `open` for the transition (`ui-gateway/sessions.ts:372-382`, `gateway.ts:239`, `slack/turn.ts:314`, `discord/turn.ts:181`, `automations.ts:451`, `acp.ts:251`). The resident's registry sits on `open` unchanged in signature.

## 4. Keep / rebuild / delete

| File | Disposition | Rebuilt shape |
|---|---|---|
| `domain/profile.ts`, `domain/memory.ts`, `domain/agent.ts`, `domain/session.ts`, `domain/extension-catalog.ts` | **Keep** | Fix L02 grammar share; L01 is a decision (reject `~name`). |
| `domain/profile-extension.ts` | Rebuild | Keep `ProfileExtensionInvalid`, `…Unapproved`, `…LoadFailed`; delete rollback/generation/preflight errors. |
| `domain/profile-directory.ts` | Keep | |
| `application/profiles.ts` | Rebuild (small) | list is read-only (A02); L03 tag fix. |
| `application/memory.ts`, `adapters/fs/memory-files.ts` | Keep, merge | Port lives in core (A09). |
| `application/profile-agents.ts`, `adapters/fs/profile-agents.ts` | Keep | |
| `application/models.ts`, `adapters/pi/models.ts`, `adapters/pi/auth.ts`, `application/auth.ts` | Keep | |
| `application/sessions.ts` | Keep | `isSessionLeaseHeld` field goes. |
| `application/ziggy-paths.ts`, `adapters/bun/ziggy-paths.ts`, `adapters/fs/cause.ts`, `adapters/fs/profile-store.ts` | Keep | |
| `application/agent.ts` | Rebuild | Interface + `open`; no `ZiggyAgentLive` forwarding. |
| `adapters/pi/pi-agent.ts` | **Rebuild** → `core/pi/runtime.ts` | One `openSession`; `askOnce` without print mode; specialists via same path. |
| `adapters/pi/runtime.ts` | Delete | |
| `adapters/pi/chat-runtime-binding.ts` | Delete | 15 lines of rebind survive inside runtime.ts. |
| `adapters/pi/prompt-turn.ts` | Rebuild (shrink) | Share projector; no voice hub param (voice = tool event). |
| `adapters/pi/chat-event-projector.ts`, `provider-failure.ts` | Keep | |
| `adapters/pi/session-lease.ts` | Delete | Replaced by resident-owner check. |
| `adapters/pi/profile-runtime-lease.ts`, `adapters/bun/profile-runtime-lock.ts` | Delete | |
| `adapters/bun/profile-extension-lock.ts` | Delete | Atomic rename of `extensions.json`. |
| `adapters/pi/specialist.ts` | **Rebuild** → `core/pi/tools.ts` | Tools over `openSession`; policy selection via `ModelRuntime`; bounded parent output (A05). |
| `adapters/pi/session-lineage.ts`, `session-name.ts` | Keep (fold into runtime.ts) | |
| `adapters/pi/session-discovery.ts` | Delete | `SessionManager.continueRecent` + header via `SessionManager.open`. |
| `adapters/pi/sessions.ts`, `session-history.ts`, `transcript-lines.ts` | **Rebuild** → `core/sessions.ts` | Pi parse + lstat hardening; history = bounded projection over entries. |
| `adapters/pi/automation-result.ts` | Keep (shrink) | Receipt + `sendCustomMessage`. |
| `application/profile-extensions.ts`, `adapters/fs/profile-extensions.ts`, `adapters/pi/profile-extension-preflight.ts`, `profile-extension-diagnostics.ts`, `profile-resource-loader.ts`, `resources.ts` | **Rebuild** → `core/extensions.ts` | Decode/resolve/copy/loader options; diagnostics fail closed at open; no preflight, generation, rollback, quarantine, automation pause. |
| `adapters/pi/profile-extension-tool.ts` | Delete from core | Becomes a package in `extensions/ziggy-operations` that shells to the CLI, or dropped. |
| `adapters/pi/memory-write-tool.ts` | **Rebuild** | ~180 lines; semaphore + `O_NOFOLLOW` + rename. |
| `adapters/pi/profile-core-inline-extensions.ts`, `profile-prompt.ts`, `profile-agent-guidance.ts` | Keep | The memory-into-system-prompt hook is the right Pi idiom. |
| `adapters/pi/pi-docs.ts`, `ziggy-help.ts`, `standalone-runtime.ts`, `doctor-checks.ts` | Keep | Doctor shrinks once preflight goes. |
| `application/chat-registry.ts` | **Rebuild** | ~250 lines, resident-owned Map + Deferred dedupe + replay; move destinations to automations. |
| `application/profile-runtime-directory.ts` | Delete | |
| `application/profile-directory.ts` | Keep | A09 port move optional. |
| `src/main.ts`, `src/composition.ts`, `src/catalog.ts` | Keep, continue A10 | |

## 5. Tests

Run time today for the three biggest real-Pi files: **71 tests in 1.3s** (`bun test test/adapters/pi/pi-agent.test.ts …`). Real Pi is cheap; the loop can be real.

**Keep (real invariants, already exercise real Pi or real FS):**
- `pi-agent.test.ts:625` ephemeral context is sent once and never persisted (real SSE fixture server, real JSONL).
- `pi-agent.test.ts:709` resumed session uses the Profile model, not the historical one.
- `pi-agent.test.ts:1391` child header points at parent; isolated transcript.
- `pi-agent.test.ts:1287` Pi writes JSONL on first user message (pins Pi behaviour we depend on).
- `profile-extensions.test.ts:283,339,774` selection bytes preserved / atomic / absent-file restore; `resources.test.ts` Profile-owned wins collisions.
- `memory-write-tool.test.ts` cap rejection + atomic replace; `domain/memory.test.ts`.
- `profiles.test.ts` init idempotence and no-clobber.
- `sessions.test.ts` symlink refusal and "list writes nothing".

**Delete (ceremony, or test the machinery being removed):**
- `chat-registry.test.ts:91-243` (fake `makeChatHandle`, tests Deferred plumbing), `session-lease.test.ts`, `session-runtime-transition.test.ts` (352 lines of reserve/transition/poison), `profile-runtime-lock.test.ts`, `profile-extension-lock.test.ts` (308), `profile-extension-preflight.test.ts` (423), `pi-agent.test.ts:239-341,1014-1098` (lease release / rollback branches), `profile-extensions.test.ts:466-771` (preflight, quarantine, rollback, automation pause; the fixture stubs `preflight` at `:64`), `specialist.test.ts:170-300` (fake runner + TypeBox schema shape assertions), `automation-result.test.ts` retry/poison branches, `resident-service.test.ts` renderers.
- Anything asserting a `_tag` of an error that only exists because of a lock.

**Verification loop (the gate for every slice):**

Harness (`test/harness/`, ~200 lines, reuse what `pi-agent.test.ts:628-660` already does):
1. `fixtureProvider(script)`: `Bun.serve` on port 0 speaking `openai-completions` SSE; `script` is an array of turns, each either `{ text }` or `{ toolCall: { name, args } , then: text }`, so tool round-trips (memory_write, agent_run) are driven for real. Writes `models.json`/`settings.json` into the Profile. Alternative with no HTTP: an inline extension calling `pi.registerProvider("fixture", { streamSimple })` (`extensions/types.d.ts:1363-1380`); prefer this if the SSE encoding of tool calls gets fiddly.
2. `tmpProfile()`: `mkdtemp` + `SOUL.md`, optional `agents/`, `extensions.json`, `MEMORY.md`.
3. `cli(args, { ZIGGY_HOME })`: `Bun.spawn(["bun", "src/main.ts", ...])` capturing stdout/exit code. Also usable against the built binary.
4. `resident(profile)`: start `serve` in-process under a Scope, connect with `packages/ui-sdk` client over the real WS.

End-to-end proofs, one per spec primitive:

| # | Primitive | Proof |
|---|---|---|
| 1 | Profile | `cli init x` twice: second exits non-zero, SOUL bytes unchanged; `cli profiles` lists it. |
| 2 | Provider | `open(inMemory)` + prompt returns scripted text; missing `settings.json` default → typed `ProviderConfigError` at open. |
| 3 | Session | resident turn via WS → `cli sessions show <id>` shows 1 user/1 assistant, lineage none; snapshot of dir before/after `sessions list` is byte-identical. |
| 4 | Memory | scripted `memory_write` tool call mid-turn → `MEMORY.md` replaced atomically; next `open` sends it in the system prompt (assert on fixture request body); transcript has no memory bytes; over-cap op rejected. |
| 5 | Extension | `extensions.json` with unapproved id → open fails typed; Profile-owned package with same id as bundled → its skill path wins (assert request system prompt); broken package → open fails with Pi diagnostic. |
| 6 | Gateway | resident owns `sessions/local/main`; `cli run -c` while resident live → typed refusal; after stop → succeeds. |
| 7 | Automation | gate `exit 1` → zero fixture requests; gate `exit 0` → one fresh JSONL under `sessions/automations/<id>/`, result delivered. |
| 8 | Profile Agent | scripted parent `agent_run` → one child JSONL with `parentSession` header, parent tool result bounded; `cli agents run @id "task"` → one root JSONL with the agent's model/thinking. |

Target: whole loop < 15s, run by `bun test test/e2e` and as the first step of `bun run check`. Every slice below is "green before, green after".

## 6. Plan (vertical slices)

| # | Slice | Throw away | Build | Proof | Faces during |
|---|---|---|---|---|---|
| 0 | Harness on current code | nothing | `test/harness`, 8 proofs | all 8 green against today's core (proof 6 will initially assert the current `SessionHeld` behaviour) | untouched |
| 1 | **Session core** | `pi-agent.ts`, `runtime.ts`, `chat-runtime-binding.ts`, `session-lease.ts`, `session-discovery.ts`, `profile-runtime-lease.ts`, `profile-runtime-lock.ts`, `ZiggyAgentLive` | `core/pi/runtime.ts` + `core/agent.ts` with `open`; resident-owner refusal | 2, 3, 6 + kept pi-agent tests re-pointed | `openChat`/`openSpecialistChat` shims; `ChatHandle` type unchanged; gateways compile unchanged |
| 2 | Specialists | `specialist.ts` | `core/pi/tools.ts` `agent_run`/`agent_discuss` over `open`; policy via `ModelRuntime`; A05 bound | 8 | `runSpecialist` signature unchanged |
| 3 | Extensions | `application/profile-extensions.ts`, `fs/profile-extensions.ts`, preflight, diagnostics, lock, extension tool, `resources.ts` | `core/extensions.ts`; `doctor` reports open diagnostics | 5 | `extensions-cli.ts` and `ui-gateway/management-extensions.ts` need a 1-day shim (`ProfileExtensionsApi` list/add/remove kept, `validate` = try open) |
| 4 | Memory | `memory-write-tool.ts` | rebuilt tool | 4 | none |
| 5 | Sessions read-only | `sessions.ts`, `session-history.ts`, `transcript-lines.ts` | `core/sessions.ts` | 3 | `SessionsApi` unchanged |
| 6 | Registry | `chat-registry.ts`, `profile-runtime-directory.ts` | 250-line registry; destinations move to automations | 3, 6, 7 + UI reconnect replay | `ChatRegistryApi` surface kept for ui-gateway/slack/discord |
| 7 | Composition | legacy dispatch in `main.ts` | per-command layers (A10) | `cli` proofs + exit codes | none |

**Riskiest step: slice 1.** Every face and both gateways hold a `ChatHandle`, and `ui-gateway/sessions.ts` (788 lines) leans on `resume`, `isIdle`, `currentSession`, `appendAutomationResult`. Mitigation: freeze the `ChatHandle` TypeScript interface for the whole rebuild; slice 1 is "same interface, new implementation"; the harness proofs 3 and 6 plus one WS smoke (open, prompt, disconnect, reconnect, replay) are the gate.

**Decisions the owner must make (they change the plan):**
1. **Drop the cross-process writer lease** in favour of "resident is the only interactive owner; `run -c`/ACP refuse a resident-owned directory while the resident PID file is live." Yes, unless you need two processes on one JSONL. This alone removes ~900 lines and all 17 `runPromise` bridges except tool callbacks.
2. **`ziggy run` stops using `runPrintMode`** and becomes open + prompt + print. Deviation from `minimal-ziggy-scout.md:44` ("CLI face delegates to `runPrintMode`"); worth it because print mode owns stdout/signals and forces the `console.error` and `newSession` monkeypatches. `--json` needs 20 lines of your own.
3. **Extension admission becomes fail-closed without preflight/rollback/quarantine/automation-ownership pause.** Cost: a broken optional package blocks the resident until removed (doctor tells you which). If you want the "skip broken optional package" UX, that is the one piece to keep (~80 lines: partition Pi diagnostics by package root, rebuild once).
4. **`agent_run`/`agent_discuss` stay core** (spec primitive 8) but as tools over `open`; the *extension tool* and `doctor` package-health views leave core.
5. **Memory locking** goes in-process only. Concurrent `ziggy run` processes writing `MEMORY.md` at the same instant is last-writer-wins by rename; accept or keep a single `flock`-style file lock (50 lines), not SQLite.

## 7. Open questions for the owner

1. Is there any supported scenario with two Ziggy processes writing the same session JSONL (e.g. `ziggy run -c` while the resident runs)? If "no, refuse", decision 1 stands.
2. Does anything external consume `sessions show`'s cursor/digest history format (`session-history.ts`), or only the web UI via `ui-gateway`? Determines whether slice 5 keeps a history projection.
3. Must the web UI's "Extensions" pane keep per-package health (quarantine status) or is "selected / missing / failed at last open" enough?
4. Is `appendAutomationResult` (wake result into a live conversation) a feature you use? If not, delete `automation-result.ts` and the handle method outright.
5. Effort: slice 0 M; slices 1-2 L each; 3 L; 4-5 M; 6 M; 7 S. Total roughly 2 weeks of focused work if done serially; slices 3-6 can run in parallel after 1.

Key file references: `/Users/yesh/code/personal/ziggy/src/adapters/pi/pi-agent.ts`, `/Users/yesh/code/personal/ziggy/src/adapters/pi/chat-runtime-binding.ts`, `/Users/yesh/code/personal/ziggy/src/adapters/pi/session-lease.ts`, `/Users/yesh/code/personal/ziggy/src/adapters/pi/specialist.ts`, `/Users/yesh/code/personal/ziggy/src/application/chat-registry.ts`, `/Users/yesh/code/personal/ziggy/src/application/profile-extensions.ts`, `/Users/yesh/code/personal/ziggy/src/application/agent.ts`, `/Users/yesh/code/personal/ziggy/src/adapters/pi/runtime.ts`, `/Users/yesh/code/personal/ziggy/test/adapters/pi/pi-agent.test.ts` (fixture provider pattern at `:628`), `/Users/yesh/code/personal/ziggy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1363` (`ProviderConfig.streamSimple` for a no-HTTP scripted provider).
