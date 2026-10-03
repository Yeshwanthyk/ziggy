## Session runtime and the client-neutral handle contract

### 1. Files

| File | Lines | src/test fan-in | Role |
|---|---|---|---|
| src/adapters/pi/pi-agent.ts | 1590 | 3 / 5 | Builds the Pi runtime (resources, quarantine, tools, model, activation) and holds four entrypoints (`askOnce`, `openChat`, `openSpecialistChat`, `runSpecialist`), the handle implementation, live controls, and live automation append. |
| src/application/agent.ts | 204 | 21 / 14 | `ChatHandle`, `ChatEvent`, the `ZiggyAgent` tag, a pure-forwarding `ZiggyAgentLive`, and the `makeChatHandle` fake factory. |
| src/domain/agent.ts | 245 | 23 / 8 | Typed errors (`SessionHeld`, `SessionBusy`, the Specialist* errors), `ChatModelOverride`. |
| src/adapters/pi/runtime.ts | 50 | 1 / 0 | Spreads a `ChatHandle` and adds the aliases `events` and `close`. Its only consumer is agent.ts:181. |
| src/adapters/pi/chat-runtime-binding.ts | 217 | 1 / 1 | Re-binds extensions after a Pi session replacement. Carries a semaphore, a `switching` flag, and lease reserve/transition/poison around `newSession`/`fork`/`switchSession`. |
| src/adapters/pi/session-lease.ts | 322 | 6 / 7 | Per-session SQLite `BEGIN IMMEDIATE` writer lock, a `.owner` pid file, and the `makeSessionLeaseTransitions` state machine. |
| src/adapters/pi/profile-runtime-lease.ts | 131 | 2 / 1 | Holds a package reader lease for each Pi runtime, checks for an unfinished update journal, and keeps the lease after a failed dispose (`failedDisposalLeases`). |
| src/adapters/bun/profile-runtime-lock.ts | 85 | 3 / 1 | SQLite shared (runtime) and exclusive (extension update) Profile lock. |
| src/adapters/pi/prompt-turn.ts | 100 | 2 / 1 | Turns one prompt into the final assistant text or a typed error. |
| src/adapters/pi/chat-event-projector.ts | 173 | 2 / 1 | Maps Pi events to the bounded `ChatEvent` union. |
| src/adapters/pi/provider-failure.ts | 68 | 2 / 1 | `providerError` and `piPromise` mapping. |
| src/adapters/pi/automation-result.ts | 142 | 4 / 4 | Receipt schema and the stored append of an automation result under a lease. |
| src/adapters/pi/session-name.ts | 51 | 2 / 1 | Semantic first name for a session (a direct call plus an inline extension). |
| src/adapters/pi/session-lineage.ts | 34 | 2 / 1 | Session reference and child-session directory. |
| src/adapters/pi/standalone-runtime.ts | 88 | 1 / 1 | Compiled-binary Photon/OAuth/Bedrock bootstrap. It has nothing to do with sessions. |

### 2. What this area is for

It implements spec primitive 3 (**Session**) and the face contract described at minimal-ziggy-scout.md:44: "`ZiggyAgent` is client-neutral: open a Profile, submit/steer/abort a Session, observe events, close resources." Pi owns the JSONL, the loop and the events. Ziggy adds Profile policy on top:

- Which resources and tools are admitted.
- The model comes from Profile files, not the transcript.
- Ephemeral per-turn context.
- `@agent` mentions and specialist rails.
- Bounded progress events.
- Idempotent delivery of automation results into a conversation.

For the owner, these must hold:
- A face can open, prompt, steer, abort, observe and close a session without knowing Pi exists.
- Every Profile turn lands in one Pi JSONL.
- No transcript gets two concurrent writers in the setups that actually occur.
- `run` stays a one-shot print (spec :9, :13, :44). The resident is the only *interactive* owner (spec :9, :82), yet it stays optional for `run`, `wake` and ACP (LOG.md:1065-1069).

### 3. How it got this shape / the mistakes

**Mistake 1: defence by accretion, all in one day (2026-09-28).**
- `9828ac5e` added the writer lease.
- `a4946ad2` transferred it across Pi replacements (the transitions state machine, specialist.ts +31).
- `73bf909b` held it for the process lifetime (session-lease.ts +281/−157).
- `dffa347e` fixed print-lease cleanup ordering.
- `b7ebe794` added leased resume (+184 lines in pi-agent).
- `c0009a24` extracted `chat-runtime-binding`.

Each commit answered a review finding by adding a module or check. None asked which writers can actually collide. The result is 54 lease references in pi-agent.ts, 11 in the binding and 4 in specialist.ts. Ten `Effect.runPromise` bridges exist only to call lease transitions from Pi callbacks: chat-runtime-binding.ts:56,67,70,78,118,141; pi-agent.ts:302,1185,1404; specialist.ts:407.

**Mistake 2: leasing sessions that cannot be contended.**
- `runSpecialist` leases a root it just created with `SessionManager.create` (pi-agent.ts:1495-1510).
- Specialist children lease fresh child ids (specialist.ts:395-412).
- `newSession` and `fork` "transition" to ids that Pi generated a moment earlier (chat-runtime-binding.ts:104-149; Pi creates them at agent-session-runtime.js:153-156 and :199-201).

Only `switchSession` targets an existing transcript. Pre-reserving before a switch is legitimate there, because Pi tears down the old session *before* it builds the new one (agent-session-runtime.js:136-137).

**Mistake 3: stacked serialization.** One UI resume passes through:
1. the registry `statePermit` (chat-registry.ts:276)
2. a per-handle `WeakMap` semaphore in the gateway (ui-gateway/sessions.ts:152-163, used at :496, :572, :751, :756)
3. the binding semaphore plus the `switching` flag (chat-runtime-binding.ts:27-43, :194-207)
4. `requireWriter`/`requireIdle` (pi-agent.ts:725-751)
5. `whileNotSwitching` (pi-agent.ts:881-894)
6. lease `owns` checks inside prompt, steer, followUp and append (pi-agent.ts:1253, 1071, 1085, 935, 980)
7. the registry's Prompting phase (chat-registry.ts:713-735)
8. Pi's own "Agent is already processing" throw (agent-session.js:1483-1485)

The gateway semaphore exists only because the transcript-reset event is published *outside* the handle (sessions.ts:147-149 comment). Meanwhile `ChatEvent` already has a `session-state` kind (agent.ts:59) that the handle never emits.

**Mistake 4: two package locks for one runtime.** `openSpecialistChat` and `runSpecialist` wrap the call in `withProfileRuntimeLock` (pi-agent.ts:1319, :1480). `createProfileRuntime` takes `leaseProfileRuntime` again (:422), and `specialistRuntime` takes it a third time (specialist.ts:277). That is up to three SQLite reader connections for one specialist open. `extensions update` already refuses while a resident owner runs (extension-update.ts:113-126).

**Mistake 5: forwarding layers and optionality kept for fakes.**
- `ZiggyAgentLive` (agent.ts:177-204) and runtime.ts are pure forwarding.
- application/agent.ts imports `adapters/pi` (agent.ts:2-3), which inverts the architecture rule.
- `currentSession` and `appendAutomationResult` are optional (agent.ts:101-104), yet both production handles always provide them. Consumers pay with `=== undefined` branches at sessions.ts:236, :284, :434, groups.ts:279 and chat-registry.ts:860, :883.
- `makeChatHandle` lives in `src` but has no production caller; it has roughly 140 test call sites.

**Legitimate responses to real problems:**
- The lease answered "concurrent writers silently fork a session" (LOG.md:1068).
- The update journal check answers crash recovery after an update.
- Quarantine answers broken optional packages (LOG.md:1110).
- Pre-reserving on switch is needed because of Pi's teardown-first order.
- The rebind hook is needed because Pi replaces `session` objects.

**A bug the area hides.** ACP `session/set_model` stores `session.modelOverride` (acp.ts:346), but nothing ever reads it: the chat was already opened without it at acp.ts:251-256, and `handle.setModel` is never called. Model switching from ACP does nothing.

### 4. Reach today

**Task A: add one ChatHandle control** (for example `compact`). Edits needed:
- agent.ts `ChatHandle` and the `makeChatHandle` default (2 sites)
- pi-agent.ts `makeLiveChatControls`: its return `Pick` and the implementation (2)
- `makeSessionChatHandle`: its `methods` `Pick` and the fallback (2)
- the `withIdleControl` or binding choice (1)

That is **7 sites in 2 source files** before any face code. Every test fake built with `makeChatHandle` inherits the default.

**Task B: change the single-writer policy** (for example a new replacement path, or refusing while the resident runs). Edits needed:
- session-lease.ts
- pi-agent.ts, 14 sites: `prepareLeasedSession`, askOnce :271-325, openChat :1166-1201, :1253, openSpecialistChat :1371-1408, :1443, runSpecialist :1508, `requireWriter` :725, steer :1071, followUp :1085, append :935, :980, and the `sessionLeaseError` mapping
- chat-runtime-binding.ts (4)
- specialist.ts (2)
- automation-result.ts:84
- application/sessions.ts:48
- ui-gateway picker "held"

That is **7 files and about 24 sites**. The tests session-runtime-transition, session-lease, automation-result:101/297 and pi-agent:194-341 all break.

**Task C: add an open option** (for example a per-session tool allowlist). The positional signature is repeated in:
- agent.ts `ZiggyAgentApi` and `ZiggyAgentLive` (2)
- runtime.ts `SessionRuntime.open` and `makePiSessionRuntime` (2)
- pi-agent.ts `PiAgentApi`, `openChat` and `makePiAgent` (3)
- `ProfileRuntimeOptions` (1)

That is **8 signature sites in 3 files**, plus any caller that passes positionals through `"continue", undefined, name` (ui-gateway/sessions.ts:372-380).

**Contracts that leak outward:**
- `ChatHandle`, `ChatEvent` and `ChatPromptOptions` are imported by 10 source files and 15 test files (scratchpad/chathandle.txt).
- `ChatSessionMode` is exported from the adapter and imported by the application layer.
- `SessionLeaseHeld`/`SessionLeaseFailed` reach application/sessions.ts:8.
- `makeLiveChatControls`, `makeSessionChatHandle`, `bindChatRuntime` and `makeSessionLeaseTransitions` are imported by tests (session-runtime-transition.test.ts:15-18).

**Member usage by face** (evidence from rg):

| Member | Users |
|---|---|
| `prompt` | all six: acp:387, gateway:289, slack/turn:409, discord/turn:267, automations:459, registry:738 |
| `abort` | five: acp:464, gateway:327, slack:576, discord:306, registry:787 |
| `dispose` | all |
| `isIdle` | three: gateway:324, slack:420, registry:246 |
| `steer` | Slack (:426) and registry (:772) |
| `followUp`, `subscribe`, `appendAutomationResult` | **registry only** |
| `modelState`, `setModel`, `setThinkingLevel`, `resume` | **web UI only** (ui-gateway/sessions.ts:499, :554-557); ACP should use `setModel` but does not |
| `currentSession` | web only (registry, sessions.ts, groups.ts) |
| prompt option `images` | Slack and Discord |
| prompt option `ephemeralContext` | Slack and UI groups |
| prompt option `onProgress` | ACP, Telegram, Slack, Discord |

The members every face needs are `prompt`, `abort`, `isIdle` and `dispose`.

### 5. What Pi already provides

| Pi (node_modules/@earendil-works/pi-coding-agent/dist) | Ziggy today | Verdict |
|---|---|---|
| `AgentSessionRuntime.switchSession/newSession/fork` (core/agent-session-runtime.js:128-250) | Wrapped with lease transitions (binding :59-149) | Needless wrapper except switch pre-check. |
| `setRebindSession`, `setBeforeSessionInvalidate` (:64-77) | binding :46-48, :188 | Needed hook, about 15 lines. |
| `teardownCurrent` aborts the active turn (:103-106) and has no guard against a concurrent prompt | binding `switching` plus semaphore | **Genuine** need for one Ziggy gate. |
| `session.prompt` throws while streaming (agent-session.js:1483-1485); `steer`/`followUp` queue | registry Prompting phase, `whileNotSwitching`, `requireIdle` | Pi already guards prompt. Ziggy needs only the switch gate. |
| `runPrintMode` (modes/print-mode.js:15-140): text/JSON output, JSON header, backpressure, SIGTERM/SIGHUP dispose, print-mode extension binding | `askOnce` monkeypatches `console.error` (pi-agent.ts:355-368) and `newSession/fork/switchSession` (:317-325) | Keep print mode. Both patches are lease or error-capture artefacts. |
| `sendCustomMessage(..., {triggerTurn:false})`, `SessionManager.appendCustomMessageEntry` | Live append at pi-agent.ts:933-1066: pre-check, append, reconcile, post-verify, poison | Receipt dedupe is genuine policy; post-verify and poison are needless. |
| No session file locking in SessionManager (only O_EXCL on create, session-manager.js:800, :1406) | SQLite lease | Pi deliberately has no writer lock. Whether Ziggy needs one is decision 9.1. |
| `ModelRuntime`, `SettingsManager`, `modelFallbackMessage` | `selectSessionModel` passes the model explicitly | Genuine Profile policy (spec :29). |
| `bindExtensions({mode, commandContextActions})` | binding :100-185 | The host must supply this; about 25 lines of delegation. |

### 6. Target shape

**One owner.** `src/adapters/pi/pi-agent.ts` implements `ZiggyAgent` directly. It provides the Layer, and composition.ts wires it. application/agent.ts becomes a pure contract with no adapter import. Proposed split by owner:

- `profile-runtime.ts` (about 280 lines): the current `createProfileRuntime` plus the journal check moved out of profile-runtime-lease.ts:45-64.
- `chat-handle.ts` (about 300 lines): the only handle implementation. One semaphore, the `switching` gate, rebind, events, controls, and automation append. It absorbs `makeLiveChatControls`, `makeSessionChatHandle` and chat-runtime-binding.
- `pi-agent.ts` (about 250 lines): `open`, `runOnce` and `runSpecialist`.

```ts
// application/agent.ts (contract only)
export interface OpenSession {
  readonly target: ProfileTarget; readonly context: ChatContext;
  readonly directory: string; readonly mode: "continue" | "fresh";
  readonly agent?: string; readonly model?: ChatModelOverride; readonly name?: string;
}
export interface ChatHandle {                       // name kept; faces compile
  readonly isIdle: boolean;
  readonly prompt: (text: string, o?: ChatPromptOptions) => Effect<string, ZiggyAgentError>;
  readonly steer / followUp / abort / dispose;       // unchanged signatures
  readonly subscribe: (l: (e: ChatEvent) => void) => () => void; // emits session-state itself
  readonly currentSession: Effect<SessionReference | undefined, ZiggyAgentError>;   // required
  readonly appendAutomationResult: (r) => Effect<boolean, AutomationConversationDeliveryFailed>; // required
  readonly modelState; setModel; setThinkingLevel; resume;  // unchanged
}
export interface ZiggyAgentApi {
  readonly open: (r: OpenSession) => Effect<ChatHandle, ZiggyAgentError | ProfileSpecialistError>;
  readonly runOnce; readonly runSpecialist;          // unchanged
  /** shims, 3 lines each, deleted when faces migrate */
  readonly openChat; readonly openSpecialistChat;
}
```

**What it stops doing:**
- No per-session lease, transitions or `.owner` file.
- No package reader lease.
- No `runtime.ts` alias layer.
- No gateway `WeakMap` semaphore: `resume` emits `{kind:"session-state",scope:"transcript"}` inside its own permit and the registry reacts to it.
- No print-mode monkeypatches. `runOnce` returns Pi's exit code; Pi already wrote the error to stderr.
- No poison flag and no post-verify on append.
- No optional members on `ChatHandle`.

**Single-writer rule that replaces the lease:** one function, `refuseIfResidentOwns(target)`, which calls `inspectGatewayOwner` (gateway-owner.ts:130). It is called by:
- `runOnce` when `-c` or `--session` is used
- `open` when used outside the resident process
- `appendStoredAutomationResult`

Inside the resident, `resume` refuses when another live registry entry's `currentSession` has the target id. That check reuses the existing scan at chat-registry.ts:860-866.

**Reach afterward:**
- Task A: `ChatHandle` + chat-handle.ts + the test fake = **3 sites in 3 files**.
- Task B: `refuseIfResidentOwns` + the registry resume check = **2 sites**.
- Task C: an `OpenSession` field + the profile-runtime option = **2 sites**; callers are untouched.

**Effort:** L (1–2 days) for the rebuild, with faces held stable by the shims.

### 7. Keep / rebuild / delete

| File | Disposition | Reason |
|---|---|---|
| pi-agent.ts | **Rebuild** into the three owners above | The policy is essential; four entrypoints repeat the lease and construction ceremony. |
| application/agent.ts | **Rebuild** as contract only | Drop the adapter import and `ZiggyAgentLive`; move `makeChatHandle` to test/support. |
| domain/agent.ts | Keep | `SessionHeld` now means "the resident owns this session" or "live in another entry". |
| runtime.ts | **Delete** | Aliases only; one consumer. |
| chat-runtime-binding.ts | **Delete** (fold about 40 lines into chat-handle) | Rebind and command delegation survive; the lease plumbing goes. |
| session-lease.ts | **Delete** (see 9.1 for the 80-line alternative) | Nothing needs it once resident refusal and the registry check exist. |
| profile-runtime-lease.ts, bun/profile-runtime-lock.ts | **Delete** | Update already refuses a running owner, and `lock.withLock` serializes updates. The journal check moves into profile-runtime. |
| prompt-turn.ts | Keep | Small, two users, clear job. |
| chat-event-projector.ts | Keep | Pure, bounded, owns `ChatEvent` shaping. |
| provider-failure.ts | Keep | One mapping point. |
| automation-result.ts | Keep, then shrink | Receipt schema and stored append stay; the lease is replaced by the owner check. |
| session-name.ts | Keep | Pass the semantic name into the inline extension so the prompt-path calls at pi-agent.ts:1276 and :1445 go away. |
| session-lineage.ts, standalone-runtime.ts | Keep | Correct and unrelated to the lease question. |

### 8. Tests

**KEEP** (real invariants; point them at the new owner):
- pi-agent.test.ts:625: ephemeral context is sent for one turn and never persisted.
- :709: the Profile model beats the historical model.
- :1287: Pi creates JSONL lazily.
- :1391: child header and isolated transcript.
- :1489: local main is isolated and a plain run is fresh.
- :1548: specialist rail directory.
- :1456: mention admission across faces.
- :148: `currentSession` follows switches.
- :84: a name is never overwritten.
- :450, :494, :828: abort, steer while idle, interruption removes the listener.
- :1015, :1210: dispose once on activation failure; tool admission.
- automation-result.test.ts:53 (durable, idempotent receipt), :134 (deleted destination), :161 (idle append does not prompt; busy does not steer).
- standalone-runtime.test.ts:11-28.

**DELETE:**
- session-lease.test.ts:25-121 (the machinery goes).
- session-runtime-transition.test.ts:26 (352 lines of reserve, transition and poison).
- profile-runtime-lock.test.ts:27-203.
- pi-agent.test.ts:194, :239, :283, :341 (lease refusal, release and interrupt). :194 is replaced by the resident-refusal proof below.
- automation-result.test.ts:101 (rewrite as owner refusal) and :297 (poison).
- pi-agent.test.ts:1098 goes if the rollback-failure path leaves with the extension lane.

**End-to-end proofs** (real Pi with a scripted provider as in pi-agent.test.ts:628, tmp Profiles, real CLI subprocesses):
1. Real CLI `run` in text mode prints the answer and exits 0. `run --json` emits Pi's header and events. A provider error exits 1 with **one** stderr line; this proves the `console.error` patch is gone.
2. Real `ziggy serve` on a tmp Profile with web local main open over the UI socket:
   - `run -c` and `run --session <id>` refuse and name the pid.
   - Plain `run` succeeds concurrently.
   - `acp --agent` (fresh) succeeds.
3. Resume:
   - A web entry resuming a transcript that another live entry holds is refused.
   - A valid resume delivers `session-state` before any later prompt event.
   - A prompt during a resume fails with `SessionBusy`.
4. `wake` with no resident delivers to a `conversation:` target twice and leaves exactly one receipt. With the resident up, the existing handoff still applies.
5. `extensions update` refuses while the resident is live, and `--restart` works (owned by the extension lane).

### 9. Decisions for the owner

**9.1 Per-session writer lease (question a).** Every multi-writer scenario:

| Scenario | Evidence | After the change |
|---|---|---|
| Resident plus `run -c` | Both continue `sessions/local/main` (pi-agent.ts:276; ui-gateway/sessions.ts:376) | Resident refusal covers it. |
| Resident plus `run --session <id>` | Any transcript, including Slack threads | Resident refusal covers it (the Fable review misses this case). |
| Resident web specialist rail plus `acp --agent` | Both continue `sessions/local/agents/<id>` (pi-agent.ts:1374) | See 9.2. |
| Web resume onto a transcript live in another entry (same process) | — | Registry check covers it. |
| Resident plus `wake` | `wake` hands off to the resident (LOG "Headless resident lanes") | No writer conflict; only a tiny window when the resident starts mid-wake, closed by re-checking the owner right before the stored append. |
| `wake` without resident plus a concurrent `run -c` on the same conversation; two concurrent `run -c` | — | **Uncovered.** |

The uncovered cases are rare, short-lived, and non-destructive: Pi JSONL is a tree, so two writers produce a branch, not corruption. Fresh sessions (automations, ACP, specialists, children, `newSession`/`fork`) can never contend.

Dropping the lease does **not** reverse the 2026-09-28 decision to make the resident optional. With no resident, run, wake and ACP all work unchanged. The owner check only fires when a resident exists, and wake already hands off in that case.

**Recommendation:** delete the lease. If the owner wants CLI-vs-CLI safety, the alternative is an 80-line `session-lock.ts`: acquire and isHeld only, no `.owner` file, no transitions, taken only at `open(continue|explicit)` and before `switchSession`.

**9.2 ACP `--agent` rail.** Continuing `local/agents/<id>` collides with the web rail whenever the resident runs, and ACP usually runs alongside the resident. Non-specialist ACP already uses a fresh `sessions/acp/<uuid>` (acp.ts:253-255). **Recommendation:** make specialist ACP fresh too. The other option is to refuse `--agent` while a resident is live, which would break the Buzz workflow.

**9.3 Package runtime lease (question b).** Update already refuses when an owner is running (extension-update.ts:119-126). The leftover exposure is a long-lived **ACP** process, not `run`: Pi has already loaded extension code, but skills read files lazily and could see a mix of versions. **Recommendation:** delete both lease files and document "close ACP sessions before `extensions update`". If a fence is still wanted, take one process-level reader lock once in composition, in 1 place instead of 4.

**9.4 `runPrintMode` (question c).** Keep it. The spec says so (:13, :44). It gives `--json`, backpressure and signal disposal for free (print-mode.js:15-101). Both monkeypatches go away once leases are deleted and Pi's exit code is returned as-is.

**9.5 Serialization (question d).** Today there are 8 layers (section 3). Keep only these:
- one per-handle semaphore plus the `switching` gate, needed because Pi's teardown aborts a live turn with no guard;
- Pi's own prompt throw;
- the registry `statePermit` for registry state (registry lane).

Delete `requireWriter`, the `owns` checks and the gateway `WeakMap`.

**9.6 Handle contract (question e).**
- Only the registry (web) uses `followUp`, `subscribe` and `appendAutomationResult`.
- Only the web uses `resume`, `modelState`, `setModel`, `setThinkingLevel` and `currentSession`.

**Recommendation:** keep a single `ChatHandle` and make every member required; do not split it into per-face interfaces. The per-face split would cost more reach than it saves because there is only one implementation. Fix ACP `set_model` so it calls `handle.setModel`.

### 10. Where I disagree with the Fable review or the audit

**Fable:**
- It limits the owner check to "`sessions/local/**`" (fable :40), which misses `run --session`, the ACP specialist rail, and in-process web resume onto a transcript live in another entry. It also calls LOG:1068 "the real incident"; that line is the plan entry, not an incident.
- "Pi already serialises with its own queue… One is enough (Pi's)" (:43, :53) is wrong. Pi throws on a concurrent prompt (agent-session.js:1483) and `switchSession` aborts a live turn (agent-session-runtime.js:103-106) with no guard. One Ziggy gate is required. It also undercounts the layers: 8, not 4.
- Dropping `runPrintMode` (:187): "`--json` needs 20 lines" understates the header, event shape, backpressure and signal handling. The patches Fable objects to disappear with the lease anyway.
- "17 runPromise bridges exist only for leases" (:22): 10 are lease-only. `chat-runtime-binding.ts:41` is control serialization, and the tool callbacks are legitimate.
- It treats `ziggy run` as the residual risk for package leases (:41); the real long-lived case is ACP.
- I agree with Fable on: deleting runtime.ts, the ZiggyAgentLive forwarding and the gateway semaphore; keeping `ChatHandle` as the single name; and shrinking append.

**Audit:**
- A01 (keep the writer lease until process exit after an uncertain shutdown) adds machinery to a mechanism that should not exist. Deleting the lease makes the defect disappear.
- audit.md:292 wants runtime.ts kept as an "authored capability contract"; it has no independent consumer.
- audit.md:291 and :293 preserve "replacement reservations" for all replacements; only `switchSession` targets an existing id.
- audit.md:226 is correct that the two leases protect different resources, but neither needs to exist in its current form.
- The audit does not notice the ACP `set_model` no-op (acp.ts:346).