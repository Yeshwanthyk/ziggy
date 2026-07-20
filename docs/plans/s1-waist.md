# S1 — Waist

## Goal

Build the "waist" of ziggy: the session engine and memory subsystem, running headless (no daemon, no socket, no TUI — just `packages/core` functions and a faux provider) so the hardest logic gets built and tested in isolation before any process/transport complexity is added in S2.

## Deliverables

### `packages/protocol`

- Attach-protocol type definitions (no runtime logic yet beyond types + a dependency-free client SDK shell — the actual socket transport is S2):
  - One canonical event envelope: `{ schemaVersion, seq, emittedAt, event }`, where `event` is the discriminated union, `seq` is monotonic per Session, and the Session NDJSON file is the sequence authority. The identical envelope is appended on disk and sent over the attach protocol; there is no disk/wire translation shape.
  - `initialize` handshake request/response types with a capability-negotiation shape (Client declares what it can render/handle; server responds with protocol version + supported features).
  - `session/start`, `session/resume`, `session/list` request/response types.
  - `session/subscribe` and `session/unsubscribe` types. `session/subscribe` accepts `sinceSeq`, returns every event after that sequence, and then live-tails atomically without a replay/live gap. `session/resume` opens a Session and performs that subscribe-with-replay atomically.
  - `turn/start`, `turn/steer`, `turn/interrupt` types — `turn/start` while a Turn is active queues a one-at-a-time follow-up and returns `disposition: "queued"`; `turn/steer` and `turn/interrupt` carry an `expectedTurnId` field for optimistic-concurrency (reject if the server's current turn id doesn't match, so a stale client can't steer the wrong turn).
  - `approval/resolve` request/response types with the closed v1 decision union `"approve" | "deny"` (first-response-wins semantics documented in the type comments; approval requests themselves are Session events, and actual fan-out logic is S2).
  - A dependency-free client SDK (`packages/protocol/src/client.ts`) — framing helpers only at this stage (encode/decode envelopes), no actual socket I/O yet.

### `packages/core` — session engine

- NDJSON append-only Session file format: one file per Session, one canonical `{ schemaVersion, seq, emittedAt, event }` envelope per line. Every event carries its `sessionId`, so the fixed envelope remains identical on disk and wire while multi-Session connections can demultiplex it without a wrapper. The file assigns and authoritatively records the per-Session monotonic `seq`; protocol replay streams these same envelopes unchanged. A partial/torn final line fails loud; automatic ignore, truncation, or repair is forbidden. Define the `event` union (turn-started, step-started, model-chunk, tool-call, tool-result, turn-ended, steer-received, approval-requested, approval-resolved, etc. — the ziggy `AgentEvent`-equivalent union, modeled on pi-agent-core's event contracts per `docs/REFERENCES.md`, not imported from it).
- Ziggy's own Effect-native agent loop, written from scratch in `packages/core/src/agent/`, driving `pi-ai`'s `streamSimple(model, context, options)` per model call. The loop owns: turn lifecycle, step nesting (one step = one model call + its tool calls — concept borrowed from eve, no durable step-checkpointing required at v1, nice-to-have only), steer mailbox (a queue a running turn checks between steps; steer message gets folded into context before the next model call), follow-up mailbox (queued messages that start automatically once the current turn ends, mode: one-at-a-time first, "all" mode can be DECIDE-AT-BUILD), before/after-tool-call hook points (internal-only — no third-party registration surface at this stage, that's S4's concern if ever), parallel tool-call execution with results reordered back to source (source-call) order before being appended to the session log.
- Memory subsystem: `memory/MEMORY.md` and `memory/USER.md` as plain files under the profile directory. The World seam exposes semantic Session-log and Memory-document operations, not generic byte paths or revisioned transactions. A single `memory` tool exposed to the model with `add` / `replace` / `remove` actions over Hermes-style delimited entries, batchable in one crash-safe atomic tool call (recovery exposes all old or all new; a private version-stamped journal/staging protocol is allowed) (modeled on hermes-agent's `tools/memory_tool.py`). Reject delimiter injection. Hard caps count Unicode code points: 2,200 for `MEMORY.md` and 1,375 for `USER.md`, enforced by **rejecting the write** (tool returns an error requiring the model to consolidate) — never silent truncation.
- **Frozen-snapshot-at-session-start**: memory file contents are read once when a Session starts, persisted in its canonical `session-started` event for restart-stable resume, and baked into that Session's system prompt as a fixed string. Mid-Session `memory` tool writes hit disk immediately (so other Sessions / the next Session see them) but do **not** change the current Session's already-built prompt — this is what keeps the prompt-cache prefix stable across Turns. S1 exposes no mid-Session invalidation path; a new Session is the refresh boundary.
- Per-turn context assembly: stable prefix (system prompt + frozen memory snapshot + tool definitions) followed by a volatile suffix (conversation history since session start, growing each turn), using `pi-ai`'s `cacheRetention` (`"none"|"short"|"long"`) and `sessionId` controls to get provider-side prompt caching where available.
- A faux/test provider (check whether `pi-ai` ships one at `providers/faux.ts` or equivalent per `docs/REFERENCES.md`; if not, write a minimal deterministic in-repo fake implementing the same `streamSimple` contract) so the entire loop is testable headless without hitting a real API or spending tokens.

## Design (locked decisions binding this stage)

- Session = append-only NDJSON event log is the **single** authority — transcript, replay stream, and observability record are the same file. No separate "conversation history" data structure that could drift from it.
- No step-checkpointing durability required — steps are a logical grouping in the event stream, not a resumability mechanism, at v1.
- Ziggy owns the loop; `pi-ai` is used only for the single-model-call wire layer (`streamSimple`). Do not depend on `pi-agent-core`.
- Memory is file-based (Markdown), not SQLite/vector. Two scopes only at this stage: `MEMORY.md`, `USER.md`. Person-scoped memory (`memory/people/<id>.md`) is explicitly deferred to S6 (first gateway).
- Reject-at-cap, not truncate-at-cap, for memory writes.
- Schema stamps apply to machine-owned structured files such as the Session NDJSON envelope. Human-owned markdown is unstamped here; S5's Automation frontmatter is the explicit markdown exception.

## Verification growth

Extend `tests/testkit` with deterministic Provider streams, controlled clock/IDs, filesystem
partial-write/crash faults, tool barriers, and schedulable completion order. Register scenarios for
schema-version rejection, truncated NDJSON, monotonic sequence/replay boundaries, steer/follow-up
interleavings, tool-result reordering, atomic Memory batches, cap rejection, and frozen snapshots.
Evidence includes canonical event traces, Provider inputs, fault schedules, filesystem diffs, and
replay commands. A separate Sol medium agent in an independent run and context reviews
Session/Memory authority, loop ownership, ordering, atomicity, and accidental real Provider/model
access.

## Acceptance criteria

- [x] A headless test can: start a Session, send one user message, get a full Turn (against the faux Provider) recorded as canonical `{ schemaVersion, seq, emittedAt, event }` envelopes with strictly monotonic per-Session `seq` values.
- [x] A protocol test proves the envelopes read from the Session file are byte-for-byte shape-equivalent to replayed envelopes; `session/subscribe` with `sinceSeq` returns exactly the later events and then live-tails without gaps, while `session/resume` opens and subscribes with replay atomically.
- [x] A headless test proves steer: start a turn, inject a steer message mid-turn (before the faux provider's second step), confirm the steer content reaches the next model call's context and is recorded as a `steer-received` event.
- [x] A headless test proves follow-up queuing: queue a follow-up while a turn is in flight, confirm it auto-starts once the turn ends.
- [x] A headless test proves parallel tool calls are reordered to source order regardless of completion order.
- [x] A headless test proves the `memory` tool: `add` succeeds and persists to `MEMORY.md`; a write exceeding the cap is rejected with an actionable error, not truncated; `replace`/`remove` work; a batch of multiple actions in one tool call all apply atomically.
- [x] A headless test proves frozen-snapshot behavior: write to `MEMORY.md` via the tool mid-session, confirm the _current_ session's next-turn prompt does not include the new content, but a _new_ session started afterward does.
- [x] `defineContractTests` from S0 is reused for the filesystem-backed semantic World adapter and proves Session ordering/fail-loud torn-line behavior plus crash-safe all-old/all-new Memory batch recovery.
- [x] The harness, S1 plan checklist, and scenario/stage manifests include every landed behavior and negative/fault scenario; `verify:s1` and `verify:all` pass with schema-valid redacted evidence and resolved findings from verification/review by a separate Sol medium agent in an independent run and context.

## References to consult

- pi-mono `packages/agent` (`/Users/yesh/Documents/personal/reference/pi-mono`) — `AgentEvent` discriminated union, before/after-tool-call hooks, parallel-tool-execution-with-reordering contracts (design reference, not an import).
- hermes-agent (`opensrc path github.com/NousResearch/hermes-agent`) — `tools/memory_tool.py` for the add/replace/remove batchable-tool pattern and per-turn context/memory assembly mechanics.
- eve (`opensrc path github.com/vercel/eve`) — session → turn → step nesting concept.
- `docs/research/effect-v4-status.md` — Effect v4 APIs for Stream/Fiber usage in the loop implementation.
- `docs/DECISIONS.md` D-entries covering session/memory (Q6, Q8-adjacent design notes) for the exact frozen-snapshot rationale.
- `docs/REFERENCES.md` for pi-ai's exact `streamSimple` module paths and `cacheRetention`/`sessionId` API.

## Suggested agent workflow

For each slice, follow the `docs/VERIFICATION.md` through-loop: dedicated Sol medium scouting/task-decomposition run and context → red scenario → separate Sol medium implementation run and context → independent Sol medium deterministic verification/evidence/review run and context. The implementing run must not be the verifying run.

1. One codex `exec` (sol-medium) task: `packages/protocol` types only (no transport) — canonical envelope, `initialize`, and the exact Session/Turn/approval method shapes.
2. One codex `exec` (sol-medium) task, parallel: NDJSON Session writer/reader for the same canonical envelope and `event` union, filesystem storage adapter conforming to the S0 contract-test harness.
3. One codex `exec` (sol-medium) task, after 2: the Effect agent loop itself (turn/step lifecycle, steer/follow-up mailboxes, tool-call hooks, parallel-exec reordering) against the faux provider.
4. One codex `exec` (sol-medium) task, parallel with 3: memory subsystem (files, `memory` tool, cap enforcement, frozen-snapshot injection).
5. Independent Sol medium verification/review pass in a separate run and context, focused especially on reordering-after-parallel-execution correctness and the frozen-snapshot mechanism; convert applicable findings to deterministic regression scenarios.
6. Treat integration as its own slice: a dedicated Sol medium scouting/task-decomposition run and context precedes a separate Sol medium implementation run that wires loop + memory + session log together; a third, independent Sol medium run and context executes the full acceptance-criteria test list and verifies/reviews the result.

## Non-goals

- No daemon, no socket, no multi-client anything — S2.
- No real TUI or CLI — S3 (a throwaway test harness/CLI is fine for S1's own testing, but it is not a deliverable).
- No real provider calls in tests — faux provider only; real-provider smoke testing happens once S3 wires up actual auth.
- No extensions, no automations.
