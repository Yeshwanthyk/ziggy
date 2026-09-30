## Verdict on `docs/plans/tight-core/README.md`

### A. Where the area reviewers overruled me

- **D1 writer lease → concede (c).** I missed that LOG:1065-1069 made resident-free `wake`/`run` a supported concurrent-writer configuration, and that `appendStoredAutomationResult` already takes the lease (`automation-result.ts:84`). Two corrections to (c): (1) SQLite acquire is synchronous (`session-lease.ts:86-95`), so design `withFileLock` with a sync `acquire()/release()` pair; otherwise the `switchSession` callback in the binding still needs an `Effect.runPromise` bridge and the "deletes ~10 bridges" claim fails. (2) Dropping `.owner` conflicts with P5 "refuse naming the pid": the pid can only come from `inspectGatewayOwner` (`gateway-owner.ts:130`) in the resident case; CLI-vs-CLI refusals become anonymous. Say so in P5.
- **Serialization → concede.** Verified: `agent-session.js:1483-1485` throws on a concurrent prompt; `agent-session-runtime.js:103-110` `teardownCurrent` calls `session.abort()` with no guard. One Ziggy switch gate is required. "3 layers" is right provided the registry permit is never held across handle I/O.
- **runPrintMode → concede D14, but fix the rationale.** "The patches go with the lease" is half true. `pi-agent.ts:317-325` (reject `newSession/fork/switchSession`) is lease-driven. `pi-agent.ts:355-368` (`console.error` capture) exists because print-mode.js:79,116,131 writes errors to stderr and only returns an exit code. Dropping it means `runOnce` returns an exit code, not a typed provider error. Acceptable since `askOnce` has one caller (`agent.ts:190`, CLI), but state it.
- **`profile_extensions` in-process → concede.** LOG:365 and :407 document the launchd PATH defect. Shelling out was wrong.
- **`SessionManager.open` writes → concede.** Verified: constructor `mkdirSync` (session-manager.js:649), repair `appendFileSync` (:367), migration rewrite (:722). `parseSessionEntries` is exported (:91).
- **Skip+warn → concede** (owner decision, LOG:1079). One caveat the plan omits: the rebuild-once path executes every other package's factories twice (LOG:132's leftover survives on the failure path). P14's "1 execution per factory" holds only on the healthy path; write that into P11.

### B. On track? What stays wide-reach

- Yes. The six patterns in §3 are correct and the target owners are the right ones.
- Still hubs after target state, and the plan should name them as accepted:
  - `profile-runtime.ts` (the Pi build: resources, customTools at `pi-agent.ts:544-560`, quarantine rebuild) is where every tool/extension/prompt change lands. Fine as one function in one file; do not let it re-split.
  - `automations.ts` (577 lines) gains delivery routing in slice 4. It already owns definitions and scheduler links. Watch it; delivery routing should be one ~30-line function.
  - The channel session-kind literal stays in three places (`chat-registry.ts:23`, `core-results.ts:114`, ui-sdk `conversations.ts:56`); the §2 "3 files" target for a new channel is the literal, not plumbing. Accepted, but say so.
  - `ChatContext` kind union reaches `gateway.ts`, `agent.ts` and the memory scope table; the scope table fixes memory scopes, not contexts.
  - `session-discovery.ts` is "revisit after slice 2", but with D1(c) the lock is permanent, so it stays permanently. Mark it Keep.
- Optional-but-do: collapse the six `Specialist*` errors (`domain/agent.ts`, fan-in 23) to one; it is listed as optional in area 4 §7.

### C. Slice order and size

- **Slice 0 is not L.** Today there is no `test/e2e` or `test/harness`; the SSE fixture (`pi-agent.test.ts:628-650`) has no tool-call encoder; the resident test uses a raw `WebSocket` (`resident-gateway.test.ts:111`), not ui-sdk. P11-P13 need tmp packages and the update flow, P17 needs two subprocesses × 20 adds, P18 needs an automation fixture. Nineteen proofs is XL (3-5 d) and blocks everything. Split: slice 0 = harness + P1-P7, P9, P14, P15(todo), P17; each later slice lands its remaining proofs first, then rebuilds.
- **Budget is unmeasured.** ~30 CLI spawns plus resident boots plus `extensions update` in ≤10 s is optimistic. Make the budget a measurement after slice 0, not a gate.
- **Merge slice 2's session half into slice 3.** Adopting `withFileLock` inside the 1590-line `pi-agent.ts` (54 lease refs) and then rebuilding it means editing the lease twice. Slice 2 = helper adopted by memory, `gateway-owner`, extension lock; slice 3 replaces `session-lease` with it at the three points.
- Slices 4/5 can run parallel with 6 after 3. Slice 6 depends on 3's `profile-runtime.ts`.
- **Missing from slice 6:** `doctor-checks.ts` (402 lines) consumes preflight, `inspectPiPackageHealth` and `classifyBundledCopy`; area 3 lists it, the slice bullets do not.
- **Missing everywhere:** operator docs and skill text (`docs/operations/memory.md:47` backups; `extension-updates`, `sessions`, `extension-authoring` skills describe the lease and `--restart`, LOG:1147). D5/D8 change documented behaviour; add "update docs/skills" to slices 5 and 6.

### D. Decisions

- D1(c), D2-D4, D7-D14: agree, with the notes above. Extra argument for D4: LOG:365's missing "Model override section" happened because `ensureInstalled` skips an existing copy; embedded-only removes that class.
- **D5 is incomplete.** LOG:1147 shipped `extensions update --restart` (stop managed resident, apply, start). P13 says "refused with live resident", which silently drops it. Add **D5b: keep `--restart` (stop/apply/start, no journal) or delete it.**
- **Missing D15:** is conversation delivery (`appendAutomationResult` + receipts + P9) a used feature? It drives two append primitives, the receipt schema and one of D1's three lock points. If unused, ~200 lines and one lock point go.
- D3: record the double-factory-execution cost on the failure path so nobody re-adds quarantine machinery to fix it.

### E. §9 bugs and §2 reach, spot-checked

- ACP `set_model`: confirmed. `acp.ts:346` stores `modelOverride`; no `setModel` call in the file.
- `toolCall` branch: confirmed at `session-history.ts:165`.
- A05: confirmed, `specialist.ts:898` `textResult(result.answer, { result }, …)`.
- A04: confirmed. `chat-registry.ts:600-601` disposes on the stale-token branch, but the `Effect.catch` at :616-627 for a failed `makeLiveEntry` never disposes `handle`.
- `profile_extensions` bug: evidence chain holds. Block lists at `profile-agents.ts:25` and `specialist.ts:542` omit it; the tool is created only for the parent (`pi-agent.ts:547-551`); the child is built with `tools`/`noTools:"all"` and no `customTools` (`specialist.ts:324-340`); Pi's allowlist adds only names present in the registry (`agent-session.js:2799-2806`). Still "found by reading"; P15 proves it.
- Lock across preflight: confirmed, `profile-extensions.ts:1164-1176`.
- §2 "7 sites / 2 files" for a ChatHandle control: it is 7 sites in **3** files (`agent.ts:92,132`, `runtime.ts:11`, `pi-agent.ts:715,788,824,915`). Understated.
- "9 `registry === undefined` branches": I count 10, plus a fourth optional `registry?` at `automations.ts:64` not mentioned.
- `makeChatHandle` "~140 test uses": 141, 0 in src. "Four `BEGIN IMMEDIATE` copies": 4 files, 6 occurrences (`session-lease.ts` has 3). "Four dead registry members": confirmed 0 src callers.
- §8 timing: 722 pass in 18.21 s today; area 5's number stands, mine was wrong.

**Effort:** slice 0 XL as written, L if split as above; overall plan XL.