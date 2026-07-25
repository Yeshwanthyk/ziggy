# Ziggy stateful-system audit

Audit target: `main` at `2255e48a071514030232af3f04c4bbea3c0728ee`. I read all 2,156 lines under `src/`, `docs/research/minimal-ziggy-scout.md`, `docs/research/pi-sdk-surface.md`, the installed Pi 0.82.0 declarations, and behavior-critical source from Pi reference snapshot `8eef62ed3ea62d646a7fad92fa583fc8d71fec17`.

Pi `src/...` citations below are relative to `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent`; installed declaration citations are relative to this Ziggy checkout.

## Ranked findings

1. **Critical — shared-memory writes lose durable facts.** Every runtime can replace `MEMORY.md`; there is no single writer, lock, version, compare-and-swap, or merge. Per-chat serialization does not cover cross-chat, TUI, CLI, or automation writers. `atomicReplace` prevents a torn target but is last-writer-wins (`src/adapters/pi/pi-agent.ts:176-191,222-251`; `src/application/gateway.ts:195-246`).
2. **High — Telegram delivery is at-least-once without idempotency.** A received batch is confirmed only by the *next* `getUpdates` call. A crash after one chat replied but before that next call replays the batch and can reply twice; an outcome-unknown `sendMessage` retry can also duplicate. Terminal per-message failures are swallowed and then confirmed (`src/application/gateway.ts:141-169,213-246`).
3. **High — runtime memory is indefinitely stale.** Memory is read once while a runtime is built and embedded in `appendSystemPrompt`; a resident gateway chat never sees another runtime's later write until its handle is disposed/rebuilt. A stale runtime can later overwrite the newer document (`src/adapters/pi/pi-agent.ts:272-299,357-410`; `src/application/gateway.ts:205-213`).
4. **High — the wake gate fails open and trigger provenance is absent.** A configured gate's non-zero exit prevents a model call, but spawn failure and timeout log and proceed. Today's only caller is the user-invoked `ziggy wake`, so it satisfies the invariant through user input; the service cannot enforce the same invariant for a future non-user scheduler because it receives no trigger provenance or passed-gate token (`src/application/automations.ts:72-128,155-179`; `src/main.ts:154-162`).
5. **Medium — Pi JSONL is append-only, not crash-atomic or multi-writer-safe.** Pi appends one JSON line synchronously with no session lock or fsync; malformed tails are silently skipped. A partial tail can hide the interrupted entry and the first later append. Same-file concurrent runtimes can create a valid but semantically interleaved tree (Pi `src/core/session-manager.ts:490-525,845-1043`).
6. **Medium — registry and Pi configuration have weaker crash/concurrency properties than their authority requires.** Registry read/check/append can duplicate and its cleanup rewrite can race an append. Pi locks `auth.json` and settings across processes, but writes them in place rather than by atomic rename; models and channel/automation config are operator-written with no Ziggy validation-at-write boundary (`src/application/profiles.ts:127-199`; Pi `src/core/auth-storage.ts:31-141`, `src/core/settings-manager.ts:188-249,578-623`).

## Authoritative state

“Writer” is the intended logical owner. Where several instances of that writer can act concurrently, single-writer ownership is not enforced.

| State | Class | Logical writer / reader | Freshness and enforcement |
|---|---|---|---|
| `<profile>/SOUL.md` | stored authority | Human owns content; `initProfile` may create once with `wx`; Pi resource loader reads | Existing content is never overwritten. Loaded into each runtime; gateway handles have no reload path (`src/application/profiles.ts:94-125`; `src/adapters/pi/pi-agent.ts:369-410`). |
| `MEMORY.md` | stored authority | Any admitted `memory_write` tool replaces it; humans can also edit | Atomic target replacement and cap-on-tool-write, but no lock/CAS. Loaded once per runtime. Oversized human content is not rejected on read (`src/domain/memory.ts:73-112`; `src/adapters/pi/pi-agent.ts:176-299`). |
| `memory/users/<id>.md`, `memory/groups/<id>.md` | stored authority | Context-bound `memory_write`; humans can edit | Same LWW/freshness behavior. Local person maps to `users/owner.md`, while Telegram owner maps to `users/<numeric-id>.md`, creating two person authorities unless identity is reconciled (`src/domain/memory.ts:79-109`). |
| `<profile>/sessions/*.jsonl` | stored authority | Pi `SessionManager` for TUI/run | Direct-child sessions only. Intended one runtime per file; no cross-process lock. Append-only tree is authoritative history (`src/adapters/pi/pi-agent.ts:302-355,545-567`). |
| `sessions/telegram/<chat-key>/*.jsonl` | stored authority | One gateway `ChatHandle` per chat in one process | Per-chat semaphore serializes prompts; directories isolate chats. No gateway/profile singleton lock (`src/application/gateway.ts:187-246`). |
| `sessions/automations/<id>/*.jsonl` | stored authority | Each wake creates a fresh Pi session | Concurrent wakes create distinct UUID-named session files in the same id directory (`src/application/automations.ts:155-193`; `src/adapters/pi/pi-agent.ts:505-543`). |
| `~/.ziggy/profiles.list` | stored authority/index | `Profiles.registerProfile` appends; `listProfiles` rewrites stale entries | It is both registry authority and rebuildable index from `profiles/`; write paths are not mutually serialized (`src/application/profiles.ts:127-206`). |
| `auth.json` | stored authority | Pi credential store; operator bootstrap | Pi uses `proper-lockfile`; live runtimes share the file-backed credential authority. In-place writes remain crash-vulnerable (Pi `src/core/auth-storage.ts:31-141`). |
| `models.json` | stored authority | Operator configuration; Pi `ModelRuntime` reads | Loaded at runtime construction; existing handles do not reload it. `models-store.json` is a sibling Pi catalog cache, not model-selection authority (`docs/research/pi-sdk-surface.md:283-316`). |
| `settings.json` and `.pi/settings.json` | stored authority | Pi `SettingsManager`, primarily TUI controls | Cross-process lock plus modified-field merge prevents ordinary lost updates. Each manager's reads remain cached until `reload`; Ziggy does not call it (`docs/research/pi-sdk-surface.md:283-316`; Pi `src/core/settings-manager.ts:308-316,479-504,578-623`). |
| `telegram.json` | stored authority | Operator writes; gateway reads | Decoded once before `runLoop`; changes require restart (`src/application/gateway.ts:55-98`; `src/main.ts:164-173`). |
| `automations/*.md` | stored authority | Operator writes; `wake` reads | Read and decoded fresh for every wake; no persisted run/claim/result state (`src/application/automations.ts:45-65,155-194`). |
| Resolved paths, `ChatContext`, selected memory docs | derived | Ziggy domain/application code | Recomputed at command/update boundaries (`src/domain/profile.ts:47-68`; `src/application/gateway.ts:100-130`). |
| Runtime system prompt, model/settings objects, gateway handles/semaphores, Telegram offset | cached volatile | Pi runtime / gateway process | Prompt/config cache lasts for the runtime; offset starts at 0 on each process; chat cache lasts for gateway lifetime (`src/adapters/pi/pi-agent.ts:357-410`; `src/application/gateway.ts:187-246`). |
| TUI transcript, stdout, logs, Telegram replies, `profiles` output | displayed/projection | Faces and Telegram | Not authoritative and not sufficient to prove persisted state (`src/main.ts:97-183`; `src/application/gateway.ts:213-223`). |

## Transition model

| Transition | Trigger / actor / precondition | Write and publication | Replay and recovery |
|---|---|---|---|
| Initialize profile | `ziggy init`; operator; target absent or directory | `SOUL.md` via exclusive create, then best-effort registry append; stdout publishes result | Rerun preserves SOUL. A race loser may get `EEXIST`; registry failure is ignored (`src/main.ts:103-119`). |
| Build runtime | TUI/run/chat/wake; face; valid SOUL and context ids | Reads SOUL, memory, auth/models/settings; publishes a cached Pi runtime | Dispose/rebuild refreshes state. No gateway reload/invalidation publication exists. |
| Execute turn | User prompt, authorized update, or wake; Pi session | Pi appends JSONL and executes provider/tool effects; face publishes reply | Session history can resume, but there is no durable turn id or effect idempotency. |
| Replace memory | LLM `memory_write`; scope admitted and under cap | Write unique temp, rename over target, publish tool result into session | Failure cleans temp only while process lives. Crash leaves old or new target, possibly an orphan temp; no merge/retry contract. |
| Poll and dispatch | Gateway; Bot API batch; owner/text filter | RAM offset advances, per-chat turn/session/memory effects run, Telegram reply publishes | Next poll confirms prior batch. Crash before it replays the whole unconfirmed batch. |
| Wake automation | `ziggy wake`; operator; valid file | Optional gate, fresh session, possible memory replace and Telegram delivery | No persisted claim/status. Concurrent/retried wakes are independent duplicate effects. |
| Mutate settings/auth | Pi/TUI/provider refresh; valid parse | Locked read-modify-write; UI/model behavior publishes | Other live managers remain stale; crash during in-place write has no atomic rollback. |
| List/clean registry | `ziggy profiles`; operator | Reads registry plus profile dirs; may rewrite registry; prints projection | Directory discovery recovers named profiles, but external paths lost by a racing cleanup need re-registration. |

## Invariants and missing enforcement points

| Invariant | Present enforcement | Missing enforcement |
|---|---|---|
| No durable fact has two writable authorities | Memory paths are scope-derived; group cannot write person memory and vice versa (`src/adapters/pi/pi-agent.ts:194-220`). | Many runtimes write each document; local `owner.md` and Telegram numeric user memory split one person; tool arguments/facts also remain durably in Session. No versioned memory command defines one accepted successor. |
| Session owns history; Memory owns facts | Pi exclusively formats session JSONL; memory tool exclusively targets markdown. | The separation is prompt policy only. No semantic boundary prevents treating transcript facts as authority, and no identity/version metadata links a memory fact to its accepted write. |
| No LLM call without user input or passed wake-gate | TUI/run require input; gateway requires an owner-authored text update; current wake is explicitly invoked by the user; non-zero gate exits before `openChat`. | `Automations.wake` carries no trigger provenance or passed-gate token. A future scheduler could call it after a missing/failed/timed-out gate and still reach `handle.prompt` (`src/application/automations.ts:161-179`). |
| Client disconnect is not cancellation | Telegram client connectivity is decoupled from the in-process model turn; reply delivery happens afterward. | There is no durable accepted-turn state, reconnect/replay protocol, or attach face. Gateway death cancels ownership; local TUI/run still open independent runtimes even while gateway is resident (`src/main.ts:136-182`). |
| Gateway exclusively owns live sessions once resident | Per-chat handles are owned by the gateway process. | No profile lease/process lock and no CLI/TUI routing check. The architectural ownership transition in `minimal-ziggy-scout.md:9,69` is not implemented. |
| Memory is bounded and context-isolated | Tool writes enforce code-point caps and group/person admission. | Reads do not enforce caps; human edits bypass them. Long-lived cached prompts violate explicit freshness, and shared-memory writes are not serialized. |

## Concrete scenarios

### a. Gateway plus owner TUI on the same profile — **LOST-DATA**

TUI creates a new direct-child file under `<profile>/sessions`; each gateway chat continues only its own nested directory, so these session writes do not target the same JSONL. Pi has no profile/session-directory lock, but this layout alone does not corrupt files (`src/adapters/pi/pi-agent.ts:505-567`; `src/application/gateway.ts:203-215`). Both runtimes can replace shared memory, so concurrent curation loses one writer. Pi locks settings/auth writes, but both runtimes cache SOUL/models/settings/memory, so later edits merely surprise existing handles.

Minimal fix: acquire one profile runtime lease when a gateway starts and route local faces through it; independently put version/CAS serialization around each memory document.

### b. Two Telegram chats writing shared memory — **LOST-DATA**

Chat A and chat B have different semaphores, so `Effect.forEach(..., concurrency: "unbounded")` runs them concurrently (`src/application/gateway.ts:195-246`). Both runtimes were built from `M0`. A writes `M0 + A` to a unique temp and renames; B writes `M0 + B` and renames later. Both tools report success, but final state is `M0 + B`. Even if A finishes first, a long-lived B still holds `M0` in `appendSystemPrompt`, so its later full-document replacement erases A: this is a stale-snapshot lost update, not a torn write. Blast radius is all future contexts that load shared `MEMORY.md`; per-person/group documents are affected only when another runtime targets that same path.

Minimal fix: make `memory_write` accept an observed version/hash and fail on mismatch, then reload and retry/merge through one profile memory service.

### c. Gateway restart and Telegram offset — **DUPLICATE-EFFECT**

`runLoop` starts `offset = 0`, receives a batch, computes the next offset, processes the whole batch, and only then makes another poll (`src/application/gateway.ts:230-246`). Telegram says updates remain unconfirmed until `getUpdates` is called with an offset higher than their `update_id`; confirmed updates are not replayed, and server retention is at most 24 hours ([Bot API](https://core.telegram.org/bots/api#getupdates)).

- Crash mid-turn: no higher-offset call occurred, so the update is replayed after restart.
- Crash after a reply but before the next poll: the whole unconfirmed batch is replayed, including chats that already replied, producing double replies/tools/memory writes.
- Once the next higher-offset request reaches Telegram, the previous batch is confirmed even if its response is lost; processing already completed before that request.
- A terminal provider/send failure is caught per message, then the next poll confirms it: the input is lost without a reply. A retried `sendMessage` whose first request succeeded but response was lost can itself double-send.

Minimal fix: persist update/turn states (`received → effects committed → reply sent → confirmed`) keyed by `update_id`, make tools/delivery idempotent, and resume incomplete states before advancing confirmation.

### d. `ziggy run -c` while gateway is resident — **SURPRISING**

`run -c` calls `SessionManager.continueRecent(profilePath, <profile>/sessions)` (`src/adapters/pi/pi-agent.ts:302-320`). Installed declarations expose that API (`node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:19`; `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:318-331`). Pi's implementation uses non-recursive `readdirSync`, keeps direct `.jsonl` children with matching header cwd, and chooses greatest file mtime. It cannot select `sessions/telegram/**` or `sessions/automations/**` (Pi `src/core/session-manager.ts:635-655,1557-1565`). “Most recent” therefore means most recently modified root local session, not gateway chat, stable main, or most recent conversation anywhere.

Minimal fix: replace mtime discovery with an explicit stable local-session identity/pointer and reject opening a session with an active writer lease.

### e. Automation wake concurrent with gateway chat — **LOST-DATA**

Automation uses `"fresh"` in `sessions/automations/<id>` while the gateway uses `sessions/telegram/<chat-key>`, so session files are isolated (`src/application/automations.ts:172-177`; `src/adapters/pi/pi-agent.ts:505-520`). Both runtimes can write shared memory and race exactly as in b. Automation local person memory is `users/owner.md`, distinct from the Telegram owner's numeric user file, so those do not collide—but they split person authority. Concurrent wakes of the same id create separate fresh files and can duplicate external delivery.

Minimal fix: serialize/CAS shared memory at profile scope, unify owner identity, and persist an idempotent wake/run id.

### f. Two `ziggy init` processes on the same name — **SURPRISING**

SOUL creation is safe from clobber because `writeFile(..., { flag: "wx" })` permits one winner (`src/application/profiles.ts:94-125`). Depending on timing, the loser either returns “already initialized” or fails `EEXIST`. If both reach registration, each can read the same registry snapshot, pass the absence check, and append the same path, leaving duplicate valid lines (`src/application/profiles.ts:127-150`). Separately, `listProfiles` can truncate/rewrite a stale registry while an append races and lose an external profile entry (`:152-199`).

Minimal fix: lock the registry around read/modify/write and make init treat a post-check `EEXIST` SOUL as an idempotent race loss after verifying it is a file.

### g. Crash during memory/session persistence — **LOST-DATA**

Memory target replacement is crash-safe against partial target content: before rename the old target remains; after same-filesystem rename the new complete file is visible. A process crash before rename leaves `.<uuid>.memory-write.tmp`; promise-error cleanup at `src/adapters/pi/pi-agent.ts:187-190` cannot run. There is no file/directory fsync, so power-loss durability is not guaranteed.

Pi initially flushes a session with exclusive create and sequential line writes, then uses synchronous `appendFileSync` per entry, with no fsync or lock (Pi `src/core/session-manager.ts:979-1043`). A crash can leave a partial final JSON line. Pi's loader silently skips malformed lines (`:490-525`); because it does not truncate the bad tail, the first future append can concatenate with that partial line and also be skipped on the next load. Before the first assistant message, Pi may not have flushed the session at all.

Minimal fix: on open, detect and quarantine/truncate only an invalid final tail to the last newline; add durability policy (`fdatasync` when required) and forbid concurrent writers per session file.

## Multi-person 1:1s and groups

Today `normalizeUpdate` silently drops every message whose `from.id` is not `ownerUserId` (`src/application/gateway.ts:100-107`). Private chat routing already derives `chatKey`, session directory, and `ChatContext.userId` from the sender. Multi-person 1:1 support therefore needs an explicit allowlist/identity registry and authorization result, not just removal of the owner check.

Groups need a richer inbound context containing both group id and sender id for attribution and policy while still loading only group memory; the current group `ChatContext` discards sender identity (`src/application/gateway.ts:118-126`; `src/domain/memory.ts:7-10`). One group semaphore correctly orders the shared transcript, but it is only process-local.

More people multiply independent private-chat runtimes writing `MEMORY.md`, so scenarios a, b, c, and e become more frequent. Per-user documents partition most personal writes, but shared memory remains an N-writer LWW register; group memory remains safe only under one gateway process. A multi-person design also needs one canonical mapping from local owner and Telegram identity to eliminate `owner.md` versus numeric-id split, plus durable update/turn idempotency before expanding authorization.

## Proof directions

The smallest acceptance tests are: (1) two runtimes write from the same memory version and exactly one receives a conflict; (2) crash after Telegram reply but before confirmation and restart produces no second tool or reply effect; (3) gate timeout/spawn failure produces zero model calls; (4) `run -c` resolves an explicit stable id and refuses an active writer; (5) reopen a JSONL with a partial tail, repair it, append once, and retain that append; (6) 100 concurrent same-profile init/register operations yield one SOUL and one registry entry.
