## Area: the resident process and the live-session registry (the seam between core and faces)

### 1. Files

Fan-in counts direct `from "…"` imports in `src/` and `test/`. `sessions` is approximate because the basename is shared with `application/sessions.ts`.

| file | lines | src/test fan-in | role |
|---|---|---|---|
| src/application/chat-registry.ts | 914 | 14 / 8 | Per-Profile live-session table. Also holds UI prompt verbs, replay ring, automation delivery fence and channel destination book |
| src/application/profile-runtime-directory.ts | 78 | 3 / 0 | Wraps ProfileDirectory with a static `ProfileId → {target, registry}` map |
| src/application/resident-gateway.ts | 377 | 3 / 2 | Resident composition: owner lease, one registry, scheduler, UI and channel branches. Builds extra registries for other Profiles in shared-UI mode |
| src/application/gateway.ts (Telegram) | 397 | ~4 / 2 | Channel loop. Keeps its own `chats` map and also aliases each handle into the registry |
| src/adapters/bun/gateway-owner.ts | 295 | 4 / 4 | Profile-level single-resident SQLite lease. Holds no session state |
| src/adapters/bun/resident-service*.ts | 498+582 | ~1 / 3 | launchd/systemd operations. They do not own sessions (grep finds no registry or handle use), so they are out of scope |
| src/application/ui-gateway/sessions.ts | 788 | 1 / 0 | Web session protocol. Heaviest registry consumer, plus its own per-handle lock |
| src/application/slack/{runtime,turn}.ts | 735 / 605 | 1 / 0 | Slack loop. Own `ChatState{handle, semaphore}`, plus openAlias/closeAlias/rememberDestination |
| src/application/discord/{runtime,turn}.ts | 726 / 388 | 1 / 0 | Same pattern as Slack |
| src/application/automations.ts | 577 | 5 / 4 | Chooses registry delivery or stored delivery for `conversation:` targets (`:227-229`) |

### 2. What this area is for

In spec terms (scout:9, :82, and the invariant line after :86): "the resident gateway is the only interactive session owner", "gateway exclusively owns live sessions", and "client disconnect is not cancellation". For this Profile's resident process, the owner needs these guarantees:

1. **Shared open.** Two tabs, or a tab and a retry, opening the same key get one `ChatHandle`, so one Pi session and one writer lease. A failed open leaves nothing behind and can be retried.
2. **Session-lifetime work.** An admitted prompt runs in a scope tied to the session, not to the WebSocket. Disconnect does not interrupt it. Explicit close or resident shutdown does.
3. **Reconnect replay.** A bounded, sequenced event ring per live key, with `replay_gap` when the cursor has fallen out of the window. It resets when the transcript identity changes. Durable history stays in Pi JSONL.
4. **Capacity.** A cap on web-opened sessions (`MAX_UI_SESSIONS=32`, counting sessions that are still opening).
5. **Observation.** The web UI can list and watch channel sessions read-only.
6. **Dispose exactly once** at close or at resident scope exit.
7. **Lookup by stored session id**, so an automation result lands in the live handle when that transcript is open, and in the stored JSONL (under the writer lease) otherwise.

Incidental, and not a registry job:

- UI verbs: submit, steer, followUp, abort, closeUi, and the `watch_only` checks.
- The observed channel-address book (`destinations`/`rememberDestination`).
- Resolving the automation delivery policy.
- `resetTranscript`/`publish` for events the handle should emit itself.
- The Opening/Closing fence, which the writer lease now duplicates.
- Speaking `UiGatewayError` to Telegram.

### 3. How it got this shape, and the mistakes

**Pattern 1: feature accretion onto whatever object was in reach.**
- ef1b35f4 (2026-08-15) created a 386-line UI registry.
- 8a350b2d (09-17, "Deliver automation results to conversations") added 270 lines: `openAlias`/`closeAlias`, the `Closing` state, the global fence in `deliverAutomationResult` (`chat-registry.ts:838-909`), and an application-to-adapter import (`:16-19` pulls in `adapters/pi/automation-result`).
- 7d9cd7fc (+28) put the channel destination catalog in the same object (`:513-531`), although it has nothing to do with sessions.
- d33e8646 (+11) added `resetTranscript`.

The registry became "whatever the resident knows".

**Pattern 2: fence first, primitive later, fence never removed.** The 09-17 in-memory fence refuses delivery while any entry is Opening or Closing (`:849-855`). It holds `statePermit` across disk and Pi I/O (`currentSession` for every entry, a stored append, `sendCustomMessage`), so every `get`, `list` and `openAlias` waits behind a transcript write. On 09-28 the per-session SQLite writer lease landed (9828ac5e, a4946ad2, 73bf909b). It is authoritative in-process too: `BEGIN IMMEDIATE` on a new connection with `busy_timeout 40` (`session-lease.ts:95-99`). The stored append already takes it (`automation-result.ts:84`) and the live append already checks it (`pi-agent.ts:936`). The fence was legitimate on 09-17 and is redundant now.

**Pattern 3: patching an upstream event gap downstream with locks.** The transcript reset is published by the face after the handle switches, which needed a per-handle `WeakMap` semaphore (`ui-gateway/sessions.ts:150-163`). It then took four commits to get the ordering right: d33e8646, then 5be78e81, then 5b573971, then 6d5d5c12 ("Order prompt submission after pending transcript reset"). It still misses Pi-command switches. `chat-runtime-binding.ts` fires rebind listeners on `newSession`/`fork` via `setRebindSession` (lines 99-129 of that file), but `session-state` is only emitted from `chat-registry.ts:707` on the resume path. So `/new` or `/fork` typed in a web session probably leaves an old-transcript replay ring and sends no reset to watchers. I found this by reading the code and have not reproduced it.

**Pattern 4: test seams baked into production signatures.**
- `registry?: ChatRegistryApi` is optional in all three channel `runLoop`s (`gateway.ts:48`, `slack/model.ts:106`, `discord/model.ts:91`). Production always passes it (`resident-gateway.ts:288,300,318`), and 9 `registry === undefined` branches exist only for tests.
- `registerAlias`, `unregisterAlias`, `subscribe` and `replay` have **zero src callers**; only tests use them.
- `markAvailable`/`markUnavailable` (`profile-runtime-directory.ts:75-76`) have zero callers anywhere.

**Pattern 5: protocol vocabulary leaking inward.** Registry failures are `UiGatewayError` with web codes (`watch_only`, `replay_gap`, `capacity_exceeded`), so Telegram catches `UiGatewayError` (`gateway.ts:312`). The session kind literal is repeated in `chat-registry.ts:23`, `domain/ui-gateway/core-results.ts:114` and `packages/ui-sdk/src/protocol/conversations.ts:56`.

**What was legitimate:**
- Shared open with Deferred dedupe (tabs genuinely race).
- The replay ring and rollover recovery (f6f6c047).
- FiberMap-scoped prompt work, which implements disconnect ≠ cancel (`:763`).
- The UI command scope (LOG "UI command cache lifecycle").
- The writer lease.
- The per-chat semaphores in the channels. Those are turn-ordering policy, not duplicate locks (LOG "Chat gateway cleanup" explains why Slack and Discord schedulers differ).

### 4. Reach today

**Minimal registry API in use** (20 members; 16 used in src):

| member | call sites |
|---|---|
| `openAlias` ×3 | `gateway.ts:251`, `slack/turn.ts:328`, `discord/turn.ts:193` |
| `closeAlias` ×3 | `gateway.ts:189`, `slack/runtime.ts:77`, `discord/runtime.ts:90` |
| `rememberDestination` ×6 | `gateway.ts:234`, `slack/runtime.ts:220,237,398`, `discord/turn.ts:177` |
| `destinations` ×1 | `ui-gateway/groups.ts:200` |
| `get` ×7 | `sessions.ts:231,280,429,481,547,657`, `groups.ts:271` |
| `list` | `sessions.ts:205` |
| `getOrOpenUi` | `sessions.ts:387` |
| `subscribeSequenced` | `sessions.ts:188` |
| `publish` ×2 | `sessions.ts:563,732` |
| `resetTranscript` | `sessions.ts:502` |
| `submit` ×2 | `sessions.ts:753,758` |
| `steer` | `sessions.ts:762` |
| `followUp` | `sessions.ts:763` |
| `abort` | `sessions.ts:778` |
| `closeUi` | `sessions.ts:638` |
| `deliverAutomationResult` | `automations.ts:229` (registry threaded via `automation-scheduler.ts:259,281` and `management-automations.ts:252`) |
| **unused in src** | `registerAlias`, `unregisterAlias`, `subscribe`, `replay` |

**Duplicated responsibility (question b):**
- **Idle/busy** is tracked four ways:
  - Pi `isIdle`.
  - The handle's `requireIdle` and `SessionBusy` (`pi-agent.ts:735`), plus its append idle check (`:996`).
  - The registry `phase` (`:41-43,722`) and a second append idle check (`:891`).
  - Slack's `!handle.isIdle` steer path (`slack/runtime.ts:420`).
- **Listener fan-out** happens twice: the handle's `listeners` Set (`pi-agent.ts:833-848`), then the registry's `listeners` and `sequencedListeners` Sets (`:51-53`).
- **Locks:** the global registry `statePermit`, the UI `WeakMap` per-handle semaphore, and the binding's `withControl`/`withSessionSwitch`.
- **Handle maps:** each channel keeps `chats: Map<chatKey, {handle}>` and the registry keeps the same handle under `slack/<chatKey>`.
- **Boilerplate:** `disposeChats` exists three times, nearly identical (`gateway.ts:178`, `slack/runtime.ts:66`, `discord/runtime.ts:79`), and the open-or-reuse block exists four times.
- **"Not streaming":** the registry pre-checks `phase` (`:769`) and the handle returns `ChatNotStreaming`.

**Task A: add a channel (e.g. WhatsApp) that is watchable in the web UI and a delivery destination.** You must edit the kind union in three places (`chat-registry.ts:23`, `core-results.ts:114`, ui-sdk `conversations.ts:56`) and `resident-gateway.ts` (config, branch, catchTags). The new runtime has to copy `ChatState`, the semaphore, open-or-reuse, `openAlias`, `closeAlias` inside `disposeChats`, `rememberDestination`, and the `registry?` branches. **About 5 files and ~60 lines of copied session plumbing.**

**Task B: make `/new` and `/fork` reset watchers (the gap above).** Edits land in `pi-agent.ts` (there is no event path out of rebind today), `chat-registry.ts` (`resetTranscript`), and `ui-gateway/sessions.ts` (lock plus reset plus model publish). Then you have to re-reason the lock ordering proven by `ui-gateway.test.ts:2046,2131,2189`. **3 src files and 3 choreography tests.**

**Task C: change the conversation-delivery policy (e.g. busy means append after the turn).** Edits span `chat-registry.ts:838-909`, `pi-agent.ts:933-1000`, `adapters/pi/automation-result.ts:66`, `automations.ts:227`, `automation-scheduler.ts:259/281`, `management-automations.ts:252`, and `domain/automation.ts:209` (categories). **5–7 files, with the policy split between the registry and the handle.**

**Contracts that leak outward:**
- `ChatRegistryApi` (14 src importers).
- `ChatRegistryKind`.
- `ChatRegistryEvent` (`event-projection.ts:9`).
- `ChatRegistryListEntry` (`sessions.ts:26`).
- `AutomationDestination`, a domain concept defined in the registry.
- `UiGatewayError` as the registry's error channel.
- `ResidentProfileBranch`, aliased as `UiGatewayBranch` (`ui-gateway/types.ts:22`).

### 5. What Pi already provides

All paths are under `node_modules/@earendil-works/pi-coding-agent/dist`.

| Pi capability | where | Ziggy today |
|---|---|---|
| `AgentSession.subscribe`, multi-listener | `core/agent-session.d.ts:349` | Needed, but the handle wraps it and the registry wraps it again. The second wrap is only justified for sequencing and replay |
| `isStreaming` / `isIdle` | `:375-377` | Registry `phase` duplicates it, except for the real gap between "submit acknowledged" and "Pi started". That gap can be covered by "a prompt fiber exists for this key" |
| `prompt` with `streamingBehavior`, `steer`, `followUp`, `abort` | `:491`, `:166`, `:512`, `:523`, `:592` | Registry `steer`/`followUp`/`abort` add nothing beyond the `watch_only` and "not streaming" checks. Those are UI policy |
| `sendCustomMessage` | `:551` | Used by `appendAutomationResult`. The receipt and dedupe are genuine Ziggy policy |
| `switchSession` / `newSession` / `fork` with rebind hook | `core/agent-session-runtime.d.ts:73-87` | Ziggy hooks rebind for re-subscription but not for the reset event. That is the gap |
| RPC mode | `modes/rpc/*` | Single session over stdio. No multi-session table, no replay, no shared open, no cross-process lock |
| faux provider | `pi-ai/dist/providers/faux.d.ts:24-75` | Unused. This is the scripted provider for the e2e loop |

Genuine Profile policy that Pi lacks: the multi-key live table, shared open, replay ring, capacity, the writer lease, and the automation receipt.

### 6. Target shape

**Where the line goes (question d).** The registry is **resident-face infrastructure, not core.**
- Only the resident constructs it (`resident-gateway.ts:195,270`). ACP and the CLI open handles directly (`faces/acp.ts:251`).
- Core ends at `ZiggyAgent.openChat → ChatHandle`, plus the writer lease, plus the two append primitives (live `appendAutomationResult`, `appendStoredAutomationResult`).
- Move the registry to `src/application/resident/live-sessions.ts`. Faces (web, Slack, Discord, Telegram) depend on it. Core depends on nothing in it.

**The one owner: `LiveSessions`, about 220 lines.**

```ts
interface LiveSession { key: string; kind: string; handle: ChatHandle; meta: { context?: UiConversationContext; agentId?: string } }
interface LiveSessionsApi {
  // Shared open: waiters share one Deferred; failed open or failed publication disposes once and leaves no entry;
  // `limit` counts this kind including openings.
  acquire: <E>(key: string, kind: string, open: Effect<ChatHandle, E>, o?: { meta?; limit?: number })
    => Effect<ChatHandle, LiveSessionUnknown | LiveSessionCapacity | E>;
  release: (key: string) => Effect<void, ZiggyAgentError>;          // interrupts the key's work, disposes once
  get: (key: string) => Effect<LiveSession, LiveSessionUnknown>;
  list: Effect<ReadonlyArray<LiveSession & { idle: boolean }>>;       // idle = handle.isIdle && no work fiber
  findBySessionId: (id: string) => Effect<LiveSession | undefined, ZiggyAgentError>;
  watch: (key, afterSeq: number | undefined, f: (e: SequencedEvent) => void)
    => Effect<() => void, LiveSessionUnknown | ReplayGap>;          // ring 256; cleared on handle-emitted session-state/transcript
  publish: (key: string, event: ChatEvent) => Effect<void, LiveSessionUnknown>; // face-synthesized events only
  runExclusive: (key: string, work: Effect<void>) => Effect<void, SessionBusy>;  // session-lifetime fiber: disconnect ≠ cancel
}
```

**What it no longer does:**

| responsibility | new home |
|---|---|
| Opening/Closing fence | Deleted. The lease refuses a second writer. A reopen during dispose becomes `SessionHeld`, which `sessions.ts:391` already maps to `session_busy` |
| `phase` | Replaced by `runExclusive`/`FiberMap.has` |
| UI verbs, `watch_only`, the `errorSeen` synthetic error, `MAX_UI_SESSIONS` | `ui-gateway/sessions.ts` calls the handle directly |
| `resetTranscript` and `publish(session-state)` | The handle emits `session-state` from its rebind hook (`pi-agent.ts:842-845`) and from `setModel`/`setThinkingLevel`, and emits `automation-result` after a successful append. The `WeakMap` lock is deleted |
| `destinations` | A 30-line resident-owned `DestinationBook` passed to channels, `groups.ts` and automations |
| `deliverAutomationResult` | `automations.ts`: `live = findBySessionId(id)`, then `live ? handle.appendAutomationResult : appendStoredAutomationResult`. One policy owner; no global permit held across I/O |
| Error channel | Its own tagged errors; `sessions.ts` maps them to `UiGatewayError` |

Other changes in the same step:
- **Delete `profile-runtime-directory.ts`.** The resident builds `Map<ProfileId, {target, live}>` and passes a `route` function. This also collapses the three branch-lookup paths in `ui-gateway.ts:96-125`.
- **Make `registry` required** in the three channel `runLoop`s.

**Reach afterwards:**
- Task A: new runtime file, `resident-gateway.ts`, and the kind literal. **3 files, no copied plumbing:** `acquire`/`release` in a scope finalizer replaces `disposeChats`.
- Task B: `pi-agent.ts` rebind emit, and `live-sessions.ts` clears the ring on that event. **2 files, 0 locks.**
- Task C: `automations.ts` and the `pi-agent.ts` append. **2 files.**

**Keeping faces unchanged while rebuilding (question e).** Ship a transitional `chat-registry.ts` shim exporting the old `ChatRegistryApi` names over `LiveSessions`:
- `openAlias` becomes `acquire`.
- `closeAlias(key, h)` becomes `release(key)` guarded by handle identity.
- `getOrOpenUi` becomes `acquire("ui", {limit: 32})`.
- `submit`, `steer`, `followUp`, `abort` and `closeUi` become the shim's own helpers over `get`/`runExclusive`/`release`.
- `rememberDestination` and `destinations` forward to the `DestinationBook`.

Order of work:
1. Delete dead members and make `registry` required.
2. Extract `DestinationBook`.
3. Move delivery to `automations.ts` and drop the fence.
4. Handle emits `session-state`; delete `resetTranscript` and the `WeakMap` lock.
5. Swap internals to `LiveSessions`, which fixes A04 structurally.
6. Migrate `sessions.ts` and the channels off the shim, then delete it.

Each step is gated by the e2e loop in §8. Effort: **L (1–2 days).**

### 7. Keep / rebuild / delete

| file | verdict | reason |
|---|---|---|
| application/chat-registry.ts | **Rebuild** → resident/live-sessions.ts (~220) plus a temporary shim | Of 914 lines, roughly 40% is fence, UI verbs, destinations and delivery; A04 leak at `:591-627` |
| application/profile-runtime-directory.ts | **Delete** | Static map; mutators have 0 callers; `resolve`/`list` only forward |
| application/resident-gateway.ts | Keep, trim | Composition is right; it builds `LiveSessions`, `DestinationBook` and the branch map |
| application/gateway.ts, slack/*, discord/* | Keep | Drop `registry?` branches and the 3× `disposeChats`; keep per-chat semaphores (turn policy) |
| adapters/bun/gateway-owner.ts | Keep | Real single-resident lease; delete the "legacy fixture hooks" (`:62`) |
| adapters/bun/resident-service*.ts | Keep (out of scope) | No session ownership |
| ui-gateway/sessions.ts | Keep, reshape | Takes on the UI verbs; loses the `WeakMap` lock |
| automations.ts | Keep | Becomes the single owner of conversation-delivery routing |
| adapters/pi/pi-agent.ts (handle) | Modify | Emits `session-state` on rebind and model change, and `automation-result` on append |

### 8. Tests

**KEEP, rewritten against `LiveSessions` where needed:**
- `chat-registry.test.ts:34`: replay continuity and gap.
- `chat-registry.test.ts:91`: shared open, and a failed open can be retried.
- `chat-registry.test.ts:130`: capacity counts openings.
- `chat-registry.test.ts:177`: subscriber disconnect does not abort or dispose an admitted prompt (spec invariant).
- `chat-registry.test.ts:13`: label retention; moves with `DestinationBook`.
- `automation-result.test.ts:53,101,134,297`: full-tree receipt dedupe, lease refusal, missing destination, poison and retry. These use real Pi `SessionManager` on tmp dirs.
- `automation-result.test.ts:161`: keep, and assert the event now comes from the handle.
- `ui-gateway.test.ts:130`: held session gives `session_busy`.
- `ui-gateway.test.ts:474,555`: epoch, gap, rollover.
- `ui-gateway.test.ts:711`: disconnect does not interrupt another connection's run.
- `ui-gateway.test.ts:929`: reopen replaces the subscription.
- `ui-gateway.test.ts:1427`: held resume.

**DELETE:**
- `chat-registry.test.ts:159`: tests the test-only `registerAlias`/`unregisterAlias`.
- `chat-registry.test.ts:243`: tests the Opening/Closing fence, which is removed. `automation-result.test.ts:101` covers the lease invariant.
- `ui-gateway.test.ts:2046,2131,2189`: lock choreography. Replace with one real-handle test: "a reset event precedes events from the next prompt, for resume, `/new` and `/fork`".
- Channel tests that call `runLoop` without a registry (e.g. `gateway.test.ts:158`, `discord-gateway.test.ts:638`) are **not** deleted; they get a real `LiveSessions`.

Note: every test in this area uses `makeChatHandle` fakes (for example `ui-gateway.test.ts` has 33 uses and no real Pi). None exercises a real resident.

**End-to-end proofs the verification loop needs** (real tmp Profile, Pi faux provider, in-process `ResidentGateway.run`, `packages/ui-sdk` client over the real WebSocket):
1. **Disconnect and reconnect.** `session.open local/main`, then `prompt.submit`, then drop the socket mid-stream, reconnect, and `session.watch afterSeq` receives the tail. The turn completes, and the JSONL has exactly one user and one assistant entry.
2. **Shared open.** Two clients open the same key concurrently: one handle, one lease file, one JSONL.
3. **Transcript reset.** Resume, `/new` and `/fork` each send `session-state/transcript` to watchers, and an old cursor gets `replay_gap`. This is the regression test for the gap in §3.
4. **Conversation delivery.** Four cases:
   - Live idle session: appended once, and an `automation-result` event is seen on watch.
   - Live busy session: `session-busy` retriable.
   - Unopened stored session: receipt written.
   - Resident stopped (`wake` in-process): stored append under the lease.
5. **Channel.** A fake transport (a legitimate seam) with real Pi: the session is listed as watch-only in the web UI. On resident shutdown it is disposed once, and `run -c` on that session then succeeds.

### 9. Decisions for the owner

1. **Should the registry leave core and become resident-face infrastructure?**
   - For: only the resident constructs it, and the spec puts live sessions on the gateway (scout:9, :82).
   - Against: nothing substantive.
   - **Recommend yes.**
2. **Should the writer lease replace the Opening/Closing delivery fence?**
   - For: the lease is authoritative in-process and cross-process, and already guards both append paths.
   - Against: a channel open racing a stored append would fail `SessionHeld` after 40 ms instead of waiting behind the global permit.
   - **Recommend dropping the fence.** Give `acquire` a bounded retry on `SessionHeld` (e.g. 3×50 ms) for channel opens only.
3. **Should a shared-UI resident open live sessions for other Profiles?** Today resident A creates Profile B registries in-process (`resident-gateway.ts:190-205`). B's own scheduler and resident cannot see those sessions. The lease keeps this safe, but B's deliveries get `session-held` retries and B's web UI gets `session_busy`.
   - **Recommend keeping it for now and documenting it.** The alternative is making non-default Profiles read-only for live sessions, which is simpler but loses a feature.

### 10. Where I disagree with the Fable review or the audit

- **Fable, "four serialization layers; Pi's alone is enough".** Pi's control lock does not cover the face-published replay reset. The `WeakMap` lock was a real fix: 5b573971 and 6d5d5c12 added tests that fail on the old code. It becomes deletable only by emitting the reset from the handle's rebind. The channel per-chat semaphores are turn policy and should stay.
- **Fable, "drop the cross-process writer lease".** For this area, no. The lease is what lets the registry shrink: it replaces the fence and the Closing state. It also underpins resident-optional `wake` delivery (LOG "Plan: extensions run without the resident" and "Headless resident lanes") and the cross-Profile shared UI. A per-Profile resident PID rule would not cover those cases.
- **Fable, delete `chat-registry.test.ts:91-243` wholesale.** Tests `:91`, `:130` and `:177` guard real invariants (shared open and retry, capacity, disconnect ≠ cancel). Only `:159` and `:243` should go.
- **Fable, "destinations move to automations".** They should leave the registry, but they are written by channels and read by `groups.ts:200`. A small resident-owned `DestinationBook` fits better than making automations depend on channel observation.
- **Audit, "preserve Opening/Live/Closing".** Opening, yes: waiters need it. Closing and the delivery fence, no: the lease provides the same refusal. The audit's fix for A04 ("retain an unavailable ownership marker") adds state. I confirm A04 at `chat-registry.ts:591-627`, where a failed `makeLiveEntry` never disposes the handle, and the stale branch at `:600` also swallows dispose failure. A handoff that disposes exactly once fixes it structurally.
- **Audit A06 (stale branch read).** Moot. The mutators have zero callers; delete the file.
- **Missed by both:**
  - The `/new`/`/fork` replay-reset gap (Pattern 3).
  - `registry?` being optional only for tests.
  - Four API members used only by tests.
  - The global `statePermit` held across transcript I/O during delivery.
  - The application-to-adapter import at `chat-registry.ts:16-19`.
  - `UiGatewayError` leaking into Telegram (`gateway.ts:312`).