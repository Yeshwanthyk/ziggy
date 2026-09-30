# Area: Profile, read-only Sessions, Composition (Part A) and whole-repo verification loop (Part B)

## 1. Files

| File | Lines | Fan-in src/test | Role |
|---|---|---|---|
| /Users/yesh/code/personal/ziggy/src/domain/profile.ts | 231 | 55/12 | Mainly `ProfileTarget` (about 38 of 55 importers use nothing else). It also holds agent schema and errors, the mention parser, `ProfileExtensionInvalid`, `soulTemplate` and path resolution. |
| /Users/yesh/code/personal/ziggy/src/application/profiles.ts | 366 | 6/3 | init, list, registry and the memory scaffold, behind a hand-rolled `ProfileStore` port |
| /Users/yesh/code/personal/ziggy/src/application/profile-directory.ts | 209 | 5/5 | A second registry reader with hashed `prf_` ids. Imports `node:fs/promises` directly. |
| /Users/yesh/code/personal/ziggy/src/domain/profile-directory.ts | 57 | 17/3 | Types for the directory entries |
| /Users/yesh/code/personal/ziggy/src/adapters/fs/profile-store.ts | 52 | 1/1 | The only implementation of `ProfileStore` |
| /Users/yesh/code/personal/ziggy/src/adapters/fs/cause.ts | 22 | 30/0 | Maps fs errors to causes. Fine. |
| /Users/yesh/code/personal/ziggy/src/application/ziggy-paths.ts | 31 | 7/1 | `ZiggyPaths` service. Fine. |
| /Users/yesh/code/personal/ziggy/src/adapters/bun/ziggy-paths.ts | 14 | 1/0 | Reads `ZIGGY_HOME` through Config. Fine. |
| /Users/yesh/code/personal/ziggy/src/domain/session.ts | 113 | 7/4 | Rich `SessionMetadata`, summary and history types, errors |
| /Users/yesh/code/personal/ziggy/src/application/sessions.ts | 63 | 5/4 | `SessionsApi` facade. Imports three adapters directly, which is a layer violation. |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/sessions.ts | 729 | 5/2 | Its own recursive walk, a strict parser, lineage, a 512-entry mtime cache, and show |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/session-history.ts | 301 | 1/3 | Paged history for ui-gateway `session.history` only, with a sha256 cursor |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/transcript-lines.ts | 118 | 2/1 | Streaming, bounded, O_NOFOLLOW line reader. Genuinely read-only. |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/session-discovery.ts | 91 | 2/0 | Header-only "most recent session", used for the lease precheck before open |
| /Users/yesh/code/personal/ziggy/src/main.ts | 906 | 0 (fan-out 44) | CLI edge. `runCommand` yields 18 services for every legacy command. |
| /Users/yesh/code/personal/ziggy/src/composition.ts | 159 | 1/0 (fan-out 32) | `CliLayer` builds everything. Area layers are only started. |
| /Users/yesh/code/personal/ziggy/src/faces/cli.ts | 760 | 1/3 | argv decoding |
| /Users/yesh/code/personal/ziggy/src/faces/commands/{models,sessions,memory}.ts | 36/40/38 | new | Per-area command handlers. `memory.ts` is not wired yet (uncommitted work in progress). |

## 2. What this area is for

- **Primitive 1 (Profile).** A folder with a human-owned `SOUL.md`, created once and never overwritten. Ziggy can list and resolve it by name or path.
- **Primitive 3 (Session).** Pi's JSONL transcripts, projected read-only across nested directories:
  - `sessions/local/main`
  - `sessions/local/agents/<id>`
  - `sessions/agents/<parent>`
  - channel directories

  It rejects symlinks, never exposes transcript content from list/show, and must "create and rewrite nothing".
- **Composition.** Each command builds only the services it uses. `BunRuntime.runMain` stays the single execution edge.

The owner needs three things to hold: listing never writes, a session id resolves to the exact file, and `ziggy profiles` does not build the resident gateway, scheduler and Pi agent.

## 3. How it got this shape / the mistakes

1. **Ports with one implementation.** The ports are `ProfileStore`/`ProfileFilesApi` (profiles.ts:55-74, with one adapter at profile-store.ts) and the optional `history` on `SessionsApi`. Both came from the "Effect-native capabilities" push (docs/plans/effect-composition.md). The port adds a signature to edit and nothing to swap.
2. **Parallel readers of one file.**
   - profiles.ts reads `profiles.list` and prunes it while listing (:348-353, audit A02).
   - profile-directory.ts:73 reads the same file again with different semantics (hashed ids, its own `isAvailable` and `displayName`).
   - Sessions has three projections of the same JSONL: `list`, `listProfileSessionSummaries` (sessions.ts:520-619) and `show` (:621-729), plus `session-history.ts`. Each was added for one consumer (CLI, ui-gateway list, ui-gateway history).
3. **Speculative projection code.** session-history.ts:165 keys on top-level entries with `type === "toolCall" || "tool_call"`. Pi never writes such entries: the entry union in `session-manager.d.ts` is session, message, thinking_level_change, model_change, usage, compaction, branch_summary, custom, label, session_info, custom_message and context_edit. The test fabricates that shape (test/adapters/pi/session-history.test.ts:72). Meanwhile the real Pi 0.99 `type:"usage"` entries (`appendUsage`) are ignored by the usage sums in sessions.ts.
4. **Hub-as-dumping-ground.** `domain/profile.ts` gained agent schema (:82-97), mention parsing and prompt injection (:109-157, model guidance text at :155), and `ProfileExtensionInvalid` (:33). The reason is that "profile" was the nearest existing file. That is why its fan-in is 55.
5. **One god layer.** `CliLayer` (composition.ts:131-149) plus the 18 yields in `runCommand` (main.ts:90-108). The owner is already fixing this: 78e5a8c0 added the composition root, and 23c49386 dispatches by area.

**What was legitimate:**
- transcript-lines.ts. Bounded streaming and O_NOFOLLOW answer the large-transcript case (sessions.test.ts:274 "larger than the former total-file limit") and primitive 3's symlink rule.
- session-discovery.ts and session-lease.ts. They exist because of the LOG.md 2026-09-28 "extensions run without the resident" decision: the resident became optional, so a per-session writer lease is needed, and the lease has to be checked before `SessionManager` is constructed.
- Recursion over nested directories. This is real Ziggy policy.

## 4. Reach today

The counts come from my import tracing and are approximate to within one file.

**T1. Add a field to the session list, e.g. cost from Pi usage entries.** About 9 files:
- `domain/session.ts` (SessionMetadata and summary)
- `adapters/pi/sessions.ts` (parseSession, summary projection and cache)
- `application/sessions.ts`
- `faces/sessions-cli.ts`
- `ui-gateway/sessions.ts:207`
- the domain ui-gateway schema
- tests: `sessions.test.ts`, `sessions-cli.test.ts`, `ui-gateway.test.ts`

**T2. Change the Profile registry format, e.g. store a stable id.** About 7 files:
- `application/profiles.ts` (read, prune, write)
- `application/profile-directory.ts` (the second reader and its hashing)
- `domain/profile-directory.ts`
- `ProfileFilesApi` plus `profile-store.ts`
- tests: `profiles.test.ts`, the ui-gateway tests

**T3. Add a CLI command that reads Profiles.** 4 files:
- `faces/cli.ts`
- `cli-command.ts`
- `main.ts` (`runCommand`)
- `composition.ts`

The command then builds the resident, scheduler and PiAgent anyway, because it goes through `CliLayer`.

**Contracts that leak outward:**
- `ProfileTarget` (55 importers)
- `SessionMetadata` and `ProfileSessionSummary` (ui-gateway, CLI renderers)
- `SessionsApi.history?` (ui-gateway falls back to `noService`)
- `ProfileDirectory` entries (ui-gateway)

## 5. What Pi already provides

All paths are under /Users/yesh/code/personal/ziggy/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js.

- **`SessionManager.open` is not read-only.**
  - `loadEntriesFromFile` (:325-368) appends `"\n"` to repair a partial last line.
  - The constructor calls `mkdirSync` (:644-660).
  - `_setSessionFile` can call `_rewriteFile` (:665-689).
  - `_loadEntries` rewrites on migration (:717-731).

  So it cannot back list/show without breaking primitive 3.
- **`parseSessionEntries(content)` (:91, exported at index.d.ts:21) and `migrateSessionEntries`.** Pure. This is where Ziggy should get entry parsing and typing instead of its own strict parser (sessions.ts:277-424).
- **`SessionManager.list(cwd, dir)` (:1449).** Read-only, but flat (one directory) with a cwd filter, and it silently swallows errors.
  - Its `SessionInfo` {name, firstMessage, modified, messageCount, parentSessionPath} nearly duplicates Ziggy's summary (title = name ?? first user text, updatedAt = activity).
  - Recursion, symlink refusal and typed failure for an addressed id are genuine Ziggy policy.
- **`findById` (:1421) and `findMostRecentSession` (:445).** Header-only and flat; `findMostRecentSession` is not exported from index. Ziggy's `session-discovery.ts` mirrors them across nested directories. That is justified only by the lease precheck.
- **`continueRecent` (:1354).** Constructs a manager, so it writes. It is not a substitute for session-discovery.
- **Duplicated needlessly:** entry typing and parsing, the summary fields, and the tool-call projection (which is wrong).
- **Genuine Ziggy policy:** recursive nested layout, lineage across directories, symlink refusal, bounded reads, the writer lease.

## 6. Target shape

**One owner: `src/application/sessions.ts`, with a single `adapters/pi/session-files.ts`:**

```ts
interface Sessions {
  list(target: ProfileTarget): Effect<ReadonlyArray<SessionSummary>, SessionReadFailed>      // lenient: bad files reported, not fatal
  show(target: ProfileTarget, id: SessionId): Effect<SessionMetadata, SessionNotFound | SessionReadFailed> // strict for the addressed id
  locate(target: ProfileTarget, id: SessionId): Effect<string, SessionNotFound>                // header-only; replaces resolve-by-full-list (main.ts:481-488)
  history(target, id, cursor?: { before: number }): Effect<SessionHistoryPage, ...>           // last N user/assistant texts, index cursor
}
```

- **Reading.** One walk: recursive with lstat, refusing symlinks. Each file goes through transcript-lines, then Pi's entry types, then one projection. `SessionSummary` is derived from `SessionMetadata`; there is no second parser.
- **No longer does:**
  - the module-global mtime cache (re-add only if a measured need appears)
  - the sha256 whole-file digest cursor
  - the fake toolCall branch
  - adapter imports from the application layer, which move behind a Layer
- **Profiles: one owner, `application/profiles.ts`.**
  - `init`, `list` (read-only, no pruning), `resolve`, and `directory` (absorbs the `prf_` id and display name).
  - Uses fs through `adapters/fs` functions and drops the `ProfileStore` port.
  - The memory scaffold (:140-227) moves to `application/memory.ts`.
- **`domain/profile.ts`** keeps `ProfileTarget`, path resolution and `soulTemplate`. The agent schema and mention code move to `domain/profile-agent.ts`, and `ProfileExtensionInvalid` goes to the extensions domain.
- **Composition.**
  - Finish area layers: `ProfilesCommandsLayer` = ProfilesLive + ZiggyPathsLive, with no Pi runtime.
  - Drop `PiStandaloneRuntimeLive` from `SessionsCommandsLayer` (composition.ts:157-159).
  - Wire `commands/memory.ts`.
  - `runCommand` shrinks as each area moves. Delete it when empty.
- **Reach afterward:**
  - T1: 3 files (sessions owner, CLI renderer, ui-gateway projection) plus 1 e2e assertion.
  - T2: 1–2 files.
  - T3: 3 files (cli decode, `commands/<area>.ts`, area layer), and the command builds only its own services.
- **Faces keep compiling.** Keep `SessionsApi` as a type alias of `Sessions` until ui-gateway is reshaped.

## 7. Keep / rebuild / delete

| File | Verdict | Reason |
|---|---|---|
| domain/profile.ts | Rebuild (split) | Keep `ProfileTarget`; move the agent and extension hitchhikers out |
| application/profiles.ts | Rebuild | Single registry owner; no write on list; memory scaffold moves out |
| application/profile-directory.ts | Delete (fold) | Second reader of `profiles.list`, with fs in the application layer |
| domain/profile-directory.ts | Keep | ui-gateway contract |
| adapters/fs/profile-store.ts | Delete | Port with one implementation |
| adapters/fs/cause.ts, ziggy-paths (both) | Keep | Small and correct |
| domain/session.ts | Keep, trim | Drop history-cursor digest types |
| application/sessions.ts | Rebuild | The one owner; adapters behind a Layer; `locate` replaces resolve-by-list |
| adapters/pi/sessions.ts | Rebuild (~729 → ~250) | One walk and one projection on Pi entry types; count `usage` entries; no cache |
| adapters/pi/session-history.ts | Rebuild (~301 → ~80) | Index cursor; delete the toolCall branch at :165 |
| adapters/pi/transcript-lines.ts | Keep | Bounded, read-only, symlink-safe |
| adapters/pi/session-discovery.ts | Keep while the lease exists | Lease precheck before Pi constructs a writer |
| composition.ts | Rebuild incrementally | Area layers; retire `CliLayer` |
| main.ts | Shrink | Move areas into `faces/commands/*`; delete `runCommand` at the end |
| faces/commands/*.ts | Keep, extend | The right shape already |

## 8. Tests (this area)

**KEEP:**
- **profiles.test.ts, all 5 tests.** Real invariants: SOUL.md is created once, including under concurrency (:83); symlink rejection; minimal init.
- **domain/profile.test.ts:17-51.** Target resolution round-trips.
- **sessions.test.ts:**
  - :274 large transcript
  - :312 no path escape
  - :351 symlinks
  - :373 CLI read-only and no transcript content
  - :414 exact `--session`
  - :538 no rewrite on malformed
  - :550 read while a writer holds the lease
- **session-lease.test.ts, all 4.** Real multi-process SQLite races.
- **cli.test.ts decode tests.**

**TRIM or DELETE:**
- **session-history.test.ts:72.** The fabricated `toolCall` entry. Delete it; rewrite the remaining 3 against real Pi output.
- **sessions.test.ts:581.** Cache reuse. Delete it along with the cache.
- **domain/profile.test.ts:78-161.** Moves with the agent code.
- **sessions-cli.test.ts and profiles-cli.test.ts.** Renderer trivia. Keep one JSON-shape test each and delete the pretty-layout tests (:50, :62).

**End-to-end proofs needed here:** P1, P3 and the composition check in section 11.

## 9. Decisions for the owner

1. **Lenient `list`, strict `show`?**
   - Today `list` is strict (rejects an assistant message missing usage), but the ui-gateway summaries path isolates bad files (sessions.test.ts:604).
   - Pi's own `list` swallows errors.
   - Recommendation: lenient list that reports bad files, strict show for the addressed id. One parser, two policies.
2. **Keep the history digest cursor?**
   - For: it detects a transcript rewritten under the cursor.
   - Against: it hashes the whole file per page, and Pi only appends except on migration.
   - Recommendation: index plus `{size}` guard. Drop sha256.
3. **Registry pruning (A02).**
   - Recommendation: never write on `list`. Prune only in `init` or an explicit `profiles prune`.
4. **session-discovery and the lease.** These stand or fall with the 2026-09-28 decision. Recommendation: keep both. If the owner ever reverts to resident-only writers, delete both (about 413 lines plus about 120 lines of tests).

## 10. Where I disagree with the Fable review or the audit

- **Fable: "SessionManager.open per file" for list/show.** Refuted. `open` writes (session-manager.js:325-368, :644-660, :665-689, :717-731). Use `parseSessionEntries` or the typed entries over transcript-lines instead.
- **Fable: delete session-discovery.** No, not while the writer lease exists. Fable missed the LOG 2026-09-28 plan that created the need.
- **Fable: keep `domain/profile.ts` as-is.** No. 38 of its 55 importers need only `ProfileTarget`, and the agent and mention code is the churn source.
- **Fable: "71 tests in 1.3s" for the big real-Pi files.** Not reproduced. I measured:
  - pi-agent: 27 tests in 1.07s
  - sessions: 14 in 1.37s
  - resources: 12 in 0.53s
  - preflight: 6 in 0.46s

  That is 59 tests in about 3.4s. Fable's direction is right; its number is optimistic.
- **Fable: budget under 15s.** The current full suite is 17.8s for 722 tests in 94 files. The budget is reachable only with the deletions below and by fixing resident-gateway.test.ts (3.95s alone).
- **Audit A10.** Agree, and extend it: `SessionsCommandsLayer` should not provide `PiStandaloneRuntimeLive`, and Profiles and init need their own layer.
- **Audit A02.** Agree. I would also fold profile-directory.ts into the same fix; the audit treats it separately.

## 11. Verification loop and test triage (whole repo)

### Measured

- `bun test test`: 722 pass, 0 fail, 17.79s.
- Slowest files:

| File | Time |
|---|---|
| resident-gateway | 3.95s |
| profile-extension-lock | 2.31s |
| ui-server | 2.25s |
| session-lease | 1.65s |
| sessions | 1.31s |
| automation-scheduler | 0.81s |
| profile-extensions | 0.78s |
| pi-agent | 0.74s |

- No test drives a real tool call through a model loop. A grep for `tool_calls` finds nothing. So `memory_write`, `agent_run` and extension tools are only tested by direct invocation or fakes.

### Scripted provider

- **Primary: an SSE fixture server.** It is already proven at pi-agent.test.ts:628-700: `Bun.serve` on port 0 speaking openai-completions, wired through the Profile's `models.json` and `settings.json`. It crosses process boundaries (CLI subprocess, resident, built binary) with zero production seams. It needs a tool-call encoder: `delta.tool_calls` chunks plus `finish_reason: "tool_calls"`.
- **Alternative: pi-ai `fauxProvider`/`fauxToolCall`** (node_modules/@earendil-works/pi-ai/dist/providers/faux.d.ts, index.d.ts:22), with `ModelRuntime.registerProvider` (model-runtime.d.ts:111).
  - It works in-process only. pi-ai is not a direct dependency.
  - Ziggy constructs ModelRuntime itself (adapters/pi/models.ts:176), so this would need a test seam.
  - Assumption: registering it from a Profile extension is too late, because the model is resolved before extensions load.
  - Do not use it for the loop.

### Harness modules (test/harness/, about 400 lines total)

1. `provider.ts`: `fixtureProvider(script: Turn[])`. Returns `{ port, requests, writeInto(profileDir) }`, where a Turn is `text(s) | toolCall(name, args) | then(...)`. Lifted from pi-agent.test.ts:628-700 plus the tool_calls encoder.
2. `profile.ts`: `tmpProfile({ soul?, extensions?, agents?, automations? })`. Real mkdtemp with an isolated `ZIGGY_HOME`, plus `treeHash(dir)` for "wrote nothing" assertions.
3. `cli.ts`: `ziggy(args, { home, cwd, stdin? })`. Spawns `bun src/main.ts` and returns `{ code, stdout, stderr }`.
4. `resident.ts`: starts the resident on port 0 and connects with `packages/ui-sdk`'s client, with scoped teardown.
5. `transcript.ts`: reads JSONL through Pi's `parseSessionEntries` for assertions.

### One proof per primitive

All proofs use the real CLI or resident, a real tmp Profile and the fixture provider.

1. **Profile.** `init` twice leaves SOUL.md byte-identical and creates it once. `profiles` leaves `treeHash(home)` unchanged, which proves the A02 fix. `ziggy profiles` must not start the resident (assert no resident socket or lock file).
2. **Provider.** `run "hi"`: the request carries the configured model and the SOUL.md text in the system prompt. `models set x` changes the next request's model.
3. **Session.**
   - `sessions list --json` and `show` return metadata with no transcript text, and `treeHash(sessions/)` is unchanged.
   - `run --session <id>` appends to that exact file.
   - A second writer on a held session fails with a typed `SessionHeld`.
4. **Memory.** The script sends `toolCall("memory_write", …)`. The file lands in the memory directory, and the next run's request contains the memory.
5. **Extension.**
   - A tmp Profile extension registers a tool, the scripted call invokes it, and the result appears in JSONL.
   - A broken extension produces a diagnostic, and the run still completes (preflight/quarantine behavior as decided in lane 3).
6. **Gateway.** The resident with the ui-sdk client: prompt, streamed text, then `session.list` and `session.history` show the turn.
7. **Automation.** An immediate automation runs against the fixture and writes its result into a session. Repeat it with no resident running, per LOG 2026-09-28.
8. **Profile Agent.** The script sends `toolCall("agent_run", …)`. A child session appears under `sessions/local/agents/<id>` with parent lineage, and `@agent` mention routing is covered too.
9. **Resident/web-UI smoke.** ui-sdk connect, profile directory, session.list, prompt, history, disconnect, clean shutdown.

### Budget and gating

- **Budget.** Target the e2e suite at 10s or less.
  - Assumption: each CLI spawn costs about 200–400ms. That gives roughly 15 spawns plus 2 resident boots.
  - The whole suite should be 15s or less after the deletions below.
  - Run e2e files concurrently (separate files, since Bun runs files in parallel with `--concurrency`), with no shared ports.
- **Gating.**
  - Slice 0: write the harness and proofs P1–P9 against the current code. They must pass unchanged.
  - Every rebuild slice must pass `bun run check`, all e2e proofs, and the kept unit tests.
  - A slice deletes the unit tests for the machinery it replaces in the same commit.
  - A proof can be edited only when the spec behavior changes, and that change gets its own LOG.md entry.

### Triage of the 94 test files (32,564 lines)

| Class | Files | Reason |
|---|---|---|
| KEEP-AS-IS | session-lease, profile-runtime-lock, automation-sqlite, discord/slack/web-access ingress sqlite, recent-ids, gateway-owner, slack/discord api and socket, profiles, auth, models, standalone-runtime, pi-docs, resources, profile-prompt, ziggy-help, profile-extension-diagnostics, profile-core-inline-extensions, automation-files, fs/profile-agents, ui-state, slack/discord health (fs and domain), domain/automation, domain/memory, domain/slack*, domain/discord-health, domain/chat-health-model, domain/resident-service, automation-gate, command-cache, install-script, oxlint-parity, setup, doctor, automation-definitions, memory (app), self-update, auth (app), web-access, extension-manager, required-extension-refresh, resident-service(-renderers, -operations) | Real fs, SQLite, process or wire invariants, or pure domain rules |
| KEEP-BUT-TRIM | pi-agent (drop the hand-built fake-session tests around :148-200 and :450-500, about 500 lines; keep the SSE fixtures at :628, :714, :1328, :1549), sessions (:581 cache), session-history (:72 fabricated toolCall), domain/profile (move the agent tests), cli (decode only), sessions-cli and profiles-cli (renderer trivia), memory-write-tool (lock and backup tests if lane 4 drops them), profile-extensions (:466-771 preflight/quarantine/rollback, per lane 3), specialist (fake runner), automations and automation-scheduler (fake ChatHandle), automation-result, domain/ui-gateway, ui-server, profile-extension-tool, profile-extension-preflight, faces/* CLI tests | Real invariants mixed with fake choreography or removed machinery |
| REPLACE-BY-E2E | chat-registry (333), shared-ui-gateway (280), session-runtime-transition (352), resident-gateway (716, and the slowest file), automation-conversation-ui (670), slack-busy (161), application/profile-agents (156), wake-resident (83), serve-cli (132) | They test ChatHandle, registry or resident wiring through fakes. P3, P6, P7 and P8 prove the real behavior. |
| KEEP-BUT-TRIM, faces (reshape later) | slack-gateway (2681), discord-gateway (1641), ui-gateway (2368), gateway (404), acp (472), slack/progress, slack-tool-progress, slack-turn-progress | They test real face logic, but through 13–33 inline `ChatHandle`/`ZiggyAgent` fakes per file. Replace them with one shared `test/harness/fake-chat.ts` so a ChatHandle change touches one fake, not about 15 files (scratchpad/chathandle.txt). Delete duplicated busy and steer choreography. |
| DELETE | none outright | Deletions happen inside the trims above |

**Do the fakes test anything real?**
- In the face and gateway tests, yes: they test face routing, threading and formatting. They are the cause of the reach problem, not worthless.
- In chat-registry, shared-ui-gateway, session-runtime-transition and pi-agent's fake sessions, they mostly assert that the fake was called as scripted. They should go once the e2e proofs exist.

**Estimated removal: about 5,500–6,500 lines (about 18%).**

| Source | Lines |
|---|---|
| REPLACE-BY-E2E set | ~2,900 |
| Face fake consolidation | ~1,800 |
| pi-agent fake sessions | ~500 |
| Extension lifecycle, lock and backup trims | ~500 |
| Area trims (history, cache, profile, renderers) | ~200 |

Against that, add about 400 lines of harness and about 600 lines of e2e proofs.

**Effort:**

| Work | Size |
|---|---|
| Harness plus proofs P1–P9 (slice 0) | L (1–2d) |
| Sessions rebuild | M |
| Profiles consolidation plus the `domain/profile.ts` split | M |
| Area layers to finish and retire `runCommand` | M |
| Test triage, alongside each slice | L overall |

What ran: the eight real-Pi and area test files one at a time, all passing; the full `bun test test`, 722 pass in 17.79s; and per-file timings for all 94 files. I edited no repo files.