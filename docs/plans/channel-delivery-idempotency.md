# Channel delivery idempotency

Status: Phase 1 implemented in the current worktree on 2026-07-27. Telegram now performs a
retryable cold-start tail poll at offset `-1`, advances beyond the returned backlog without
opening Pi or sending, and then enters the normal long poll. Discord and Slack also suppress a
bounded set of recent transport IDs. Deterministic tests cover all three complete
inbound-to-reply loops. Phase 2's durable shared journal remains deferred until channel delivery
is load-bearing; live external round trips still require disposable channel credentials.

This plan is self-contained for a fresh agent session. It is based on the current working tree
on `main` at `0beae56d8da5dee95c0738375b0c4b0ef65e4f52`, including uncommitted gateway work.
Re-read the cited lines before editing because the files are currently changing.

## Context

Ziggy's channel gateways can repeat a model turn and its external effects after a restart.
The stateful audit identifies the concrete Telegram failure: the batch is processed before a
higher offset reaches Telegram, so a crash after a reply but before the next poll causes the
same inbound to be replayed and answered twice
(`docs/research/stateful-audit.md:76-85`). The ranked finding also calls out a second
irreducible window: retrying a `sendMessage` whose first request succeeded but whose response
was lost can double-send (`docs/research/stateful-audit.md:9-11`).

The comparative audit establishes three reference positions
(`docs/research/starman-coverage-audit.md:149-163`):

1. Starman persists offsets and per-update claims.
2. OpenClaw uses a durable ingress spool and a seven-day message dedupe, while documenting the
   crash-after-provider-accept duplicate window.
3. Hermes does not implement general inbound dedupe. It deliberately drops pending Telegram
   updates on cold start and invests in an outbound delivery ledger instead.

The immediate Ziggy requirement is the Hermes cold-start stance because it is the smallest
safe operational improvement: a restarted Telegram gateway must not replay an offline backlog.
The later requirement is not Starman's per-transport claim files and not OpenClaw's full ingress
spool. It is one channel-agnostic inbound journal at the gateway boundary.

The reference audit's broader lesson is to keep transport/session mechanics local: Ziggy's
per-chat session directories and semaphores already match the small-scale shape used by the
reference systems (`docs/research/starman-coverage-audit.md:212-221`). The shared mechanism
introduced here therefore owns only inbound acceptance and successful reply state. Telegram
offsets, Discord resume sequence, and Slack envelope acknowledgement remain transport concerns.

## Current state

### Telegram

The Telegram adapter decodes both `message_id` and `update_id`
(`src/adapters/telegram/api.ts:20-29`). `getUpdates` accepts an offset and timeout and sends
them directly to Telegram (`src/adapters/telegram/api.ts:175-202`), so Phase 1 needs no new
HTTP endpoint or dependency.

The application normalizer currently drops both identifiers. Its internal message has only
`chatKey`, `chatId`, `context`, and `text` (`src/application/gateway.ts:33-38`), and
`normalizeUpdate` does not retain either id (`src/application/gateway.ts:93-123`).

The run loop starts with `offset = 0`, polls, advances the offset in memory from the received
`update_id` values, processes the batch concurrently, and only then polls again
(`src/application/gateway.ts:223-240`). That next poll is the first request capable of
confirming the prior batch to Telegram.

For each normalized message, the gateway opens or reuses the chat, invokes the model, and sends
all reply chunks (`src/application/gateway.ts:188-212`). The enclosing catch logs both agent
and Telegram failures and turns them into success from the loop's perspective
(`src/application/gateway.ts:213-220`). This lets the next poll confirm even a message that
never reached `replied`.

### Discord

The Discord socket already exposes the stable Discord message id as `DiscordInboundMessage.id`
(`src/adapters/discord/socket.ts:1-8`), but the application-level `InboundMessage` and
normalizer discard it (`src/application/discord-gateway.ts:32-37`,
`src/application/discord-gateway.ts:90-119`).

Discord prompts the model and sends all chunks before returning
(`src/application/discord-gateway.ts:208-224`), then swallows agent and delivery failures
(`src/application/discord-gateway.ts:225-232`). Messages are read from the socket and each
accepted message is forked into the gateway scope (`src/application/discord-gateway.ts:235-244`).

The adapter's resume state is process memory: `sequence`, `sessionId`, and `resumeGatewayUrl`
are local variables (`src/adapters/discord/socket.ts:156-170`). Dispatch frames update the
sequence before a `MESSAGE_CREATE` is enqueued (`src/adapters/discord/socket.ts:278-303`).
This remains a Discord concern in Phase 2; it does not become journal cursor state.

### Slack

The Slack socket exposes `ts`, which is the stable message identifier within a channel
(`src/adapters/slack/socket.ts:1-8`). The application message and normalizer currently discard
it (`src/application/slack-gateway.ts:34-40`, `src/application/slack-gateway.ts:93-125`).

Slack prompts the model and posts every reply chunk before returning
(`src/application/slack-gateway.ts:211-229`), then swallows agent and delivery failures
(`src/application/slack-gateway.ts:230-237`). It also forks each accepted socket message
(`src/application/slack-gateway.ts:240-249`).

The Socket Mode adapter currently acknowledges an envelope before it deduplicates `event_id`,
decodes the message, or enqueues it (`src/adapters/slack/socket.ts:255-279`). Its `event_id`
dedupe is a process-local set capped at 1,000 entries
(`src/adapters/slack/socket.ts:151-159`, `src/adapters/slack/socket.ts:238-253`). Whether the
ack should move after durable acceptance is intentionally left open below.

### Existing replay-damage bound

Memory writes have already moved to entry operations. Exact duplicate adds are idempotent
(`src/domain/memory.ts:141-160`; proof at `src/domain/memory.test.ts:4-13`). The tool acquires
a file lock, re-reads current memory, applies the whole operation batch, and atomically replaces
the file (`src/adapters/pi/pi-agent.ts:319-353`). This does not make the model turn
idempotent, but it makes concurrent memory writes merge-safe and duplicate adds harmless.

## Locked decisions

Everything in this section is **LOCKED**. An implementation session must not reopen these
choices without explicit user direction.

1. **LOCKED — Phase 1 is Telegram-only and drops the cold-start backlog.** Before the normal
   processing loop, make one extra `getUpdates` call using the Telegram tail offset, discard
   the returned updates, derive the normal-loop offset from the newest returned `update_id`,
   and only then enter the normal loop. This is Hermes' `drop_pending_updates` stance.
   Messages sent while Ziggy was offline are dropped by design.

2. **LOCKED — Phase 2 uses one channel-agnostic inbound journal.** Do not add Telegram,
   Discord, or Slack claim files. The journal key is
   `"<gateway>:<chatKey>:<messageId>"`.

3. **LOCKED — the journal lifecycle is `accepted → replied`.** Persist `accepted` before
   invoking the core. Persist `replied` only after the final outbound chunk succeeds. Skip an
   inbound whose key is already `replied`. An `accepted` replay runs the model again.

4. **LOCKED — journal storage is profile-owned.** Store one JSON file at
   `<profile>/gateways/inbound-journal.json`. Every mutation uses a temp file in the same
   directory followed by atomic rename. Prune by a seven-day TTL and a max-entry cap.
   Telegram `replied` entries may be pruned as soon as the poll offset has passed their
   `update_id`.

5. **LOCKED — transport progress stays transport-specific.** Telegram poll offset, Discord
   resume sequence, and Slack envelope acknowledgement remain in their adapters. The inbound
   journal is the only shared delivery mechanism; it must not grow a shared cursor,
   transport-resume, or acknowledgement abstraction.

6. **LOCKED — delivery remains at-least-once.** A crash after the provider accepts a send but
   before Ziggy persists `replied` can produce a duplicate. This is irreducible without a
   provider-supported idempotency key, and both Hermes and OpenClaw document the equivalent
   window. If a multi-chunk reply crashes after some chunks, retrying the inbound can repeat
   those earlier chunks.

7. **LOCKED — replay may repeat model work.** An inbound found as `accepted`, rather than
   `replied`, runs the model again. Already-shipped entry-based memory operations bound the
   damage: concurrent writes merge under the lock and exact duplicate adds are idempotent.

## Phase 1 — drop Telegram's pending cold-start backlog

Phase 1 is deliberately small. Do not create the journal, persist an offset, or change Discord
or Slack in this phase.

### Implementation steps

1. Add startup-drain constants and a pure offset helper in
   `src/application/gateway.ts`.

   - Use `offset = -1` and `timeout = 0` for the one startup `getUpdates` call. Telegram's
     negative tail offset forgets earlier queued updates and returns the last queued update.
   - Compute the normal-loop offset as `max(update.update_id + 1)` across the returned value,
     falling back to `0` if the result is empty.
   - Keep the helper pure and export it only if a focused test needs it.

2. Immediately after installing the chat finalizer and before `while (true)`, call:

   - `retryTelegram(() => getUpdates(config.botToken, -1, 0))`;
   - discard every returned update without normalization, chat creation, model invocation,
     memory work, or `sendMessage`;
   - initialize the existing loop's `offset` from the pure helper instead of hard-coding `0`.

   The startup drain is exactly one extra API call. The first ordinary long poll uses the
   computed `latest update_id + 1`; it confirms the one tail update returned by the drain and
   receives only messages that arrived after the startup cut. It is part of the normal loop,
   not a second drain call.

3. Keep the startup call inside `retryTelegram`. A transient failure delays gateway readiness;
   it must not fail open into an `offset = 0` replay.

4. Log one content-free startup event after the drain succeeds, for example
   `[gateway] pending Telegram backlog discarded`. Do not log message text, user content, or a
   misleading count: the tail call can forget more updates than it returns.

5. Add focused tests in `src/application/gateway.test.ts`.

   - Empty backlog produces normal offset `0`.
   - A returned tail update produces `update_id + 1`.
   - The startup request uses `offset: -1` and `timeout: 0`.
   - Returned startup updates never reach `normalizeUpdate`, `agent.openChat`, `prompt`, or
     `sendMessage`.
   - A message returned by the first normal poll is processed once.

   Prefer a tiny injected Telegram transport seam over global monkey-patching. The production
   default must still be the current `getUpdates`/`sendMessage` adapter functions, and raw
   network promises must stay in the adapter boundary.

### Phase 1 definition of done

Phase 1 is done only when all of these are true:

1. Starting with a queued Telegram update makes one non-blocking tail request, drops the
   backlog, and starts the ordinary long poll at the next offset.
2. No queued offline update opens a chat, runs the model, changes memory, or sends a reply.
3. A new update arriving after the drain is processed normally.
4. A transient startup-drain failure retries and does not enter the processing loop.
5. `bun test`, `bun run check`, and the new focused gateway test pass.

Document the operator trade-off in the implementation change: until Phase 2 replaces this
behavior, Telegram messages sent while Ziggy is stopped are intentionally lost.

## Phase 2 — channel-agnostic inbound journal

Phase 2 supersedes Phase 1 for Telegram. Remove the cold-start backlog drain when enabling the
journal so Telegram resumes queued and replayed inbounds. Leaving the drain in place would
silently lose load-bearing offline messages and would make the required crash proof pass
without exercising the journal.

Before changing Effect code, read:

- `.agents/skills/effect-runtime-boundaries/SKILL.md`
- `.agents/skills/effect-schema-boundaries/SKILL.md`
- `.agents/skills/effect-typed-errors/SKILL.md`

### Journal model and invariants

Add `src/domain/inbound-journal.ts` and a focused
`src/domain/inbound-journal.test.ts`.

Use a versioned JSON document with an entry map keyed by the locked composite key. A concrete
v1 shape is:

```ts
interface InboundJournalV1 {
  readonly version: 1
  readonly entries: Readonly<Record<string, InboundJournalEntry>>
}

interface InboundJournalEntry {
  readonly gateway: "telegram" | "discord" | "slack"
  readonly chatKey: string
  readonly messageId: string
  readonly state: "accepted" | "replied"
  readonly acceptedAt: string
  readonly repliedAt?: string
  readonly transportPosition?: number
}
```

`transportPosition` is optional metadata used only for Telegram pruning and is not a shared
cursor. For Telegram it is `update_id`. Discord and Slack omit it.

Derive TypeScript types from Effect Schemas rather than duplicating schema-owned interfaces.
Decode unknown file contents once at the filesystem boundary. Treat a missing file as an empty
v1 journal; treat malformed JSON, an unknown version, an invalid timestamp, or an invalid entry
as a typed failure. Never replace a corrupt journal with an empty one.

The key mapping is:

- Telegram: gateway `telegram`, existing `chatKey`, `messageId = message.message_id`, and
  `transportPosition = update.update_id`.
- Discord: gateway `discord`, existing `chatKey`, and
  `messageId = DiscordInboundMessage.id`.
- Slack: gateway `slack`, existing `chatKey`, and `messageId = SlackInboundMessage.ts`.

Keep these invariants in pure domain functions and prove them directly:

1. The same gateway/chat/message tuple always produces the same key.
2. `accept` creates `accepted` once and never moves `replied` backward.
3. `markReplied` requires an existing `accepted` entry and is idempotent.
4. Only `replied` returns the `skip` decision; `accepted` returns `process`.
5. Timestamps are UTC ISO-8601 values supplied by a testable clock.

Use `10_000` as the initial max-entry cap. Pruning is deterministic:

1. Remove Telegram `replied` entries whose `transportPosition` is lower than the adapter's
   confirmed offset.
2. Remove `replied` entries whose `repliedAt` is older than seven days.
3. If the file is still over 10,000 entries, remove the oldest `replied` entries first, using
   composite key as the stable tie-breaker.
4. Never silently prune `accepted`. If accepted entries alone reach the cap, fail closed with
   a typed capacity error instead of accepting unjournaled work.

The journal is an outcome/dedupe journal, not a full ingress spool. It does not store message
text, prompts, model replies, tokens, or transport credentials. Recovery of an `accepted`
entry depends on the transport replaying the inbound. Guaranteed Discord or Slack backfill is
not implied by this phase.

### Filesystem store

Add `src/adapters/fs/inbound-journal.ts` and
`src/adapters/fs/inbound-journal.test.ts`.

Expose Effect-shaped operations such as:

- `inspect(profilePath, key)` returning `missing | accepted | replied`;
- `accept(profilePath, entry)` returning `process | skip`;
- `markReplied(profilePath, key, repliedAt)`;
- `prune(profilePath, policy)`.

Every mutation must:

1. Create `<profile>/gateways/` if needed.
2. Serialize mutation of the shared file. Use an in-process semaphore and a sibling
   `inbound-journal.json.lock` with bounded stale-lock recovery so separate channel processes
   cannot perform last-writer-wins rewrites. The lock is journal storage coordination, not a
   per-transport claim file.
3. Acquire the lock, re-read and decode the latest file, apply one pure domain transition, and
   write only if content changed.
4. Write a uniquely named temp file in the same directory, flush and close it, then rename it
   over `inbound-journal.json`.
5. Clean up a temp file on ordinary failure, release the lock in finalization, and surface
   typed read/decode/write/lock/capacity failures.

The existing memory writer demonstrates the required same-directory temp, flush, close, and
rename sequence (`src/adapters/pi/pi-agent.ts:194-213`). Extract a generic atomic JSON helper
only if doing so leaves the Pi adapter boundary cleaner; do not make the journal depend on Pi.

Filesystem proofs must cover missing-file initialization, malformed-file fail-closed behavior,
`accepted → replied`, no `replied → accepted` regression, concurrent writes preserving both
entries, atomic replacement, TTL pruning, max-cap pruning, Telegram offset pruning, and
accepted-only capacity failure.

### Application boundary

Add `src/application/inbound-delivery.ts` as the channel-agnostic orchestration service. It owns
the transition ordering, while each gateway supplies the transport-specific model invocation
and delivery Effects.

The shared operation must execute in this order:

1. Enter the existing per-chat semaphore.
2. Build the composite key from the normalized inbound.
3. Inspect/accept in the journal. Persist `accepted` before opening a chat or invoking
   `handle.prompt`.
4. If the current state is `replied`, return `skipped` without opening a chat, invoking the
   model, calling tools, or sending.
5. If the current state is new or `accepted`, invoke the model. Replaying `accepted`
   intentionally invokes it again.
6. Deliver every outbound chunk through the channel adapter.
7. After the final chunk succeeds, persist `replied`.
8. Only after `replied` is durable may the transport advance/acknowledge in a way that prevents
   replay.

The per-chat semaphore must wrap the journal decision, not only the model call. Otherwise two
copies of the same inbound can both observe `accepted` and run concurrently. Preserve
cross-chat concurrency.

Do not swallow an agent, delivery, or journal failure into a successful transport outcome.
Leave the entry `accepted`, log the typed failure at the outer gateway boundary, and keep or
restart the transport in a state that permits replay. This changes the current catch-and-log
behavior in Telegram (`src/application/gateway.ts:213-220`), Discord
(`src/application/discord-gateway.ts:225-232`), and Slack
(`src/application/slack-gateway.ts:230-237`).

Wire the journal service into all three gateway layers and their production composition in
`src/main.ts`. The three commands currently resolve independent gateway services
(`src/main.ts:54-62`) and enter their run loops directly (`src/main.ts:179-207`), so each
gateway layer must receive the same profile-owned journal implementation.

### Telegram integration

Change `src/application/gateway.ts` as follows:

1. Extend normalized inbound state with string `messageId` from `message.message_id` and
   numeric `transportPosition` from `update.update_id`.
2. Remove Phase 1's startup tail drain.
3. Journal each authorized text inbound before `agent.openChat`.
4. Skip `replied` keys inside the per-chat semaphore.
5. Mark `replied` only after every `sendMessage` chunk succeeds.
6. Treat any non-replied batch item as a failed batch. Do not issue the higher-offset poll
   that would confirm the batch. Restart or retry the batch; already-`replied` messages will
   skip and `accepted` messages will run again.
7. Once the higher-offset poll has reached Telegram, allow pruning of `replied` entries whose
   `transportPosition < confirmedOffset`.

Keep poll offset calculation and confirmation semantics in the Telegram path. Do not persist
the offset in the shared journal.

### Discord integration

Change `src/application/discord-gateway.ts` to carry `DiscordInboundMessage.id` into the
normalized message, journal before opening the chat, skip `replied`, and mark `replied` after
the final `createMessage` chunk succeeds.

Keep Discord sequence/session/resume mechanics in `src/adapters/discord/socket.ts`. The journal
does not replace them and does not claim that a process restart can resume a lost volatile
Discord session. The REST-backfill question below determines whether missed-while-down
messages later need another transport-specific recovery path.

### Slack integration

Change `src/application/slack-gateway.ts` to carry `SlackInboundMessage.ts` into the normalized
message, journal before opening the chat, skip `replied`, and mark `replied` after the final
`postMessage` chunk succeeds.

Keep Slack envelope acknowledgement in `src/adapters/slack/socket.ts`. To make the locked
ordering enforceable, extend the socket boundary so the application can decide when to ack an
envelope, but do not choose the timing until the open question below is answered. Do not put
envelope ids or ack state into `inbound-journal.json`.

### Phase 2 definition of done

Phase 2 is done only when all of these are true:

1. All three gateways use the same journal service and locked composite-key format.
2. `accepted` is durably visible before any model/tool call, and `replied` is durably visible
   only after the final outbound chunk succeeds.
3. A replayed `replied` inbound performs zero model, tool, memory, and send work.
4. A replayed `accepted` inbound runs again and can reach `replied`.
5. Telegram no longer drops its cold-start backlog, journal pruning obeys the seven-day,
   10,000-entry, and confirmed-offset rules, and `bun test` plus `bun run check` pass.

Follow the repository working agreement during the implementation session: update `LOG.md` per
logical block and commit Phase 2 in reviewable domain/store/integration/proof blocks. That is an
instruction for the future implementation session; creating this plan must not modify
`LOG.md`.

## Proof

The acceptance proof is a process-level Telegram crash simulation, not only a pure journal
test.

Add a deterministic harness test, for example
`src/application/gateway-crash-recovery.test.ts`, with these actors:

1. A parent-owned fake Telegram transport that models `getUpdates` confirmation: it retains a
   batch until it receives a request with `offset > update_id`, and it counts outbound sends.
2. A child gateway process using a temporary profile, a deterministic fake agent, the real
   filesystem journal, and the fake transport through an injected adapter seam.
3. A test-only barrier after `replied` has been atomically persisted and before the gateway
   issues the next poll.

Run this exact scenario:

1. Seed one inbound update and start child A.
2. Let child A accept it, run the fake model once, send one reply, and persist `replied`.
3. At the barrier—before the next `getUpdates` call—send `SIGKILL` to child A. Verify the fake
   Telegram service still considers the batch unconfirmed.
4. Start child B with the same profile and transport. The transport replays the same update.
5. Let child B reach its next poll, then stop it cleanly.
6. Assert the journal key is `replied`, the fake provider saw exactly one outbound send total,
   and child B performed zero model calls for the replayed key.

Add the complementary accepted-state proof:

1. Kill after `accepted` is durable but before delivery.
2. Restart with the same profile and replayed update.
3. Assert the model runs again, delivery occurs once, and the entry reaches `replied`.

Finally, simulate an outcome-unknown send:

1. Make the fake provider record acceptance, then terminate before returning success or before
   `replied` is persisted.
2. Restart and replay.
3. Assert that two sends are possible and name this an accepted at-least-once limitation. This
   is a proof of the boundary, not a test failure.

The required headline assertion is: process a batch, kill before the next poll, restart, and
observe no duplicate reply when `replied` was durable.

## Out of scope

- An outbound delivery ledger or obligations table.
- Provider idempotency keys.
- Exactly-once model execution, tool execution, or message delivery.
- A durable OpenClaw-style ingress spool containing message bodies.
- Moving Telegram offsets, Discord resume state, or Slack acknowledgements into the shared
  journal.
- Solving multiple simultaneously running gateway processes beyond serializing the shared
  journal file.

## Open questions

1. Should Discord REST-backfill messages missed while the gateway was down or unable to resume?
   The inbound journal can deduplicate a backfilled message by Discord message id, but it does
   not itself discover missing Discord messages.

2. Should Slack acknowledge a Socket Mode envelope before processing or only after `accepted`
   is durably journaled? Acknowledging before processing reduces Slack retries but can lose an
   inbound on a crash before acceptance. Acknowledging after durable acceptance gives the
   journal a replay key before Slack can forget the envelope, but it requires exposing an
   explicit ack handle through the socket boundary and handling Slack retry timing.
