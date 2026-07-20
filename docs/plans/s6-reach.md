# S6 — Reach (Telegram Gateway, v1 release line)

Stage owner: first Gateway Client and the v1 release. Depends on S2 (Daemon/attach protocol — Gateways attach as Clients), S3 (Face, for shared approval/steer UX patterns), S5 (Autonomy, for the Broadcast delivery target this stage implements the real endpoint of). This is the stage that ships **v1** (per D17: v1 lands after S6).

## Goal

Reach ziggy from Telegram: a dependency-free leaf client package that attaches to the daemon over the same protocol the TUI uses, maps chats to sessions correctly, respects per-gateway memory policy, and fails closed on identity for anyone who isn't the owner. Ship this as the v1 release: binaries + install script + announcement.

## Deliverables

- `packages/gateway-telegram` (or similarly named leaf package) depending ONLY on `packages/protocol` — no dependency on `packages/core` or the daemon internals.
- Long-poll (outbound) connection to Telegram's Bot API — no inbound open port required.
- Resume-handle mapping: `(chatId, threadId?) → sessionId`, persisted by the daemon as machine-owned Profile state (e.g. `<profile>/gateways/telegram/resume-map.json` or equivalent), with a configurable per-chat vs per-peer granularity policy. The Gateway configures mappings through `session/start` and `session/resume`; the Gateway process never writes Profile files.
- Stream/inspect-handle: separate runtime-owned handle used for `session/subscribe` replay and live-tail, kept structurally distinct from the resume handle so a reconnect or replay can never be mistaken for a new/resumed Session.
- Owner-link flow: `ziggy gateway link` prints a one-time code; sending `/link <code>` on Telegram binds that Telegram user ID to the owner Person with owner-policy access.
- Person-approval flow: an unlinked sender automatically gets a provisional Person limited to conversation-scope Memory. The owner can approve that Person through TUI/CLI, enabling person-scope persistence in `memory/people/<id>.md`. Primary Memory is never accessible to non-owners.
- Person-scoped memory: `<profile>/memory/people/<id>.md`, first written/read starting at this stage.
- Per-Gateway Memory policy in `ziggy.jsonc`: owner DMs → full save eligible; group chats → conversation-scope only (no cross-Session Memory writes) by default. Overrides can enable person-scope persistence for approved Persons but can never expose primary Memory to a non-owner.
- Approval fan-out to Telegram: inline keyboard buttons mirroring the TUI's approval prompts, first-response-wins semantics matching the attach protocol's approval model.
- Steer/queue from chat: a follow-up message while a turn is running is treated as a steer input (or queued, depending on turn state), not a new independent turn.
- v1 release artifacts: compiled binaries for macOS arm64 and Linux x64/arm64, a `curl | sh`-style install script, and the public announcement.

## Design (locked decisions)

**Dependency-free leaf Client (flue lesson).** flue proved Gateway/adapter packages can depend on nothing but the protocol contract, with all wiring done by the host. `packages/gateway-telegram` must not import from `packages/core`; it only speaks the attach protocol over whatever transport `packages/protocol` exposes for local/attached Clients. This keeps Gateways swappable and testable in isolation, and keeps the compiled daemon binary's surface area from ballooning per-Gateway.

**Two distinct handles per Session (eve lesson, reinforced by a documented merlin/openclaw bug).** merlin's evidence included a documented openclaw Telegram bug caused by conflating "which Session does this chat resume" with "which Session am I currently streaming/observing." Ziggy keeps these explicitly separate: the **resume handle** is Gateway-owned conceptually but persisted by the daemon, configured through `session/start` and `session/resume`; the **stream/inspect handle** is runtime-owned and uses `session/subscribe`/`session/unsubscribe` against an already-resolved Session. The Gateway process never writes Profile files. A reconnect never silently starts a new logical conversation, and a stream drop never causes the Gateway to lose track of which Session a chat is bound to.

**Two distinct identity flows.** Owner-link and person-approval are not the same operation. For owner-link, `ziggy gateway link` prints a one-time code and `/link <code>` binds the sending Telegram user ID to the owner Person with owner-policy access. For person-approval, any other unlinked sender automatically becomes a provisional Person limited to conversation-scope Memory; the owner approves them through TUI/CLI to enable only person-scope persistence at `memory/people/<id>.md`. Primary `MEMORY.md` and `USER.md` are never accessible to non-owners, including approved Persons.

**Per-Gateway Memory policy.** Group chats are noisy and often contain non-owner participants; default group-chat behavior is conversation-scoped (the Session transcript itself is the record) with no automatic writes into `memory/MEMORY.md` or `memory/USER.md`. Owner DMs default to full save eligibility (the Memory tool behaves as it does from the TUI). Configuration may enable person-scope persistence for approved Persons, but primary Memory access is an owner-only invariant and cannot be overridden.

**Person-scoped memory arrives here, not earlier.** `memory/people/<id>.md` was explicitly deferred from S1 (Waist) to "the first gateway stage" because until there's a gateway, there's no concept of "a person other than the owner" for memory to be scoped to — a single local TUI user doesn't need per-person files.

**Normalization is deliberately undesigned until now.** Per the user's explicit instruction, message-normalization design (how Telegram-specific message shapes — media, replies, edits, reactions — map onto ziggy's session-event model) is NOT pre-specified in this plan; it's DECIDE-AT-BUILD, to be worked out in this stage's own build sessions once the attach protocol and session-event shape from S1/S2 are concretely in hand.

## Verification growth

Extend `tests/testkit` with a simulated Telegram Bot API, chat/thread identity fixtures, Gateway
restart barriers, concurrent approval responders, and daemon-owned resume-map/Memory fault hooks.
Register one-time-code reuse/races, fail-closed identity, reconnect without duplicate Session,
resume/stream-handle separation, out-of-order updates, steer/queue races, primary-Memory denial,
policy transitions, and partial delivery. Evidence includes synthetic update/protocol timelines,
routing and handle maps, authorization decisions, Memory diffs, release checksums, and replay
commands. A separate Sol medium agent in an independent run and context reviews identity
confusion, non-owner data exposure, Gateway direct writes, Session duplication, and
first-response-wins races.

## Acceptance criteria

- Owner-link: run `ziggy gateway link`, send `/link <code>` from the owner's Telegram account, and confirm that exact Telegram user ID binds to the owner Person with owner-policy access; prove the code is one-time and another user cannot reuse it.
- Owner session routing: a message from the linked owner creates or resumes the correct Session (send two messages in the same chat and confirm the same `sessionId`; start a new chat/thread and confirm a different `sessionId`).
- Reconnecting the gateway process (kill + restart the long-poll client) does not create a duplicate session for an in-progress chat.
- Person-approval before approval: a message from an unlinked sender auto-creates a provisional Person, permits conversation-scope Memory only, creates no `memory/people/<id>.md`, and cannot read or write primary `MEMORY.md` or `USER.md`.
- Person-approval after approval: approve that provisional Person through TUI/CLI, send another message, and confirm only `memory/people/<id>.md` becomes eligible for persistence; primary Memory remains inaccessible.
- An approval prompt raised mid-turn appears as an inline-keyboard message in Telegram AND (if the TUI is also attached) in the TUI; whichever responds first resolves it, and the other surface reflects the resolution.
- A follow-up message sent while a turn is actively running is treated as steer/queue input per the attach protocol's turn semantics, not as a competing new turn.
- A group-chat conversation does not write to `memory/MEMORY.md` by default. Enabling person-scope persistence allows an approved Person's message to write only `memory/people/<id>.md`; no policy setting lets a non-owner access primary Memory.
- `bun build --compile` produces working macOS arm64 and Linux x64/arm64 binaries; the install script correctly places the binary and reports version on `ziggy --version`.
- The harness, S6 plan checklist, and scenario/stage manifests include every landed Gateway, identity, Memory-policy, and release behavior; `verify:s6` and `verify:all` pass with schema-valid redacted evidence and resolved findings from verification/review by a separate Sol medium agent in an independent run and context before v1 is declared done.

## References to consult

- flue (opensrc: `/Users/yesh/.opensrc/repos/github.com/withastro/flue/main`) — dependency-free channel package pattern.
- eve (opensrc: `/Users/yesh/.opensrc/repos/github.com/vercel/eve/main`) — resume-handle vs stream-handle separation.
- merlin (local, evidence-only: `/Users/yesh/code/personal/merlin`) — the documented openclaw Telegram session-conflation bug and the fail-closed-identity gateway lesson; consult for what went wrong previously, not as a spec to port.
- openclaw (opensrc: `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main`) — the Telegram integration whose bug merlin documented; useful for understanding the failure mode concretely.
- codex app-server (opensrc — confirm exact local path via `opensrc path github.com/openai/codex` before citing further in downstream docs) — attach-protocol approval fan-out and first-response-wins pattern this stage's Telegram inline-approval flow must match.
- `docs/plans/s5-autonomy.md` — broadcast-rules delivery target this gateway implements the real endpoint for.

## Suggested agent workflow

For each slice, follow the `docs/VERIFICATION.md` through-loop: dedicated Sol medium scouting/task-decomposition run and context → red scenario → separate Sol medium implementation run and context → independent Sol medium deterministic verification/evidence/review run and context. The implementing run must not be the verifying run.

1. `packages/gateway-telegram` scaffold + long-poll client against Telegram Bot API, talking to a stub/mock attach-protocol peer first (unblocks before S2's real daemon is fully done) — codex sol/medium.
2. Resume-handle store + stream-handle wiring against the real attach protocol once S2 lands — this is the highest-risk correctness piece (per the merlin bug precedent); write the reconnect-no-duplicate-session test first, then implement.
3. Owner-link flow (`ziggy gateway link` + one-time `/link <code>`) and its non-reuse tests.
4. Provisional Person auto-creation + TUI/CLI person-approval flow + person-scope/primary-Memory isolation tests.
5. Approval inline-keyboard UI + first-response-wins integration test against a simultaneously-attached TUI.
6. Steer/queue-from-chat wiring.
7. Release: compile binaries, write install script, cut v1 tag, announce.

Require a dedicated Sol medium scouting/task-decomposition run and context for resume/stream-handle separation and both identity flows before implementation, then independent Sol medium verification/review in a third run and context before merging; applicable findings become deterministic regression scenarios. These are the places a subtle bug reproduces exactly the class of failure merlin already hit in production.

## Non-goals

- Discord/Signal/imessage or any gateway beyond Telegram (S7 or blueprints).
- Rich media handling beyond what's needed for basic text-first conversation (attachments/voice/etc. are DECIDE-AT-BUILD, likely deferred past v1 unless trivial).
- Any inbound open port for Telegram (long-poll only in v1; webhook-mode Telegram is a future option, not v1).
- GUI or WS-remote-client transport (S7).
