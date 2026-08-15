# Open Ziggy readiness: JSON CLI, memory support, UI gateway, ACP

Status: implementation in progress
Date: 2026-08-15
Owner decision record: chat "opening Ziggy for others" (2026-08-15)

## How to use this packet

Implement the chunks in order. Each chunk ships alone, has its own commit(s), and has a
demo you can run. Before you start any chunk:

- Read `AGENTS.md` and follow it. `bun run check` must pass before every commit.
- Read `.agents/skills/effect-runtime-boundaries/SKILL.md`,
  `.agents/skills/effect-schema-boundaries/SKILL.md`, and
  `.agents/skills/effect-typed-errors/SKILL.md` before touching Effect code.
- Tests live in `test/` mirroring `src/` and import through `ziggy/...` exports.
- Update `LOG.md` per chunk. Never overwrite human-owned Profile files (`SOUL.md`,
  `MEMORY.md` content, and so on).
- Line numbers in this doc were verified on 2026-08-15. If they drifted, search for the
  named symbol.

## Orientation

Ziggy is a folder that is an assistant. The core is done: profiles, memory, sessions,
extensions, gateways (Telegram/Discord/Slack), automations, and profile agents all work.
The gap is access: today the only clients are the Pi TUI, one-shot `ziggy run`, and the
three chat channels. There is no way for a custom UI (a desktop app, a web page, an IDE)
to talk to Ziggy.

The good news: the in-process API already has the right shape.
`ZiggyAgent.openChat` returns a `ChatHandle` with `prompt`, `abort`, `steer`,
`followUp`, and `subscribe` (`src/application/agent.ts:22-71,97`). The three channel
gateways already consume it. So a UI gateway is a new **face** that translates a wire
protocol onto an API that exists. It is not a re-architecture.

This packet delivers six chunks:

1. MIT license.
2. Machine-readable CLI (`--json`, JSON print mode, resume by session id).
3. Memory and init support (scaffolding, docs, inspect commands, write backups).
4. A WebSocket server face inside `ziggy serve` (the keystone).
5. `ziggy acp` — an ACP stdio face (Buzz + Zed compatibility).
6. A TypeScript gateway client package plus a tiny example web page.

A desktop reference app comes after this packet, as a thin client on chunks 3 and 5.

## Settled decisions

These were decided by the owner. Do not re-open them.

- **License:** MIT.
- **Skip for now:** PR CI, Linux/Intel binaries, Telegram ops doc, npm publishing,
  channel setup wizard, multi-user identity.
- **Do not use Pi `runRpcMode` as the UI gateway.** It wraps one Pi runtime over stdio
  and knows nothing about profiles, memory scopes, or channel sessions. Spawning it
  would also create a second writer on session files. The UI gateway forwards events
  from live `ChatHandle`s inside the `serve` process instead. Never stream by tailing
  JSONL files.
- **Wire framing:** simple JSON frames over WebSocket (JSON-RPC style: request id +
  method + params, plus pushed event frames). Not the formal JSON-RPC 2.0 spec.
- **No approval/clarify protocol.** Tools run yolo, matching current behavior.
  `*.respond` RPCs can come later.
- **Channel sessions are watch-only** from the UI in v1. The UI chats in its own
  sessions under `sessions/ui/`.
- **`USER.md`:** mark as deferred in the spec. Do not implement.
- **Client package lives in-repo** as an isolated package (same pattern as
  `extensions/*`), not a workspace member. The spec rejects multi-package workspaces;
  isolated folders with their own `package.json` are the established exception.

## Scope and constraints

- Architecture rules hold: faces -> application -> domain. Pi imports only under
  `src/adapters/pi/`. Bun APIs (like `Bun.serve`) only under `src/adapters/bun/`.
  Only `src/main.ts` executes Effects in production.
- Decode all external input (CLI args, WebSocket frames, stdio JSON) once with Effect
  Schema at the boundary. Expected failures are `Schema.TaggedErrorClass` values in the
  typed error channel.
- One live owner per profile stays true. The UI server runs inside the `serve` process
  and dies with it.
- No changes to the memory model, session authority, or extension system beyond what
  each chunk states.

## Target flow (after chunk 4)

```
ziggy serve <profile>
  ├─ automation scheduler            (existing)
  ├─ telegram/discord/slack loops    (existing; now register handles in ChatRegistry)
  └─ UI gateway server               (new)
       ├─ Bun.serve WebSocket on 127.0.0.1:<ephemeral>
       ├─ writes <profile>/.runtime/ui-server.json {port, token} mode 600
       ├─ RPC: session.list / session.open / prompt.submit /
       │        session.steer / session.abort / session.watch
       └─ pushes ChatEvent frames from ChatHandle.subscribe

Any UI (web page, desktop app) reads ui-server.json, connects, authenticates
with the token, and is a thin client. `ziggy acp` is a separate stdio face
over the same ZiggyAgent core for IDE/Buzz harnesses.
```

---

## Chunk 0 — MIT license

**Behavior delivered:** the repository has an explicit MIT license.

**Work:**
- Add `LICENSE` at the repo root with the standard MIT text, copyright
  `2026 Yeshwanthyk`.
- Add a `"license": "MIT"` field to `package.json`.

**Verification:** file exists; `bun run check` passes.

**Risk:** low.

---

## Chunk 1 — Machine-readable CLI

**Behavior delivered:** scripts and UIs can consume Ziggy state without scraping text.
Three parts: `--json` on list/show commands, JSON streaming on `ziggy run`, and resume
by session id.

### 1a. `--json` on list/show commands

Add a `--json` flag to these commands:

| Command | Face module today |
|---|---|
| `ziggy profiles` | `src/main.ts` (Profiles case) |
| `ziggy sessions list\|show` | `src/faces/sessions-cli.ts` |
| `ziggy agents list\|show` | `src/faces/agents-cli.ts` |
| `ziggy automations list\|status\|runs` | `src/faces/automation-cli.ts` |
| `ziggy extensions list\|show` | `src/main.ts` (Extensions case) |

**Files and symbols:**
- `src/faces/cli.ts` — `decodeCliCommand` (line ~385): parse `--json` into a boolean on
  the relevant command variants. Update `renderHelp` (line ~444).
- Each face module gets a JSON renderer next to its text renderer. Output one JSON
  document to stdout (an array for lists, an object for shows). Nothing else on stdout
  when `--json` is set.
- Define the output shape with Effect Schema in the face module and encode through it,
  so the shape is explicit and stable. Reuse existing domain/application types as the
  source (see `.agents/skills/effect-schema-inferred-types/SKILL.md`).
- `sessions show --json` stays metadata-only (no transcript). That invariant is spec
  (`docs/research/minimal-ziggy-scout.md`, transcript-free sessions).

### 1b. `ziggy run --json`

Pi ships an NDJSON print mode that Ziggy does not use. `askOnce` hardcodes
`mode: "text"` (`src/adapters/pi/pi-agent.ts`, ~line 614, search `runPrintMode`).

**Work:**
- Add `--json` to `ziggy run` in `decodeCliCommand`.
- Plumb an output mode (`"text" | "json"`) through `ZiggyAgent.runOnce`
  (`src/application/agent.ts:86`) into the Pi adapter, and pass it to Pi
  `runPrintMode`. Pi then emits NDJSON events on stdout.
- Document in help text that JSON mode emits Pi-owned event lines (schema belongs to
  Pi 0.84.1; see `docs/research/pi-sdk-surface.md`, print mode section).

### 1c. `ziggy run --session <id>`

Today `run -c` only continues `sessions/local/main/`.

**Work:**
- Add `--session <id>` to `ziggy run`. Reject combining `-c` and `--session`.
- Resolve id -> exact session JSONL path through the existing `Sessions` application service
  (`src/application/sessions.ts`; metadata includes id and path — see
  `src/adapters/pi/sessions.ts:342-410`). Unknown id is a typed error with a clear
  message.
- Open that exact JSONL path with Pi's `SessionManager.open`. Do not reduce the selection to its
  containing directory or use `continueRecent`; more than one transcript can share a directory.

**Execution path:** CLI face -> `Sessions.list` (resolve) -> `ZiggyAgent.runOnce`.

**Dependencies:** none.

**Verification:**
- Unit: `test/faces/cli.test.ts` (or nearest existing CLI decode test) — `--json` and
  `--session` parse; `-c --session` rejected.
- Unit: JSON output encodes through its schema (round-trip test on one list command).
- Manual, against a scratch profile:
  ```sh
  bun src/main.ts init scratch --minimal
  bun src/main.ts profiles --json | jq .
  bun src/main.ts sessions list scratch --json | jq .
  bun src/main.ts run scratch "say hi" --json   # NDJSON lines
  bun src/main.ts sessions list scratch --json  # grab an id
  bun src/main.ts run scratch --session <id> "continue"
  ```

**Risk:** low. Additive flags. Watch that JSON mode writes nothing else to stdout
(logs/warnings must go to stderr).

---

## Chunk 2 — Memory and init support

**Behavior delivered:** a new user can see, understand, and recover memory. Four parts:
init scaffolding, a format doc, `ziggy memory` commands, and automatic write backups.

Background (verified): memory is `§`-delimited markdown
(`MEMORY_ENTRY_DELIMITER` at `src/domain/memory.ts:6`), capped at 2,200 code points
shared / 1,375 per context (`src/domain/memory.ts:4-5`). Admission is computed by
`memoryFilePaths` (`src/domain/memory.ts:242`). Writes go through the `memory_write`
tool in `src/adapters/pi/pi-agent.ts` (~line 410) under a per-document SQLite lock
(~line 315) with temp-file + rename publish (~line 285). `ziggy init` creates only
`SOUL.md` (`src/application/profiles.ts:150-201`).

### 2a. Init scaffolding

**Work in `src/application/profiles.ts` (init path):**
- On non-`--minimal` init, also create when missing (never overwrite existing files):
  - `MEMORY.md` — empty file. Do not put explanatory text in it: its content is
    injected into every prompt.
  - `memory/users/` and `memory/groups/` directories.
  - `memory/README.md` — short format explanation and a pointer to the ops doc.
    This file is safe: `memoryFilePaths` never loads it.
- Keep init idempotent. Re-running init on an existing profile must not touch
  existing files (this is a spec invariant; there are existing init tests to extend in
  `test/application/profiles.test.ts`).

### 2b. Format documentation

**Create `docs/operations/memory.md`:**
- The three scopes and which files load in which chat context (local / 1:1 / group),
  including the rule that person memory never loads in groups.
- The `§` delimiter: one entry per block, entries separated by a line with `§`.
- Caps: 2,200 code points shared, 1,375 per context file. Writes that would exceed the
  cap are rejected, never truncated.
- How the agent writes: the `memory_write` tool (add / replace / remove, all-or-nothing).
- Hand-editing guidance: safe, but keep the delimiter intact; run `ziggy doctor` after.
- Where backups live and how to restore (see 2d).
- Link it from `README.md` alongside the other operations docs.

### 2c. `ziggy memory` commands

**New face `src/faces/memory-cli.ts`, new application service
`src/application/memory.ts`:**
- `ziggy memory list [<profile>]` — for each memory document that exists (shared,
  each user file, each group file): path, entry count, code points used vs cap. With
  `--json` (reuse chunk 1 pattern).
- `ziggy memory show <profile> <scope>` — print the entries of one document with
  indexes. Scope syntax: `shared`, `user:<id>`, `group:<id>`.
- The application service composes `memoryFilePaths` / `splitEntries` logic from
  `src/domain/memory.ts` with filesystem reads. Reading logic may need a small
  extraction from the Pi adapter (`readMemoryDocument` in `pi-agent.ts`, ~line 448) into
  the application or domain layer so the CLI does not import from `adapters/pi`
  internals — follow the dependency rules.
- Wire the new commands in `src/faces/cli.ts` and `src/main.ts`.

### 2d. Write backups

**Work in the locked write path in `src/adapters/pi/pi-agent.ts`:**
- Inside the per-document lock, before publishing the new content: if the file exists,
  copy its current content to
  `<profile>/.runtime/memory-backups/<sanitized-relative-path>/<ISO-timestamp>.md`.
  Sanitize the relative path by replacing `/` with `__`.
- Prune to the newest 10 backups per document after writing.
- Backup failure must fail the write (better to refuse than to lose recovery), as a
  typed error.
- Restore is manual and documented: `cp` the backup over the memory file, then run
  `ziggy doctor`.

### 2e. Spec annotation

- In `docs/research/minimal-ziggy-scout.md`, find the `USER.md` mention (~line 15) and
  add a one-line annotation: `(deferred — not implemented; see docs/plans/open-ziggy-readiness.md)`.
  Do not rewrite anything else in the spec.

**Dependencies:** chunk 1 (`--json` plumbing pattern) is helpful but not required.

**Verification:**
- Unit: init scaffolds the new files; re-init leaves existing content alone
  (`test/application/profiles.test.ts`).
- Unit: backup file appears on `memory_write`; 11th write prunes the oldest
  (extend `test/adapters/pi/memory-lock.test.ts`).
- Unit: `memory list` usage math counts code points, not UTF-16 units
  (`test/application/memory.test.ts`).
- Manual:
  ```sh
  bun src/main.ts init scratch2
  ls ~/.ziggy/profiles/scratch2/memory/     # users/ groups/ README.md
  bun src/main.ts run scratch2 "remember that my favorite color is green"
  bun src/main.ts memory list scratch2
  ls ~/.ziggy/profiles/scratch2/.runtime/memory-backups/
  ```

**Risk:** medium-low. The backup step adds I/O inside the lock; keep it a single read +
single write. Do not change entry semantics in `src/domain/memory.ts`.

---

## Chunk 3 — UI gateway server inside `ziggy serve` (keystone)

**Behavior delivered:** any local program can connect to a running `ziggy serve` over
WebSocket, list live and stored sessions, open its own chat sessions, stream events,
and watch channel traffic live.

### Design

Four new modules, one per layer:

| Layer | File | Owns |
|---|---|---|
| Domain | `src/domain/ui-gateway.ts` | Protocol schemas and typed errors |
| Application | `src/application/chat-registry.ts` | Registry of live `ChatHandle`s |
| Application | `src/application/ui-gateway.ts` | RPC method orchestration |
| Adapter | `src/adapters/bun/ui-server.ts` | `Bun.serve` WebSocket transport, token file |

Plus a small wiring change in `src/application/resident-gateway.ts` and handle
registration calls in the three channel gateways.

### 3a. Protocol (`src/domain/ui-gateway.ts`)

Define with Effect Schema. Frames are JSON text messages over the WebSocket.

Client -> server request:
```json
{ "id": "r1", "method": "prompt.submit", "params": { "session": "ui/main", "text": "hi" } }
```

Server -> client response (one per request):
```json
{ "id": "r1", "ok": true, "result": {} }
{ "id": "r1", "ok": false, "error": { "code": "watch_only", "message": "..." } }
```

Server -> client pushed event (no id):
```json
{ "event": "assistant-text", "session": "discord/123456", "payload": { "delta": "...", "snapshot": "..." } }
```

Methods (v1, complete list):

| Method | Params | Result | Notes |
|---|---|---|---|
| `ping` | `{}` | `{ "pong": true }` | liveness |
| `session.list` | `{}` | `{ live: [...], stored: [...] }` | live from ChatRegistry (key, kind, idle); stored from `Sessions` metadata |
| `session.open` | `{ name }` | `{ session: "ui/<name>" }` | atomically opens/attaches a UI session; auto-subscribes this socket |
| `session.watch` | `{ session }` | `{}` | subscribe to any live session's events; watch-only |
| `prompt.submit` | `{ session, text }` | `{}` | ack-only; output arrives as events; UI sessions only |
| `session.steer` | `{ session, text }` | `{}` | UI sessions only |
| `session.abort` | `{ session }` | `{}` | UI sessions only |

UI session names must match `[a-z0-9](?:[a-z0-9._-]{0,63})?`. Reject absolute paths,
separators, `.`/`..`, percent-decoded traversal, and all other names before registry or filesystem
use. Watch keys are bounded exact registry keys; clients should obtain them from `session.list`
rather than construct them. Session keys are directory paths relative to `<profile>/sessions/`, for example
`ui/main`, `discord/<chatKey>`, `local/main`.

Event names and payloads mirror the existing `ChatEvent` union
(`src/application/agent.ts:22-46`): `assistant-text`, `thinking`, `tool`, `voice`,
`settled`, `error`. The event envelope removes only `kind`; for example, `assistant-text` has
`{ delta, snapshot }`. Encode each variant with a schema; do not invent new event types.

Error codes (typed): `unauthorized`, `unknown_method`, `bad_params`,
`unknown_session`, `watch_only`, `session_busy`, `not_streaming`,
`capacity_exceeded`, `internal`.

### 3b. ChatRegistry (`src/application/chat-registry.ts`)

An in-memory service (Effect service with a `Ref`/`SynchronizedRef` map):

- `register(key, { handle, kind })` where kind is
  `"telegram" | "discord" | "slack" | "ui"`.
- `unregister(key)`, `get(key)`, `list()`.
- `getOrOpenUi(key, open)` is atomic. Concurrent `session.open` calls for one key must create one
  handle and one per-session semaphore, never two writers.
- A bounded serve-scoped fiber registry owns UI openings and prompt fibers. Do not hold the
  registry lock while `openChat` or `prompt` runs. Limit registry-owned UI sessions to 32; do not
  add idle eviction in v1.

Wire registration into the three channel gateways at the point where each creates a
`ChatHandle`:
- Telegram: `src/application/gateway.ts` (~line 180, `agent.openChat` call).
- Discord: `src/application/discord-gateway.ts` (~line 839).
- Slack: `src/application/slack-gateway.ts` (~line 1222).

Register after open, unregister on dispose. Keep the registry optional-safe: gateways
must not fail if registration fails; log and continue.

### 3c. Transport (`src/adapters/bun/ui-server.ts`)

- `Bun.serve` bound to `127.0.0.1`, port `0` (ephemeral), with a 64 KiB frame limit,
  256 KiB backpressure limit, 16 active request handlers per socket, and duplicate request-id
  rejection. Reject binary frames; fail closed on queue or request overflow.
- On start, generate a token (32 random bytes, hex) and write
  `<profile>/.runtime/ui-server.json` atomically with
  `{ "version": 1, "port": <n>, "token": "<hex>" }`, file mode `0o600`. Validate that
  `.runtime` is physical and not a symlink. On shutdown, delete only a projection whose token
  still matches this server. A stale crash projection is discovery data, not liveness proof.
- WebSocket upgrade on path `/ws`. Authentication: require the token either as an
  `Authorization: Bearer <token>` header on the upgrade request or as a `?token=`
  query parameter. If both are present, require equality. Compare fixed-length tokens with
  `timingSafeEqual`, reject unauthorized upgrades with HTTP 401, and never log credentials.
- The adapter exposes an Effect-shaped surface (start/stop scoped, callbacks to the
  face for message frames). Follow
  `.agents/skills/effect-runtime-boundaries/SKILL.md` for adapting Bun's callback API;
  the Discord/Slack socket adapters (`src/adapters/discord/socket.ts`,
  `src/adapters/slack/socket.ts`) are the in-repo precedent for socket lifecycle
  handling.

### 3d. Orchestration (`src/application/ui-gateway.ts`)

- Decode each incoming frame once with the domain schemas. Malformed frame -> error
  response (`bad_params`) if an id can be recovered, else drop and log.
- `session.open`: validate the single-segment name, then use the registry's atomic get-or-open with
  `agent.openChat(target, { kind: "local" }, join(profilePath, "sessions", "ui", name))`
  and mode `"continue"`. Register with kind `"ui"`. Subscribe the socket. UI sessions use local
  context, so memory admission is shared + owner — correct, because the UI operator is the owner.
- `session.watch`: look up in ChatRegistry, subscribe the socket to the handle's
  events, forward as event frames. Never call prompt/steer/abort on non-`ui` handles
  (`watch_only` error). Events are future-only in v1; reconnect creates an explicit stream gap,
  then the client reopens or rewatches.
- Per-UI-session serialization: one in-flight prompt per session, owned by the registry entry and
  shared by all sockets. `prompt.submit` admits a serve-owned prompt fiber under that semaphore and
  then acknowledges; it does not wait for completion. The fiber publishes `settled` or `error` and
  survives the submitting socket closing.
- Socket close: unsubscribe that socket everywhere. Do not dispose UI handles or interrupt admitted
  prompts. The serve scope owns UI handles until shutdown, when it disposes each handle exactly once.
- Wire as a new branch in `ResidentGateway.run`
  (`src/application/resident-gateway.ts:95-153`), next to the scheduler and channel
  loops, so it starts with serve and stops with it. A crash in the UI branch must not
  take down channel loops — copy the error-handling shape of the existing branches.
- Allocate the registry after the serve owner lease is acquired. On shutdown, stop sockets and
  subscriptions, interrupt registry fibers, dispose registry-owned UI handles, conditionally
  remove the server projection, and only then release the owner lease. Channel loops retain
  ownership of their own handles and unregister aliases before disposal.

**State ownership:** the serve process remains the single owner of live sessions.
Clients own nothing; they are subscribers plus prompt-submitters on `ui/*` sessions.

**Dependencies:** chunk 1 is independent; chunk 2 is independent. Do 3a -> 3b -> 3c -> 3d.

**Verification:**
- Unit: protocol schemas — decode good frames, reject bad ones
  (`test/domain/ui-gateway.test.ts`).
- Unit: ChatRegistry register/list/unregister/idempotent unregister
  (`test/application/chat-registry.test.ts`). Also prove concurrent open creates one handle,
  failed open is retryable, capacity is bounded, stale unregister cannot remove a replacement,
  and disconnect does not abort or dispose an admitted prompt.
- Unit: ui-gateway method dispatch against a stubbed `ZiggyAgent` — auth handled at
  transport, `watch_only` enforced, unknown session error
  (`test/application/ui-gateway.test.ts`). The existing gateway tests show how to stub
  the agent layer.
- Manual demo:
  ```sh
  bun src/main.ts serve scratch2         # foreground
  cat ~/.ziggy/profiles/scratch2/.runtime/ui-server.json
  # with websocat (or the chunk-5 web page):
  websocat "ws://127.0.0.1:<port>/ws?token=<token>"
  {"id":"1","method":"ping","params":{}}
  {"id":"2","method":"session.open","params":{"name":"main"}}
  {"id":"3","method":"prompt.submit","params":{"session":"ui/main","text":"hello"}}
  # expect assistant-text ... settled events
  ```
  If a channel is configured, send a Discord/Slack message and confirm
  `session.list` shows it live and `session.watch` streams its events.

**Risk:** the highest of the packet. Contain it: the UI branch must supervise its own
failures; token file must be 0600; server must bind loopback only; frame, queue, request, and
session counts must be bounded. Do not let the
face import Pi types — events cross the boundary as the application-level `ChatEvent`
union, already Pi-free.

---

## Chunk 4 — `ziggy acp`

**Behavior delivered:** `ziggy acp <profile>` speaks Agent Client Protocol v1
(JSON-RPC 2.0 as UTF-8 NDJSON over stdio) so Zed-style IDE clients and Block's Buzz
ACP harness can drive Ziggy as an agent. Buzz uses this ACP face; Ziggy does not add a
separate Buzz gateway.

**Independent of chunk 3.** Both faces sit on `ZiggyAgent.openChat`.

**Work:**
- Pin the official `@agentclientprotocol/sdk` package at `1.3.0`. Use its stable v1
  `agent()` API and `ndJsonStream`; do not use deprecated connection classes, the
  experimental v2 entry point, or LSP `Content-Length` framing.
- New CLI command `acp <profile> [--shared]` in `src/faces/cli.ts` + `src/main.ts`
  dispatch. Default memory context is local/owner for Zed. `--shared` is required for
  Buzz or another shared harness and maps each ACP session to group memory
  `group:acp-<sessionId>` so owner memory never enters a shared channel.
- New face `src/faces/acp.ts`. Keep SDK callbacks at this face boundary and return
  Effect-owned work inward through `ZiggyAgent`. Read `extensions/acp-router/` and
  `docs/research/acp-server-surface.md` first.
- Minimal method set:
  - `initialize` — advertise protocol version and capabilities (no filesystem, no
    terminal embedding; prompt turns only).
  - `session/new` — require an absolute client `cwd`, require no MCP servers, and open a
    chat at `<profile>/sessions/acp/<sessionId>/` via `ZiggyAgent.openChat`. Use local
    context by default or group context under `--shared`.
  - `session/prompt` — accept baseline text and resource-link blocks, reject content
    types Ziggy did not advertise, and forward to `handle.prompt`; stream assistant text as
    `session/update` notifications; resolve the request with stop reason `end_turn`
    when the `settled` event arrives.
  - `session/cancel` notification -> `handle.abort`; resolve the active prompt with
    stop reason `cancelled`.
- Process model: `ziggy acp` is its own process, like `ziggy run`. It does not take the
  gateway owner lock. Its sessions live under `sessions/acp/`, so it never shares a
  session directory with serve-owned sessions.
- Logging must go to stderr only. stdout is protocol-only.

**Verification:**
- Unit: frame decode; initialize/new/prompt happy path against a stubbed agent
  (`test/faces/acp.test.ts`).
- Manual with Zed (or any ACP client): point a custom agent at
  `ziggy acp <profile>`, send a prompt, see streamed text.
- Manual with Buzz (optional, needs a Buzz relay): add a tier-3 custom harness JSON
  under Buzz's `custom_harnesses/` pointing at the `ziggy acp` command, @mention the
  agent in a channel.

**Risk:** ACP spec drift. Pin SDK `1.3.0`, protocol version `1`, and the exact baseline
capabilities in tests and the changelog.

---

## Chunk 5 — `@ziggy/gateway-client` + example web page

**Behavior delivered:** third parties get a typed client for the chunk-3 protocol and
a working example, so a UI is ~50 lines of app code.

**Layout (isolated packages, `extensions/*` pattern — own `package.json`, not a
workspace):**

```
clients/gateway-client/
  package.json            # name: @ziggy/gateway-client, private for now
  src/index.ts
clients/example-web/
  index.html
  main.ts
  README.md
```

**Client API (`clients/gateway-client/src/index.ts`):**
- `connectZiggy({ url, token })` -> client object.
- `client.request(method, params)` -> Promise of result; matches responses by id;
  request timeout with a clear error.
- `client.on(eventName, handler)` and `client.onAny(handler)` for pushed events.
- Auto-reconnect with capped exponential backoff; re-issue `session.watch`
  subscriptions after reconnect; surface connection state changes as a synthetic
  event.
- Types are hand-written mirrors of `src/domain/ui-gateway.ts`. Put a comment in both
  files naming the other as the mirror. (The isolated package cannot import repo
  internals; keeping the protocol tiny is the mitigation.)
- Plain TypeScript, no Effect dependency — this package is for outsiders.

**Example web page (`clients/example-web/`):**
- One HTML page + one TS module, bundled with `bun build`. Inputs for port and token
  (user pastes from `.runtime/ui-server.json`; a browser cannot read it from disk).
- Shows: session list (live + stored), open a `ui/` session, send prompts, streamed
  assistant text, and a watch pane for any live channel session.
- README with the three commands to run the demo.

**Dependencies:** chunk 3.

**Verification:**
- Unit tests inside `clients/gateway-client` (its own `bun test`): frame matching by
  id, event dispatch, reconnect state machine with a fake socket.
- Manual: `bun src/main.ts serve scratch2`, `bun build` + open the example page,
  full chat round-trip in the browser.

**Risk:** low. Type drift between the mirror and the domain schema — keep the protocol
frozen within this packet; version it (`"v": 1` field in the hello/ping) if you must
change it later.

---

## Chunk 6 — Desktop reference app (deferred, do not start in this packet)

Thin Electron or Tauri client over chunks 3 + 5. Panel map (from the Hermes desktop
comparison): chat (ui sessions), sessions browser, profiles roster (`profiles.list` +
`SOUL.md`), agents (`agents/*.md`), automations, channels (config + health files),
extensions, memory viewer (chunk 2 commands / files), settings + doctor. Native shell
spawns `ziggy serve` if not running and reads `ui-server.json`; all agent traffic goes
over the WebSocket, never over IPC. Decide stack when this starts.

---

## Verification matrix

| Chunk | Automated | Manual proof |
|---|---|---|
| 0 | `bun run check` | LICENSE renders on GitHub |
| 1 | CLI decode tests; JSON schema round-trip | `--json \| jq` on all five commands; NDJSON from `run --json`; resume by id |
| 2 | init idempotence; backup + prune; usage math | fresh init shows scaffold; `memory list`; backup dir populates |
| 3 | protocol schema tests; registry tests; dispatch tests | websocat round-trip; live channel watch |
| 4 | ACP frame + happy-path tests | Zed prompt round-trip; (optional) Buzz mention |
| 5 | client unit tests (own package) | example page chats against serve |

Every chunk ends with `bun run check` + `bun test` green, a `LOG.md` entry, and a
commit (or a small series of logical commits).

## Rollout

- Pure addition; no migrations. New files dominate; existing-file edits are limited to
  CLI decode/help, `main.ts` dispatch, init scaffolding, the memory write path
  (backups), gateway handle registration, and `resident-gateway.ts` wiring.
- `ui-server.json` and `memory-backups/` live under `<profile>/.runtime/`, which is
  already the runtime-state location.
- Feature exposure is natural: the UI server only exists when `serve` runs; ACP only
  when invoked. No flags needed.

## Residual risks

- **UI branch stability inside serve.** A misbehaving client (frame floods, huge
  payloads) shares a process with channel loops. Mitigations: max frame size (64 KiB),
  per-socket in-flight request cap, loopback-only bind.
- **Pi NDJSON (`run --json`) schema is Pi-owned.** Fine while pinned to 0.84.1; note it
  in the memory of anyone bumping Pi.
- **Protocol mirror drift** between `src/domain/ui-gateway.ts` and the client package.
  Frozen v1 protocol; version field if it changes.
- **Backup I/O inside the memory lock** adds latency per write; acceptable at these
  file sizes, but keep it to one read + one write.

## Open decisions

1. **Prompting into channel sessions from the UI.** Watch-only in v1. Two-way control
   needs an interleaving policy with channel semaphores. Gates: nothing here.
2. **Publishing `@ziggy/gateway-client` to npm.** In-repo only for now. Gates: chunk 6
   distribution.
3. **Desktop stack (Electron vs Tauri).** Gates: chunk 6.
4. **Multi-user identity** (real platform user ids in `ChatContext`). Explicitly
   deferred by the owner. Gates: any shared/team deployment story.
