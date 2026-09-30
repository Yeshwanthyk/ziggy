## Lane: Profile agents, specialists, and memory

### 1. Files

| File | Lines | src/test fan-in | Role |
|---|---|---|---|
| src/adapters/pi/specialist.ts | 1010 | 1 / 2 | `agent_run`/`agent_discuss` tools, `selectSpecialist` policy, `specialistRuntime` child builder, discussion bounding, usage math, TypeBox result schemas |
| src/adapters/pi/pi-agent.ts (specialist/memory paths) | 1590 (≈260 in area: 523-559, 1314-1571) | 3 / 5 | Wires memory_write and agent tools into the parent. `openSpecialistChat` (rail) and `runSpecialist` (direct) each build a throwaway "selection" runtime |
| src/application/profile-agents.ts | 275 | 3 (composition, main, agents-cli) / 3 | CLI create/list/show/save/validate/run. Contains a **second** policy validator, `runtimePolicyError` :129 |
| src/adapters/fs/profile-agents.ts | 497 | 4 / 1 | `agents/<id>.md` frontmatter parse, discovery, exclusive create, CAS save |
| src/domain/profile.ts (agent part :60-160) | 231 | 55 / 12 | `ProfileAgent` schema, `ProfileAgentThinking`, `@agent-id` mention policy |
| src/domain/agent.ts (Specialist* errors :147-245) | 245 | 23 / 8 | Typed specialist errors, `ProfileAgentRunResult` |
| src/adapters/pi/profile-agent-guidance.ts | 27 | 1 / 0 | `before_agent_start` hook that lists agents |
| src/adapters/pi/session-lineage.ts | 34 | 2 / 1 | Child `SessionManager.create(..., {parentSession})` |
| src/adapters/pi/memory-write-tool.ts | 655 | 1 / 1 | memory_write: scope fence, SQLite lock, safe read, backups with hardlink and prune, atomic publish |
| src/adapters/pi/profile-core-inline-extensions.ts | 182 | 2 / 2 | Memory prompt injection on every turn (3rd copy of safe read), guidance, ephemeral context |
| src/adapters/pi/profile-prompt.ts | 58 | 3 / 1 | AGENTS.md + SOUL/agent body composition |
| src/domain/memory.ts | 404 | 22 / 4 | Scopes, caps, id sanitising, pure ops. Fan-in is inflated by `codePointLength`, which Slack, Discord and pi-docs use as a string util |
| src/adapters/fs/memory-files.ts | 194 | 2 / 1 | Inventory plus safe read (2nd copy). Also defines the `MemoryFiles` port |
| src/application/memory.ts | 85 | 4 / 2 | list/show projection |
| src/faces/memory-cli.ts, faces/commands/memory.ts, faces/agents-cli.ts, application/ui-gateway/agent-projection.ts | 78 / 38 / 64 / 67 | faces | Rendering. The scope literal is duplicated at `memory-cli.ts:5,18` |

### 2. What this area is for

- **Primitive 8, Profile Agent** (spec :84, :19). `agents/<id>.md` is the only authority for a specialist's role, model, reasoning and tools. There are three ways to run an agent:
  - **Direct**: `agents run` or an automation starting with `@agent-id`. Produces one root JSONL.
  - **Child**: `agent_run`/`agent_discuss`. Produces one JSONL per child whose Pi header points at the parent. The parent's tool result stays bounded.
  - **Rail**: `openSpecialistChat`. A continued chat with the agent as root.
- Children never get `memory_write`, `agent_run` or `agent_discuss`. Discussion children get no tools. An unknown or unavailable declared tool must fail typed before any provider call.
- **Primitive 4, Memory** (spec :80). Facts are plain markdown:
  - `MEMORY.md` loads everywhere.
  - `memory/users/<id>.md` loads only in 1:1 chats.
  - `memory/groups/<id>.md` is the only extra document in groups.
  - Writes are capped and rejected on overflow. They are atomic, and the next turn sees them.
  - "No durable fact has two writable authorities" (spec :86).
- For the owner, the rule for picking a model, thinking level and tools must be one function. `agents validate` and every run path must agree with it.

### 3. How it got this shape / the mistakes

1. **"Borrow a parent" became "fabricate a parent."**
   - Specialists first ran only as TUI children (a5670bd3, c4e854ba). They got Profile services by reaching into the live parent runtime (`SpecialistParent`, pi-agent.ts:529-541).
   - When direct runs arrived (ed62b465 "persist Profile agent session lineage across faces"), there was no parent. So `runSpecialist` and `openSpecialistChat` build a full Profile runtime: extensions prepared, factories executed, SOUL loaded, `leaseProfileRuntime`. They then call `selectSpecialist` and dispose it (pi-agent.ts:1338-1367, 1516-1543). Only then do they build the real child.
   - The throwaway runtime is not only for `modelRuntime`. It supplies three things:
     - `getAllTools()` for tool validation (specialist.ts:773).
     - The fallback model and thinking level (:709, :761).
     - The quarantine-partitioned `resources` (:1355).
   - So `ModelRuntime.create` is enough only once tool validation moves onto the child itself (see §5).
2. **One policy, three validators.**
   - `selectSpecialist` (specialist.ts:680-809), `runtimePolicyError` (application/profile-agents.ts:129-166) and `selectSessionModel` (application/models.ts:66).
   - The blocked-tool list exists twice: profile-agents.ts:25 and specialist.ts:542.
   - Thinking levels exist three times: domain/profile.ts:70, specialist.ts:47, specialist.ts:63.
   - They already disagree:
     - `validate` never checks auth for an explicit provider (:161).
     - `validate` never checks whether a tool exists.
     - **Real bug:** `tools: profile_extensions` passes both validators. `profile_extensions` is in the parent's `getAllTools` but not in either block list. The child never receives that custom tool, so Pi silently drops the name (agent-session.js:2800-2806). This breaks the invariant the test at specialist.test.ts:400 is named for ("fails … instead of dropping it").
3. **Hardening by incident accretion in memory.**
   - The stale-snapshot lost update was real (stateful audit, LOG.md:40), so a lock was legitimate.
   - The lock then evolved from a hand-rolled marker, to a takeover race fix (2e56ffd4), to SQLite `BEGIN IMMEDIATE` (LOG.md:60), to a symlink audit on the lock file (LOG.md:1300, audit A03).
   - Backups with hardlink publish, 10-copy prune and `MemoryBackupError` came from "recoverable memory" (2fd4b3c8), an owner-facing feature documented in docs/operations/memory.md:47. That is about 215 lines (memory-write-tool.ts:213-426) plus 5 tests, for something the spec never asks for.
   - Safe read is written three times: inline-extensions.ts:25, memory-write-tool.ts:150, memory-files.ts:127.
   - The SQLite `BEGIN IMMEDIATE` lock is written four times: memory-write-tool.ts:496, session-lease.ts:94, profile-extension-lock.ts:277, gateway-owner.ts:281.
4. **Leases applied uniformly, even where no contention is possible.**
   - Child and direct-root sessions get fresh random ids, yet they still take writer leases (specialist.ts:378, pi-agent.ts:1508). The rail also passes a lease through the replacement callbacks (pi-agent.ts:1401-1406), which comes from a4946ad2.
   - Only the rail (`"continue"` mode, pi-agent.ts:1375) can actually collide.
5. **Re-validating what Pi already validates.**
   - Pi validates tool arguments before `execute` (pi-agent-core agent-loop.js:492), yet `Value.Check` runs again inside `execute` (specialist.ts:886, 964).
   - TypeBox *result* schemas (:89-187) exist only to derive types and for one test assertion (specialist.test.ts:674).
6. **Seams shaped for fakes.**
   - `SpecialistSelectionParent`, `SpecialistChildRuntime`, `SpecialistExecutionEnvironment` and the 8-positional-argument `specialistRuntime` (:267) exist mainly so fakes typecheck (specialist.test.ts:449-470, pi-agent.test.ts:1256).
7. **Spec miss.** `agent_run` returns the full child answer twice: in the content and again in `details.result` (specialist.ts:898). The spec requires bounded parent output (spec :19). This matches audit A05.

### 4. Reach today

**T1 — Add a tool-restriction field to `agents/<id>.md` (e.g. `excludeTools`), or newly forbid a tool to children.**

| # | File | Site |
|---|---|---|
| 1 | domain/profile.ts | :82 `ProfileAgent` schema |
| 2 | adapters/fs/profile-agents.ts | :18 allowed fields, :129 decode input, :150 `rawAgent` |
| 3 | adapters/pi/specialist.ts | :542 block list, :680 `selectSpecialist`, :267 `specialistRuntime` signature, :356 `childRuntime`, :881 tool description |
| 4 | adapters/pi/pi-agent.ts | :1393, :1549 positional calls |
| 5 | application/profile-agents.ts | :25 block list, :129 validator, :27/:100 projection |
| 6 | application/ui-gateway/agent-projection.ts + domain/ui-gateway/core-results.ts:336 | UI schema |
| 7 | faces/agents-cli.ts | render |
| 8-9 | test/adapters/pi/specialist.test.ts fake parents; pi-agent.test.ts:1256 | positional call |

That is **9 files and about 17 sites**. Leaking contracts: `ProfileAgentProjection` (main, faces, UI) and the `specialistRuntime` positional signature (tests).

**T2 — Add a memory scope (e.g. `channel`).**
- domain/memory.ts: `ChatContext`, `MemoryScope`, `MemoryScopeReference` regex, `MemoryScopeSelection`, `memoryCap`, `memoryDocumentFromRelativePath`, `memoryDocumentForScope`, `memoryFilePaths`, `parseMemoryScopeReference`. Nine sites, with headings repeated three times.
- memory-write-tool.ts: :39 schema, :89 parent depth, :570 fence, :594 description.
- memory-files.ts: :95 `["users","groups"]`, :133 parent depth.
- faces/memory-cli.ts: :5, :18.
- domain/ui-gateway/core-results.ts: :395, :414.
- adapters/pi/doctor-checks.ts: :22 caps.
- docs/operations/memory.md.

That is **7 code files and about 21 sites**. A new `ChatContext` kind also reaches gateway.ts, application/agent.ts and runtime.ts.

**T3 — Change where an agent's omitted model/thinking come from.**
- specialist.ts:709-771.
- application/profile-agents.ts:129-166.
- pi-agent.ts:1338-1367 and :1516-1543, the selection runtimes that decide the "parent".
- specialist.test.ts:305-448 fakes.

That is **4 files and 3 separately maintained rules**.

### 5. What Pi already provides

| Need | Pi (node_modules/@earendil-works/pi-coding-agent/dist) | Ziggy today |
|---|---|---|
| Profile models, auth, settings without a session | `ModelRuntime.create` (core/model-runtime.d.ts:56). `getProvider`/`getModel`/`hasConfiguredAuth` :69-88. Already used at adapters/pi/models.ts:176 and auth.ts:112 | Builds a full session runtime to reach these (pi-agent.ts:1516). **Needless.** |
| Tool allowlist and denylist | `tools`, `noTools:"all"`, `excludeTools` (core/sdk.d.ts:33-45; agent-session-services.d.ts:53-55). Allowlist semantics at sdk.js:145-148 | `noTools:"all"`, `tools` used correctly (specialist.ts:330). `excludeTools` is unused, so blocking is done by name matching. **Partly duplicated.** |
| Unknown allowlisted names | Silently dropped (agent-session.js:2745-2806) | Ziggy pre-validates against the *parent's* registry, which is the wrong registry (bug in §3.2). The correct check is `session.getActiveToolNames()` on the child. **Genuine policy, wrong place.** |
| Child lineage | `SessionManager.create(cwd, dir, {parentSession})` (core/session-manager.d.ts:11, :371). Header written at session-manager.js:703 | session-lineage.ts uses it correctly. **Keep.** |
| Lazy JSONL | Written on first assistant message (pinned by pi-agent.test.ts:1287) | Relied on. **Keep.** |
| Tool argument validation | agent-loop.js:492 `validateToolArguments` | Repeated with `Value.Check` (specialist.ts:886, 964). **Needless.** |
| Per-turn prompt hook | `before_agent_start` returning `systemPrompt` | Used for memory, guidance and ephemeral context. **Right idiom.** |
| Usage | `getSessionStats()` returns tokens and cost only (agent-session.d.ts:185-202). There is no `Usage` shape for nesting in `AgentToolResult.usage` | `usageFromMessages`/`addUsage` (specialist.ts:492-540). **Genuine, but it can be shortened.** |
| Memory, discussion bounds, `@agent-id`, child tool bans | None | **Genuine Profile policy.** |

Answer to (b): yes, parents and children can come from one `open(profilePath, sessionManager, spec)`. They differ only in these ways:
- **resourceLoaderOptions:** the systemPrompt (SOUL vs AGENTS+agent body) and the extension factories (core inline extensions vs package factories plus reference extensions).
- **customTools:** memory_write and the agent tools vs none.
- **model/thinking**, and **tools/noTools/excludeTools**.
- **`parentSession`**, which is an option on `SessionManager.create`, not on `createAgentSession`.

### 6. Target shape

**One owner: `src/adapters/pi/agents.ts`, about 350 lines.** It replaces specialist.ts, the specialist parts of pi-agent.ts and the application validator. It sits on the session lane's `open` builder.

```ts
// one rule, used by `agents validate`, direct, child and rail
resolveAgentPolicy(
  profilePath: string, agent: ProfileAgent,
  pi: { modelRuntime: ModelRuntime; settings: SettingsManager },   // ModelRuntime.create, no session
  narrow?: ReadonlyArray<string>,                                  // discussion passes []
): Effect<AgentPolicy, SpecialistPolicyError>
type AgentPolicy = { agent: ProfileAgent; model: Model<Api>; thinking: ThinkingLevel; tools: ReadonlyArray<string> }

type Placement =
  | { kind: "root"; directory: string }          // agents run, automation @agent — no lease
  | { kind: "child"; parent: SessionManager }    // agent_run / agent_discuss — no lease
  | { kind: "rail" }                             // continue sessions/local/agents/<id> — lease

runAgent(target, agentId, prompt, placement, narrow?): Effect<AgentRunResult, ProfileSpecialistError>
// = resolveAgentPolicy → open(manager, { systemPrompt: AGENTS+body, extensionFactories: packages+reference,
//     model, thinking, tools, noTools: "all", excludeTools: CHILD_FORBIDDEN })
//   → assert policy.tools ⊆ session.getActiveToolNames() else dispose + SpecialistToolUnsupported
//   → promptForAssistantText → dispose
agentTools(runAgent, parent: () => SessionManager): [agent_run, agent_discuss]   // bounded content; details = {session, usage, model}
```

What the owner no longer does:
- No selection runtime.
- No `SpecialistParent`, `SpecialistSelectionParent`, `SpecialistExecutionEnvironment` or `SpecialistChildRuntime`.
- No leases on fresh-id sessions.
- No positional builder.
- No TypeBox result schemas and no second `Value.Check`.
- No `runtimePolicyError`.
- No second block list or thinking list: `CHILD_FORBIDDEN` and `ProfileAgentThinking` live in the domain.

Shim for faces: `runSpecialist(target, id, task, ctx) = runAgent(..., {kind:"root", directory: ctx.sessionDirectory})`, and `openSpecialistChat` becomes a thin rail shim. `ProfileAgentRunResult` is unchanged.

**Memory: domain/memory.ts plus adapters/fs/memory-files.ts**, with the tool at about 100 lines.
- domain/memory.ts gets one scope table, `{ shared | person | group } → { dir, cap, heading, admittedIn(ctx) }`. `MemoryScope = Schema.Literals(keys)` is exported for faces and the UI, and `memoryFilePaths`, `memoryDocumentForScope`, `fromRelativePath` and `memoryCap` all derive from it. `codePointLength` moves to a string util.
- memory-files.ts owns one `read(document)`: `open(O_RDONLY|O_NOFOLLOW)` followed by an fstat regular-file check. The prompt hook, the tool and the CLI all use it.
- memory-files.ts also owns `update(document, ops)`: `withFileLock(.runtime/locks/<doc>)` → read → `applyMemoryOperations` → `wx` tmp → fsync → rename. `withFileLock` is one shared bun:sqlite helper that session-lease, extension-lock and gateway-owner also adopt.
- memory_write keeps only the context fence and error mapping.

| Task | Today | After |
|---|---|---|
| T1 tool restriction | 9 files / ~17 sites | 3 files: domain/profile.ts schema, fs frontmatter, `resolveAgentPolicy` (UI/CLI projection optional) |
| T2 memory scope | 7 files / ~21 sites | 1-2 files: the scope table, plus the tool description if it isn't derived from the table |
| T3 fallback rule | 4 files / 3 rules | 1 function |

### 7. Keep / rebuild / delete

| File | Verdict | Reason |
|---|---|---|
| adapters/pi/specialist.ts | **Rebuild** into agents.ts | Keep discussion bounding (:551-678), usage math and tool descriptions. Delete selection-by-parent, the builder, fake-seam interfaces and result schemas |
| pi-agent.ts :1314-1571 | **Delete** as shims over `runAgent` | The selection runtimes are the main waste |
| application/profile-agents.ts | **Keep, trimmed** | Replace `runtimePolicyError` and `blockedTools` with `resolveAgentPolicy` |
| adapters/fs/profile-agents.ts | **Keep** | The parser and CAS save are real. Optional: decode frontmatter straight into the Schema to drop `rawAgent` |
| domain/profile.ts agent part, domain/agent.ts errors | **Keep** | Collapse the six Specialist* policy errors to one `SpecialistPolicyInvalid{field}` if faces don't switch on them |
| session-lineage.ts, profile-prompt.ts, profile-agent-guidance.ts | **Keep** | Correct Pi idioms |
| memory-write-tool.ts | **Rebuild**, about 100 lines | Cross-process lock via the shared helper. Drop backups, hardlinks and directory walks |
| profile-core-inline-extensions.ts | **Keep** | Swap its private safe-read for `memoryFiles.read` |
| domain/memory.ts | **Keep, reshape** | Add the scope table. Move `codePointLength` out |
| adapters/fs/memory-files.ts + application/memory.ts | **Merge** into one memory module | A port with one implementation adds a boundary without buying anything (disagrees with audit A09) |

### 8. Tests

**KEEP**
- domain/memory.test.ts, all. Pure op invariants.
- memory-write-tool.test.ts:52 concurrent adds survive. Upgrade it to two Bun subprocesses. :116 overflow leaves the file untouched.
- profile-core-inline-extensions.test.ts:14. Memory is reread each turn, which fixes LOG.md:40.
- application/memory.test.ts:18, :63.
- profile-prompt.test.ts:20.
- fs/profile-agents.test.ts:29, :36, :65 (parse/discovery) and :129, :155, :178, :201 (CAS save).
- application/profile-agents.test.ts:82 and :117, repointed at `resolveAgentPolicy` with a real `ModelRuntime` on a temp models.json.
- specialist.test.ts :305-424, rewritten against `resolveAgentPolicy`. Invariants: the file is authoritative, the allowlist never expands, blocked or unavailable tools fail rather than drop, thinking is checked via Pi's levels.
- specialist.test.ts :492 usage and :587, :645, :696, :737, :789. The discussion loop is pure orchestration, so the runner stub is legitimate there.
- pi-agent.test.ts:1210 (memory tool on the parent, not the child), :1287 (pins lazy JSONL), :1306, :1327, :1391, :1455, :1529, :1548.

**DELETE**
- specialist.test.ts :170, :201, :227, :295 and :555 (schema half). They cover the fake runner, TypeBox shape and redundant `Value.Check`.
- specialist.test.ts :547, which is trivia.
- specialist.test.ts :449 (fake `SpecialistChildRuntime`). Replace it with a real cancellation e2e.
- memory-write-tool.test.ts :160, :188, :242, :264, :301 (backups; only if D2 = drop).
- memory-write-tool.test.ts :85 and :137, which move to one shared lock-helper test.
- memory-write-tool.test.ts :333, symlinked runtime dir (see D4).
- profile-core-inline-extensions.test.ts:42.
- application/memory.test.ts:81.
- application/profile-agents.test.ts:143, which checks delegation to a fake `ZiggyAgent`.
- profile-prompt.test.ts:39.
- faces/agents-cli.test.ts, render trivia; keep at most the JSON contract.

**E2E proofs**. These use a scripted provider built on the pi-agent.test.ts:628 fixture or `registerProvider({streamSimple})`, with temp Profiles:
1. The parent's scripted `agent_run` produces one child JSONL under `sessions/agents/<parentId>/` whose header `parentSession` equals the parent file. The parent tool result is ≤ the bound. The child's provider request shows the agent body as system prompt, the model from the agent file, and a `tools` array equal to the declared set (no memory_write or agent_*).
2. The `ziggy agents run` CLI produces one root JSONL with the agent's model and thinking. Assert **1 provider request and 1 execution per extension factory**, which proves the selection runtime is gone.
3. An agent declaring `profile_extensions` or a misspelled tool gets typed `SpecialistToolUnsupported` with 0 provider requests.
4. `agent_discuss` with 2 agents and 2 rounds produces 4 child JSONLs. Every child request has no tools, and the parent output is bounded.
5. Memory:
   - A mid-turn `memory_write` replaces the file.
   - The next turn's request contains the fact.
   - A group context never contains `users/<id>.md`.
   - Over-cap writes are rejected and the file is unchanged.
6. Two processes each run 20 concurrent adds on one `MEMORY.md`. All entries must survive, which justifies keeping the lock.

### 9. Decisions for the owner

- **D1. Where do an agent's omitted model and thinking come from?**
  - Today `agent_run` inherits from the live parent session (specialist.ts:709, :761), while direct and rail runs inherit the Profile default via the throwaway runtime.
  - Arguments for the Profile default (`settings.json`):
    - `validate` and every run path then agree.
    - `ModelRuntime.create` plus `SettingsManager` becomes sufficient.
    - It matches how automations inherit (spec :83).
  - Argument for the parent: a chat that switched models with `/model` gets matching specialists.
  - **Recommend the Profile default.** Agents that need a model should declare one.
- **D2. Memory backups.**
  - For keeping them: an owner-shipped, documented recovery path (2fd4b3c8, docs/operations/memory.md:47).
  - Against: about 215 lines plus 5 tests, outside the spec, and it depends on hardlink publish and prune.
  - **Recommend** replacing them with a single previous-version copy (`.runtime/memory/<doc>.prev.md`, one `writeFile`). Alternatively drop them and point at git. Either way, update the doc.
- **D3. Cross-process memory lock.**
  - Writers outside the resident are real: `ziggy run`/ask always registers memory_write (pi-agent.ts:545), and `wake` runs in-process when no resident is running (LOG.md 2026-09-28 "extensions run without the resident").
  - Last-writer-wins silently loses a durable fact.
  - **Recommend keeping a cross-process lock**, but as the one shared `withFileLock` helper (the four copies → one), not a memory-private SQLite routine.
- **D4. Symlink hardening depth.**
  - Parent sessions have Pi's default `bash`/`write` tools, so directory-walk and lock-file symlink checks don't stop the model from doing anything it couldn't already do.
  - **Recommend** keeping `O_NOFOLLOW` plus a regular-file fstat on the document, and dropping the parent-directory walks (memory-write-tool.ts:89-148, memory-files.ts:127-140) and audit A03's lock-artifact work.

### 10. Where I disagree with the Fable review or the audit

- **Fable, "selection runtime exists just to read `services.modelRuntime`":** partly wrong. It also supplies the tool registry, the fallback model and the partitioned resources (specialist.ts:709, :761, :773; pi-agent.ts:1355). `ModelRuntime.create` is enough only after tool validation moves to the child's `getActiveToolNames()` and D1 is decided.
- **Fable, "Child = openSession with {…, parentSession}":** `parentSession` is a `SessionManager.create` option (session-manager.d.ts:11), not a session option. The design is otherwise right. Fable also misses `excludeTools` (sdk.d.ts:45) and the `profile_extensions` validation bug.
- **Fable, memory "in-process Semaphore, no SQLite":** disagree (D3). Its own item 5 concedes that concurrent `ziggy run` writes are lost. That is a silent fact loss, which the spec's invariants forbid. Keep one cross-process lock helper. Agree on dropping backups and hardlinks.
- **Fable's specialist.test.ts:170-300 delete list:** agree for the fake-runner and schema tests. But :305-424 encodes real policy invariants and should be *rewritten*, not deleted.
- **Audit A03 (harden the SQLite lock artifact against symlinks):** this becomes moot with the shared helper under `.runtime`, and the threat model doesn't warrant it (D4).
- **Audit A09 (move the MemoryFiles port into application):** disagree. The port has one implementation, and its only other consumer is a fake. Merge application/memory.ts and fs/memory-files.ts instead.
- **Audit, "domain/memory.ts: no finding":** disagree mildly. Scope policy is spelled out in three constructors with the headings repeated. The scope literal is copied into faces/memory-cli.ts:5,18 and ui-gateway/core-results.ts:395,414. `codePointLength` inflates the file's fan-in to 22. That is the root of T2's reach.
- **Audit A05 (bound the `agent_run` parent copy):** agree. Also drop the duplicate answer in `details.result`.