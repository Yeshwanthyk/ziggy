# Hermes/OpenClaw Slack integration gaps for Ziggy

Research date: 2026-08-08. This is an integration inventory, not a claim that
all upstream features belong in Ziggy. It compares the current worktree with
the pinned source studies:

- [Hermes Slack source study](./hermes-slack-source-study.md): Hermes opensrc
  tree, archive commit `3e6a081d60e8d04a03d37008464f44555bc88832`.
- [OpenClaw Slack source study](./openclaw-slack-source-study.md): OpenClaw
  opensrc tree, archive commit `b55e1e3a554a4b55165f532dec30f53d04f5a7f2`.
- [Slack acknowledgement and progressive-output options](./slack-agent-feedback-options.md):
  Slack first-party references plus current Ziggy observations.

`[Fact]` means the cited source says or implements it. `[Inference]` means the
gap or risk follows from those facts and the current Ziggy boundary. `[Plan]`
is a product/implementation recommendation for discussion. Sizes are for the
smallest coherent slice: S (a few hours), M (roughly a day or two), L (multi-
boundary work, usually several days). Priorities are P0 (correctness/safety),
P1 (high user value), P2 (useful follow-up), and P3 (optional parity).

## Current baseline

The current Slack integration is intentionally a resident-owned Socket Mode
face. Its persisted configuration is `botToken`, `appToken`, `ownerUserId`,
and optional per-channel activation overrides; channels default to mention-only
([`src/domain/slack.ts`](../../src/domain/slack.ts)).
It authenticates the bot, opens Socket Mode with `apps.connections.open`, ACKs
Socket Mode envelopes, decodes message events, and reconnects with bounded
backoff ([`src/adapters/slack/socket.ts`](../../src/adapters/slack/socket.ts#L260-L419)).
Accepted turns enter the durable Slack journal before ACK. Each chat key uses a
one-permit semaphore and persistent Pi `ChatHandle`; root channel requests and
their later replies share one thread-root session. Reactions, native status,
progressive placeholder edits, tool status, cancellation, terminal delivery,
and content-free health all remain owned by the Slack gateway
([`src/application/slack-gateway.ts`](../../src/application/slack-gateway.ts)).

This inventory began as a pre-implementation snapshot. The detailed source-study
entries below retain that historical baseline. They are not current-state claims.
Use the reconciliation table, operations guide, tests, and `LOG.md` for current
Ziggy behavior.

### Post-research implementation reconciliation

The detailed entries preserve the source-study snapshot that shaped the work.
Implementation through 2026-08-09 changed the live status as follows:

| Entry | Current status |
| --- | --- |
| G1 | Complete. SQLite admission happens before ACK, and received or foreign-running rows recover after restart. |
| G2 | Complete. The journal deduplicates the logical channel/source timestamp and optional Slack event ID. |
| G3 | Complete. Admission has explicit outcomes, content-free diagnostics, visible pending feedback, and health counters. |
| G4 | Open. One Profile still assumes one Slack workspace identity; Slack Connect isolation is not implemented. |
| G5 | Partial. Channels default to mention-only and accept per-channel `mention` or `always` overrides. Multi-user allowlists, pairing, and open DMs remain out. |
| G6 | Complete and live-proven. 👀 settles to ✅, ❌, or 🛑 without blocking the turn. |
| G7 | Complete. Each root channel request and its later Slack replies share one thread-root Pi session; separate roots remain isolated. |
| G8 | Complete. Waiting turns show queued feedback, then change to working feedback when admitted. |
| G9 | Complete. Active turns refresh native status every 30 seconds. |
| G10 | Complete through a bounded progressive placeholder compositor. Native Slack streaming is not required. |
| G11 | Safe-send slice complete. Updates retry within bounds; ambiguous new-message posts do not retry and settle as unknown. Delivery reconciliation remains open. |
| G12 | Partial. One bounded progress owner serializes text and native status, and terminal delivery has explicit outcomes. A general outbound receipt ledger remains out. |
| G13 | Partial. Standard Markdown, broadcast escaping, and bounded line-aware chunks ship. Block Kit and full entity/code-fence-aware splitting remain open. |
| G14 | Complete. Bounded Pi assistant and tool events drive progressive text and `Using <tool>…` status with freshness cleanup. |
| G15 | Inbound image slice complete and live-proven. Outbound file generation and delivery remain open. |
| G16 | Open. Slash-command registration, Block Kit actions, and approval callbacks are not implemented. |
| G17 | Open. Ziggy has no general Slack action tool surface. |
| G18 | Complete for content-free connection and turn health in `serve status` and `doctor`. Workspace/team identity inspection remains part of G4/G23. |
| G19 | Partial. Owner admission, token/URL redaction, private-file guards, media bounds, and broadcast escaping ship. Future actions need their own policy boundary. |
| G20 | Complete. Per-chat generations, scoped interruption, and ordered status settlement block stale progress and answers after stop. |
| G21 | Open for pre-existing human discussion history. A conversation started through a root Squarey request now keeps its own Pi context. Ziggy still does not fetch earlier Slack thread messages when first mentioned later. |
| G22 | Open. Top-level text and bounded file metadata ship; rich blocks, forwards, and unfurls are not hydrated. |
| G23 | Partial. Strict local config, current setup docs, runtime health, and live proof ship. Generated manifests and live scope/subscription validation remain open. |

The live record is maintained in
[`docs/operations/slack.md`](../operations/slack.md#verification-record), and the
implementation summary is maintained in [`LOG.md`](../../LOG.md).

## Already integrated or substantially covered

These are useful upstream patterns that Ziggy already has in a smaller form.
They should not be re-imported as new architecture unless the current contract
is deliberately expanded.

### I1. Socket Mode transport and envelope acknowledgement

- **Upstreams:** Hermes registers and ACKs subscribed events plus a catch-all
  listener ([Hermes `adapter.py:1951-2045`](./hermes-slack-source-study.md));
  OpenClaw supports Socket Mode with a reconnecting receiver ([OpenClaw
  `provider-support.ts:323-383`](./openclaw-slack-source-study.md)). Slack
  Socket Mode is also in the [primary-source index](./slack-agent-feedback-options.md).
- **Baseline at research time:** `handleFrame` ACKs every decoded envelope before routing and
  ignores unsupported/malformed payloads ([`socket.ts`](../../src/adapters/slack/socket.ts#L330-L374)).
- **Benefit:** Slack does not redeliver a valid envelope merely because the
  consumer has not yet finished the agent turn.
- **Size:** S (already present).
- **Risk:** The ACK is transport-level only; it does not mean the event was
  admitted or durably accepted.
- **Priority:** P0 baseline; retain, do not confuse with durable ingress.

### I2. Reconnect, shutdown, bounded queues, and typed transport failures

- **Upstreams:** Hermes tears down old handlers/clients before reconnect and
  watches handler health ([Hermes `adapter.py:1856-1948`, `2167-2189`](./hermes-slack-source-study.md));
  OpenClaw retries recoverable disconnects and cleans up on shutdown ([OpenClaw
  `provider.ts:849-996`](./openclaw-slack-source-study.md)).
- **Baseline at research time:** Socket Mode reconnects through a fresh `connections.open` URL,
  bounds inbound/command queues, fails closed on overflow, and closes listeners
  through Effect scope ([`socket.ts`](../../src/adapters/slack/socket.ts#L144-L239),
  [`socket.ts`](../../src/adapters/slack/socket.ts#L454-L522)).
- **Benefit:** Fewer duplicate sockets and less uncontrolled memory growth.
- **Size:** S (already present).
- **Risk:** Queue overflow currently terminates the socket rather than
  durably preserving/replaying messages; see G1.
- **Priority:** P0 baseline; improve durability separately.

### I3. Event-ID deduplication and self/bot filtering

- **Upstreams:** Hermes suppresses duplicate event timestamps per workspace
  ([Hermes `adapter.py:5309-5364`](./hermes-slack-source-study.md)); OpenClaw
  merges `message`/`app_mention` twins and filters self-authored events
  ([OpenClaw `message-handler.ts:110-229`, `provider-support.ts:296-383`](./openclaw-slack-source-study.md)).
- **Baseline at research time:** A bounded in-memory recent-ID set drops repeated `event_id`
  values; subtype, bot-authored, and self messages are ignored
  ([`socket.ts`](../../src/adapters/slack/socket.ts#L361-L383)).
- **Benefit:** Basic reconnect redelivery cannot invoke the agent twice.
- **Size:** S (already present).
- **Risk:** Event IDs are not durable logical-message keys and may not cover
  distinct `message`/`app_mention` deliveries; see G2.
- **Priority:** P0 baseline; retain as the fast path.

### I4. Owner authorization and simple channel mention policy

- **Upstreams:** Hermes checks authorization before thread/file work and
  composes mention/channel gates ([Hermes `adapter.py:5540-5780`](./hermes-slack-source-study.md));
  OpenClaw fails closed when mention detection is unavailable and supports room
  policy ([OpenClaw `prepare.ts:1100-1110`, `1348-1375`](./openclaw-slack-source-study.md)).
- **Baseline at research time:** Only `ownerUserId` is admitted; DMs always run, and channels
  can require the bot mention or accept all owner messages; mentions are
  stripped before prompting ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L83-L126),
  [`docs/operations/slack.md`](../operations/slack.md#L18-L27)).
- **Benefit:** A small, explicit trust boundary and predictable shared-channel
  behavior.
- **Size:** S (already present).
- **Risk:** It is intentionally less expressive than upstream policy systems;
  adding multi-user/pairing behavior is a product choice, not a missing bug fix.
- **Priority:** P0 baseline; consider G5 only if multi-user use is wanted.

### I5. DM/channel memory separation and incoming thread preservation

- **Upstreams:** Both upstreams make session/thread identity explicit (Hermes
  `adapter.py:5562-5611`; OpenClaw `prepare-routing.ts:125-336`).
- **Baseline at research time:** DMs use `user-U...`, channels use `group-slC...`, direct
  memory is not admitted to channels, and replies preserve an incoming
  `thread_ts` ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L97-L126),
  [`docs/operations/slack.md`](../operations/slack.md#L18-L24)).
- **Benefit:** The current owner-only product does not leak personal memory into
  a channel and keeps replies in an existing thread.
- **Size:** S (already present).
- **Risk:** All top-level messages in a channel still share one session; a
  thread-scoped model is G7.
- **Priority:** P0 baseline; G7 is P2 unless thread isolation is required.

### I6. Native Assistant status with guaranteed clear path

- **Upstreams:** Hermes and OpenClaw use `assistant.threads.setStatus`, clear it
  on terminal paths, and treat status failures as best effort (Hermes
  `adapter.py:2860-3034`; OpenClaw `context.ts:530-550`). Slack's March 2026
  changelog allows channel apps to use `chat:write`, as recorded with primary
  links in the [feedback report](./slack-agent-feedback-options.md#1-assistantthreadssetstatus).
- **Baseline at research time:** `setStatus` is called immediately after acceptance and cleared
  in `acquireUseRelease`; failures are logged without blocking the model
  ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L226-L255),
  [`api.ts`](../../src/adapters/slack/api.ts#L316-L335)).
- **Benefit:** A native loading signal where the Slack client renders it.
- **Size:** S (already present).
- **Risk:** API success is not client-visible proof; top-level/thread semantics
  and a two-minute Slack timeout still need live workspace verification.
- **Priority:** P1 operational proof, not another implementation slice.

### I7. Visible placeholder, in-place final update, failure notice, and chunking

- **Upstreams:** Hermes uses `chat.postMessage` + `chat.update` and retries
  final delivery (Hermes `adapter.py:2522-2830`; OpenClaw `draft-stream.ts:71-204`).
  Slack's post/update contracts and accessibility guidance are in the [feedback
  report](./slack-agent-feedback-options.md#3-placeholder-chatpostmessage--chatupdate).
- **Baseline at research time:** The gateway retains the post response `ts`, updates the first
  message, posts remaining 4,000-code-point chunks, and replaces it with a
  failure notice on an agent failure ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L244-L325),
  [`api.ts`](../../src/adapters/slack/api.ts#L272-L315)).
- **Benefit:** Users see immediate durable feedback even when native status is
  not rendered.
- **Size:** S (already present).
- **Risk:** It is not progressive output; unknown post outcomes can duplicate
  messages under the current retry rail (G11).
- **Priority:** P1 baseline; protect it while adding streaming.

### I8. Basic typed API error classification and retry-after handling

- **Upstreams:** Hermes retries retryable sends with `Retry-After`/backoff
  ([Hermes `base.py:5367-5456`](./hermes-slack-source-study.md)); OpenClaw
  separates read retries from write unknown-send handling ([OpenClaw
  `client-options.ts:28-44`](./openclaw-slack-source-study.md)).
- **Baseline at research time:** HTTP failures are typed, redact tokens, classify 401/403/429/5xx,
  and carry `retry-after`; gateway retries operations marked retriable
  ([`api.ts`](../../src/adapters/slack/api.ts#L97-L185), [`slack-gateway.ts`](../../src/application/slack-gateway.ts#L138-L164)).
- **Benefit:** Transient failures do not immediately lose a final answer.
- **Size:** S (already present).
- **Risk:** “Retriable” currently means safe to call again for posts too; G11
  adds the missing unknown-send distinction.
- **Priority:** P0 baseline; do not widen retries without G11.

### I9. Markdown text boundary, accessibility fallback, and basic operational docs

- **Upstreams:** Both upstreams preserve accessible text and have richer Slack
  formatters (Hermes `adapter.py:3561-3718`; OpenClaw `format.ts:423-541`).
  Slack's first-party `markdown_text`/message guidance is linked in the [feedback
  report](./slack-agent-feedback-options.md#3-placeholder-chatpostmessage--chatupdate).
- **Baseline at research time:** It sends standard Markdown through `markdown_text`, splits at
  4,000 Unicode code points, and documents scopes, app setup, troubleshooting,
  and live proof ([`api.ts`](../../src/adapters/slack/api.ts#L272-L293),
  [`slack-gateway.ts`](../../src/application/slack-gateway.ts#L129-L135),
  [`docs/operations/slack.md`](../operations/slack.md#L58-L110)).
- **Benefit:** Common Markdown and long answers work without a custom mrkdwn
  renderer.
- **Size:** S (already present).
- **Risk:** Naive chunking can split code/entity constructs; G13 is optional.
- **Priority:** P1 baseline; G13 P2.

### I10. Focused fake-transport tests and secret-safe diagnostics

- **Upstreams:** Both source studies cite focused tests for dedup, status,
  streaming, attachments, retry, and cleanup (Hermes test anchors; OpenClaw
  `streaming.test.ts`, `status-reactions.slack-lifecycle.test.ts`, and ingress
  cleanup test).
- **Baseline at research time:** Socket, API, gateway, normalization, status, placeholder, error,
  retry, and cleanup paths have deterministic tests ([`socket.test.ts`](../../src/adapters/slack/socket.test.ts#L119-L278),
  [`api.test.ts`](../../src/adapters/slack/api.test.ts#L10-L161), [`slack-gateway.test.ts`](../../src/application/slack-gateway.test.ts#L23-L284)).
- **Benefit:** Boundary regressions are caught without live Slack secrets.
- **Size:** S (already present).
- **Risk:** Fake transport cannot prove Slack client rendering, app scopes,
  event subscriptions, or deployed behavior.
- **Priority:** P0 baseline; every new gap needs a focused invariant test and a
  separate live smoke check.

## Concrete remaining gaps

### G1. Durable ingress before acknowledgement and replay

- **Upstreams:** OpenClaw appends Events API payloads to a durable channel
  ingress queue before acknowledging and replays them with lifecycle context
  ([OpenClaw `ingress.ts:221-363`](./openclaw-slack-source-study.md); the
  durable-before-ack invariant is also summarized there). Hermes is primarily
  in-memory/background dispatch ([Hermes `base.py:6159-6173`](./hermes-slack-source-study.md)).
- **Baseline at research time:** It sends the Socket Mode envelope ACK before putting the
  normalized message into an in-memory bounded queue; a queue overflow fails
  the socket and queued work is lost ([`socket.ts`](../../src/adapters/slack/socket.ts#L330-L394)).
- **Benefit:** Reconnects, process restarts, and backpressure no longer silently
  lose an accepted user request.
- **Size:** L (durable record schema, append/claim/replay, shutdown semantics,
  migration/retention, and tests).
- **Small precursor:** S/M to ACK only after a valid message is successfully
  offered to the in-memory queue, while committing the recent-ID dedup key only
  with that offer. This prevents acknowledged queue-overflow loss but does not
  survive a process crash and is not a substitute for durable replay.
- **Risk:** At-least-once replay can duplicate agent turns unless G2's logical
  idempotency and an adoption state are designed together. Disk growth and
  stale records need bounded retention.
- **Priority:** P0 if Slack is relied on for important requests; otherwise P1.

### G2. Logical-message deduplication and `message`/`app_mention` twin merge

- **Upstreams:** OpenClaw derives a logical workspace/channel/timestamp key,
  merges same-flush `message` and `app_mention`, claims on turn adoption, and
  releases on abandonment/error ([OpenClaw `message-handler.ts:110-363`](./openclaw-slack-source-study.md)).
  Hermes suppresses duplicate timestamps per workspace ([Hermes
  `adapter.py:5309-5318`](./hermes-slack-source-study.md)).
- **Baseline at research time:** It remembers only up to 1,000 event IDs in memory and only
  subscribes/decodes generic `message` events; distinct event IDs for the same
  post are not merged ([`socket.ts`](../../src/adapters/slack/socket.ts#L70-L93),
  [`socket.ts`](../../src/adapters/slack/socket.ts#L361-L364)).
- **Benefit:** A reconnect, dual subscription, or durable replay produces one
  agent turn while preserving mention information.
- **Size:** M if only logical key/claim is added; L when combined with G1.
- **Risk:** Claiming too early drops messages on a crashed turn; claiming too
  late duplicates expensive model work. The state machine must define
  `received → adopted → completed/abandoned`.
- **Priority:** P0 with durable ingress; P1 as an in-memory correctness fix.

### G3. Explicit ingress admission outcomes and queue visibility

- **Upstreams:** OpenClaw records dropped history for failed mention detection,
  reports provider connected/disconnected/blocked state, and classifies malformed
  versus retryable ingress ([OpenClaw `prepare.ts:1100-1110`, `provider.ts:861-996`](./openclaw-slack-source-study.md)).
  Hermes has explicit ignored-channel/bot/authorization gates ([Hermes
  `adapter.py:5249-5364`](./hermes-slack-source-study.md)).
- **Baseline at research time:** `normalizeSlackMessage` returns `undefined` for blank, bot,
  non-owner, unmentioned, and mention-only messages without recording why
  ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L83-L126)).
- **Benefit:** Operators can distinguish “Slack never delivered it,” “policy
  ignored it,” “queued,” and “agent failed,” reducing blind troubleshooting.
- **Size:** M (typed admission result/structured log fields; optionally durable
  counters in G1).
- **Risk:** Logging user text, IDs, or channel names can leak sensitive data;
  use bounded redacted identifiers and reason codes only.
- **Priority:** P1.

### G4. Multi-workspace/team identity and Slack Connect isolation

- **Upstreams:** Hermes keys clients, bot IDs, dedup, status, reactions, and
  sessions by workspace/team and refuses ambiguous status cleanup (Hermes
  `adapter.py:1856-1948`, `2889-3024`). OpenClaw qualifies peers by team and
  rejects mismatched `api_app_id`/team IDs (OpenClaw `prepare-routing.ts:125-175`,
  `context.ts:649-675`).
- **Baseline at research time:** `auth.test` retains only `user_id`; the Socket Mode message
  schema retains no `team_id`/`api_app_id`, and `chatKey` is only user/channel
  based ([`api.ts`](../../src/adapters/slack/api.ts#L10-L17), [`socket.ts`](../../src/adapters/slack/socket.ts#L79-L89),
  [`slack-gateway.ts`](../../src/application/slack-gateway.ts#L67-L74)).
- **Benefit:** Prevents same-looking IDs or a misrouted event from crossing
  workspaces and makes status/update cleanup unambiguous.
- **Size:** M for decoding/qualifying identity; L if one Profile supports
  multiple workspaces and needs per-team credentials.
- **Risk:** Slack payload variants omit fields; rejecting unknown/legacy payloads
  can reduce compatibility. Identity must be captured before async work.
- **Priority:** P0 for multi-workspace or Slack Connect; P1 otherwise.

### G5. Configurable DM/channel allowlists, pairing, and mention policy

- **Upstreams:** Hermes supports allowed/free-response channels, strict/thread
  mention memory, bot policy, and MPIM rules (Hermes `adapter.py:5320-5780`,
  `8252-8370`). OpenClaw supports DM pairing/open policy, room allowlists, and
  ephemeral denial explanations (OpenClaw `dm-auth.ts:20-71`, `context.ts:560-647`).
- **Baseline at research time:** It has one owner, mention-only channel activation by default,
  and per-channel `mention`/`always` overrides inherited by threads. Every
  mention-only thread request must mention the bot; there is no mention-once
  latch, channel user allowlist, pairing, or multi-user admission
  ([`slack.ts`](../../src/domain/slack.ts),
  [`docs/operations/slack.md`](../operations/slack.md)).
- **Benefit:** Safe shared workspaces and clearer per-room behavior without
  requiring a new Profile per channel.
- **Size:** M (schema, policy evaluator, reasoned diagnostics, tests, docs).
- **Risk:** A policy mistake can expose an agent or make it appear broken;
  preserve the current owner-only default and fail closed.
- **Priority:** P2 unless Ziggy is intentionally opened to other users.

### G6. Reaction acknowledgement and lifecycle status

- **Upstreams:** Hermes adds `eyes`, replaces it with check/error, and scopes it
  to DMs/mentions (Hermes `adapter.py:3722-3790`, `6322-6339`). OpenClaw has an
  optional queued/thinking/tool/done/error/stall reaction controller with
  serialized calls (OpenClaw `status-reactions.ts:56-353`, `dispatch-setup.ts:125-175`).
  Slack `reactions.add/remove` require `reactions:write` ([feedback report §4](./slack-agent-feedback-options.md#4-reactions-reactionsadd--reactionsremove)).
- **Baseline at research time:** No reaction API, `reactions:write` scope, or lifecycle ownership;
  the app uses `chat:write` status plus a placeholder ([`docs/operations/slack.md`](../operations/slack.md#L80-L95),
  [`slack-gateway.ts`](../../src/application/slack-gateway.ts#L244-L325)).
- **Benefit:** Low-cost durable received/working/done/error markers when Slack
  fails to render the status or before a placeholder appears.
- **Size:** M (scope/reinstall, adapter methods, ownership state, idempotent
  cleanup, and tests).
- **Risk:** Reactions are history annotations, can be ambiguous or stale, and
  must never remove a reaction the user already owned; adds API permission and
  rate-limit surface.
- **Priority:** P2 optional, below native status/streaming.

### G7. Thread-scoped routing and explicit reply/session modes

- **Upstreams:** Hermes has channel-wide versus thread/root session keys and
  configurable `reply_in_thread` (Hermes `adapter.py:5562-5611`). OpenClaw keeps
  room threads thread-scoped while ordinary DM threads remain a UI affordance,
  configurable through thread history/reply modes (OpenClaw
  `prepare-routing.ts:214-336`).
- **Baseline at research time:** An incoming thread is preserved in delivery, but every channel
  top-level and thread message maps to `group-sl<channel>`; there is no explicit
  reply mode or per-thread session ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L117-L126)).
- **Benefit:** Better context separation for parallel channel threads and a
  user-selectable tradeoff between continuity and isolation.
- **Size:** M (config + session key migration/compatibility + routing tests).
- **Risk:** Changing keys can strand or mix existing Pi sessions; migration and
  a stable default are required.
- **Priority:** P1 when multiple channel threads are used; otherwise P2.

### G8. Queued-turn receipts and explicit pending lifecycle

- **Upstreams:** Hermes marks a session active before background execution,
  queues concurrent follow-ups, drains late arrivals, and fences streaming on
  run freshness (Hermes `base.py:6075-6082`, `6644-6785`; `stream_consumer.py:795-801`).
  OpenClaw rotates/resets delivery trackers for queued follow-ups (OpenClaw
  `dispatch.ts:88-121`, `dispatch-progress.ts:567-617`).
- **Baseline at research time:** A per-chat semaphore serializes `prompt`, but feedback is
  acquired before the permit, so concurrent requests can each post a placeholder
  while waiting; there is no visible queued state or turn ID
  ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L218-L268)).
- **Benefit:** Users know whether a request is queued versus actively running;
  queued updates cannot overwrite a settled turn.
- **Size:** M (turn state machine, receipt ownership, cancellation/cleanup tests).
- **Risk:** Moving feedback acquisition behind the permit can make accepted
  messages look silent; a bounded queue can reject work and needs a clear notice.
- **Priority:** P1 for busy chats; P2 for current one-owner usage.

### G9. Elapsed progress heartbeat

- **Upstreams:** Hermes changes status after 30 seconds to an elapsed
  `still working… (XmYYs)` heartbeat and refreshes typing every two seconds
  (Hermes `adapter.py:2860-2951`, `base.py:5002-5086`). OpenClaw has 10/30-second
  soft/hard stall reactions (OpenClaw `status-reactions.ts:191-353`).
- **Baseline at research time:** It sets static `is thinking...` once, then clears it at turn
  settlement; there is no elapsed status or heartbeat ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L226-L237),
  [`docs/operations/slack.md`](../operations/slack.md#L28-L33)).
- **Benefit:** Long-running tools/models look alive without spamming messages.
- **Size:** S/M (timer, bounded status updates, cancellation-safe cleanup).
- **Risk:** Status rate limits and timer leaks; only update while the same turn
  owns the status and stop during shutdown.
- **Priority:** P1 if turns routinely exceed 30 seconds; otherwise P2.

### G10. Native streaming or a progressive draft compositor

- **Upstreams:** Hermes edits a Slack message at a cadence while streaming
  (Hermes `stream_consumer.py:1669-1710`, `2061-2407`). OpenClaw uses native
  `chatStream` for thread replies and a portable post/edit draft with
  conversation-boundary protection (OpenClaw `streaming.ts:116-352`,
  `draft-stream.ts:71-204`). Slack's `chat.startStream/appendStream/stopStream`
  contracts are linked in the [feedback report §2](./slack-agent-feedback-options.md#2-native-text-streaming-chatstartstream-appendstream-chatstopstream).
- **Baseline at research time:** It waits for complete `ChatHandle.prompt` output and only then
  updates/posts final chunks ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L268-L301)).
  Inbound decoding retains `ts` but not `team_id`; native channel streams need
  recipient user/team identity ([`socket.ts`](../../src/adapters/slack/socket.ts#L79-L89),
  [feedback report current facts](./slack-agent-feedback-options.md#current-ziggy-facts)).
- **Benefit:** Strongest user-visible “it is working” feedback and faster first
  token/partial answer.
- **Size:** L (Pi incremental event boundary, stream state, typed API methods,
  finalization, chunk/format handling, freshness tests, and live proof).
- **Risk:** A crash after `startStream` or an ambiguous append/stop can leave a
  partial or duplicated answer; model output must be fenced by turn identity.
  The Pi 0.82.0 boundary is a prerequisite, not assumed available.
- **Priority:** P1, after G11 design is agreed; P0 safety rules apply.

### G11. Unknown-send safety and delivery reconciliation

- **Upstreams:** OpenClaw disables generic write retries and reconciles unknown
  text sends via bounded signed metadata scans; ambiguous native-stream failures
  are not treated as definitely unsent (OpenClaw `client-options.ts:28-44`,
  `send.ts:941-1064`, `streaming.ts:246-352`). Hermes has retryable send results
  and separate final fallback (Hermes `adapter.py:2608-2632`, `base.py:5367-5456`).
- **Baseline at research time:** One generic `retrySlack` retries every `retriable` operation,
  including `chat.postMessage`; network failure after Slack committed can create
  duplicate placeholders/final chunks ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L138-L164),
  [`api.ts`](../../src/adapters/slack/api.ts#L212-L213)).
- **Benefit:** “Retry” stops multiplying user-visible answers while still
  recovering genuinely unsent messages.
- **Size:** L (write outcome taxonomy, signed/owned metadata, bounded history
  reconciliation, update/stream semantics, and tests).
- **Risk:** False reconciliation can suppress a legitimate answer; unresolved
  outcomes need an explicit operator/user state rather than silent loss.
- **Priority:** P0 before native streaming or high-volume automation.

### G12. Serialized outbound sends and delivery receipts

- **Upstreams:** OpenClaw serializes sends by account/token/recipient/thread and
  returns message IDs/receipts per logical part (OpenClaw `send.ts:63-75`,
  `1096-1455`). Hermes tracks status/reaction identity per workspace/thread
  (Hermes `adapter.py:2889-3024`).
- **Baseline at research time:** Per-chat agent execution is serialized, but placeholder/status,
  updates, and automation sends have no keyed outbound queue or per-part receipt
  ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L226-L328),
  [`application/automations.ts`](../../src/application/automations.ts#L200-L224)).
- **Benefit:** Concurrent turns and automation delivery cannot race message edits;
  operators can identify every posted part.
- **Size:** M (keyed queue, receipt value, call-site propagation, tests).
- **Risk:** A queue can delay feedback and deadlock if it shares the agent
  semaphore; keep transport serialization separate and bounded.
- **Priority:** P1 with G11; P2 for one-profile low-volume use.

### G13. Slack-safe formatting, entity-aware chunking, and Block Kit

- **Upstreams:** Hermes formats links/entities/code/tables, escapes broadcast
  mentions, and uses optional rich blocks with accessible text (Hermes
  `adapter.py:2541-2582`, `3561-3718`). OpenClaw chunks without splitting Slack
  entities/code markers and falls back from rejected Block Kit (OpenClaw
  `format.ts:423-541`, `send.ts:1215-1392`).
- **Baseline at research time:** It delegates standard Markdown to `markdown_text` and slices
  raw Unicode code points every 4,000 characters ([`api.ts`](../../src/adapters/slack/api.ts#L272-L293),
  [`slack-gateway.ts`](../../src/application/slack-gateway.ts#L129-L135)).
- **Benefit:** Code blocks, links, mentions, and long answers remain readable;
  optional blocks can improve structured tool/task display.
- **Size:** M for safe chunking/formatter; L for blocks and streamed block
  updates.
- **Risk:** Re-rendering Markdown can change semantics or accidentally notify
  `@channel`; blocks introduce payload limits and accessibility obligations.
- **Priority:** P2; do not block status/streaming on visual parity.

### G14. Tool progress, task/plan updates, and progress cleanup

- **Upstreams:** Hermes sends an editable throttled progress bubble, overflow
  continuations, and cleans temporary messages after successful final delivery
  (Hermes `run.py:4008-4315`, `25157-25178`). OpenClaw composes tool/reasoning/
  plan/approval progress into draft or native task-card modes (OpenClaw
  `dispatch-progress.ts:326-617`, `dispatch.ts:406-487`).
- **Baseline at research time:** `ChatHandle` exposes only complete `prompt` output to the Slack
  gateway; no tool/reasoning/progress callback or temporary message state is
  present ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L22-L47)).
- **Benefit:** Users can see which long-running tool/plan phase is active instead
  of a generic spinner.
- **Size:** L (Pi event surface, compositor, Slack update limits, cleanup,
  approval semantics, tests).
- **Risk:** Tool output may contain secrets or untrusted content; progress can
  flood/rate-limit Slack and stale updates can overwrite newer turns.
- **Priority:** P2, only after G10 and G8 are stable.

### G15. Files and attachments in ingress and delivery

- **Upstreams:** Hermes authorizes before download, hydrates Slack Connect file
  stubs, caches media/text files, and uploads with `files_upload_v2` retries
  (Hermes `adapter.py:5938-6183`, `3172-3223`). OpenClaw restricts inbound URLs
  to HTTPS Slack hosts, caps concurrency, hydrates thread-root files, and guards
  upload completion (OpenClaw `media.ts:40-379`, `thread.ts:98-170`,
  `client-delivery.ts:240-348`).
- **Baseline at research time:** The inbound schema retains only text, channel/user/type,
  timestamp, and thread; no file fields, file scopes, download/upload methods,
  or media handoff exist ([`socket.ts`](../../src/adapters/slack/socket.ts#L6-L13),
  [`docs/operations/slack.md`](../operations/slack.md#L80-L95)).
- **Benefit:** Users can ask about screenshots/documents and receive generated
  files through the same conversation.
- **Size:** L (schemas, authorization, SSRF-safe download, size/type limits,
  cache lifecycle, upload API, Pi media contract, tests, app scopes).
- **Risk:** SSRF, bearer-token leakage, malware/oversized files, retention, and
  ambiguous upload commits. Follow OpenClaw's HTTPS host/redirect and
  completion rules; do not accept arbitrary URLs.
- **Priority:** P2 unless file workflows are a stated product requirement.

### G16. Slash commands, Block Kit actions, approvals, and interactive callbacks

- **Upstreams:** Hermes ACKs slash commands immediately and uses saved
  `response_url`/ephemeral fallback; Block Kit plugin exceptions still ACK
  ([Hermes `adapter.py:2052-2156`, `2473-2520`](./hermes-slack-source-study.md)).
  OpenClaw exposes native commands/actions through its plugin route and dispatch
  surface ([OpenClaw `channel.ts:596-614`, `message-action-dispatch.ts:84-363`](./openclaw-slack-source-study.md)).
- **Baseline at research time:** It subscribes to ordinary message events only; the operations
  guide explicitly says Pi `/skill:<name>` is TUI syntax, not a Slack slash
  command ([`socket.ts`](../../src/adapters/slack/socket.ts#L353-L394),
  [`docs/operations/slack.md`](../operations/slack.md#L37-L38)).
- **Benefit:** Fast `/help`, `/stop`, approval, retry, and structured controls
  without sending natural-language messages.
- **Size:** L (Socket Mode payloads, registration/config, interaction ACK,
  authorization, response URLs, command routing, tests).
- **Risk:** Slack requires fast ACKs and interaction signatures/context; an
  unbounded command surface can bypass the owner/session policy.
- **Priority:** P3 until a concrete command/approval workflow is selected.

### G17. Rich Slack action tool surface

- **Upstreams:** OpenClaw action groups cover send/edit/delete, reactions, read,
  pins, files, member info, and emoji list with host-owned requester context
  (OpenClaw `channel-actions.ts:32-85`, `message-action-dispatch.ts:84-363`).
- **Baseline at research time:** The Slack extension's `SKILL.md` documents react, send/edit/
  delete, read, pins, member info, and emoji actions, but the current Slack
  adapter/gateway source exposes only auth, post/update, status, and Socket Mode
  transport ([`extensions/slack/skills/slack/SKILL.md`](../../extensions/slack/skills/slack/SKILL.md#L1-L143),
  [`api.ts`](../../src/adapters/slack/api.ts#L50-L89)). This is a documentation/
  implementation mismatch, not evidence of a working action tool.
- **Benefit:** The agent can perform deliberate Slack operations beyond replying.
- **Size:** L (typed action API, authorization/context ownership, rate limits,
  delete/pin/reaction/file semantics, Pi tool registration, tests).
- **Risk:** Destructive deletes/pins and cross-channel actions need explicit
  user intent and target validation; generic tool context must not supply secrets.
- **Priority:** P3; resolve the skill mismatch before advertising it as usable.

### G18. Provider health, identity inspection, and Slack-specific observability

- **Upstreams:** OpenClaw publishes connected/disconnected/blocked status, logs
  retry/backoff/identity health, and cleans all provider resources (OpenClaw
  `provider.ts:861-996`). Hermes has Socket Mode watchdog/task/transport health
  ([Hermes `adapter.py:1183-1196`, `2167-2189`](./hermes-slack-source-study.md)).
- **Baseline at research time:** Resident status proves process/scheduler health; Slack failures
  are console lines and `auth.test` returns only the bot user ID. The operations
  guide asks operators to inspect generic logs ([`resident-gateway.ts`](../../src/application/resident-gateway.ts#L120-L140),
  [`docs/operations/slack.md`](../operations/slack.md#L234-L256)).
- **Benefit:** `ziggy serve status` could say connected, reconnecting, blocked,
  last event, last delivery, and current workspace without reading logs.
- **Size:** M (typed projection, lifecycle hooks, redacted fields, CLI tests).
- **Risk:** Health can be stale or falsely green if it reports only WebSocket
  state; separate transport, admission, and delivery facts.
- **Priority:** P1 operationally; P2 if Slack remains personal-only.

### G19. Secure media/action boundaries and workspace policy enforcement

- **Upstreams:** OpenClaw checks app/team identity, preserves host-owned media and
  requester context, and restricts media URLs/redirects (OpenClaw `context.ts:649-675`,
  `message-action-dispatch.ts:84-185`, `media.ts:40-95`). Hermes authorizes before
  file download and escapes broadcast mentions (Hermes `adapter.py:3591-3597`,
  `5540-5560`).
- **Baseline at research time:** Owner-only message admission and token redaction are present,
  but no file/action paths exist; `api.test` proves token redaction only for
  adapter errors ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L89-L94),
  [`api.ts`](../../src/adapters/slack/api.ts#L107-L143)).
- **Benefit:** A future file/action surface cannot turn Slack content into SSRF,
  cross-workspace actions, secret disclosure, or accidental broadcast mentions.
- **Size:** M as a cross-cutting prerequisite to G15/G17; otherwise S for
  outbound mention escaping.
- **Risk:** Security checks added after feature code are easy to bypass; make
  identity/authorization typed boundaries first.
- **Priority:** P0 prerequisite for files/actions; P1 for output escaping.

### G20. Freshness fences and stale-output protection

- **Upstreams:** Hermes checks stream freshness after `/new`/`/stop` and drains
  late arrivals (Hermes `stream_consumer.py:795-801`, `base.py:6717-6785`).
  OpenClaw rotates delivery trackers for queued follow-ups and tracks human
  interposition in draft streams (OpenClaw `dispatch-progress.ts:567-617`,
  `draft-stream.ts:163-204`).
- **Baseline at research time:** Each fork captures its placeholder `ts`, but there is no
  generation/run ID in `InboundMessage` or `ChatState`; concurrent queued work
  can finish after a later request without a freshness check ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L67-L79),
  [`slack-gateway.ts`](../../src/application/slack-gateway.ts#L255-L335)).
- **Benefit:** A late model result cannot edit a newer placeholder or publish
  stale progress after cancellation/navigation-like state changes.
- **Size:** M (run identity, ownership checks, cancellation/settlement tests).
- **Risk:** Overly strict fencing can drop a valid final answer; define whether
  each Slack request owns a separate final message or replaces a shared draft.
- **Priority:** P0 before streaming/progress; P2 for the current per-request
  placeholder flow, where each turn already owns a distinct message timestamp.

### G21. Existing-thread history and root-context hydration

- **Upstreams:** Hermes enriches inbound events with reply/thread context before
  agent invocation (Hermes `adapter.py:5780-5925`). OpenClaw resolves thread
  starters and optionally hydrates thread history (OpenClaw
  `prepare-routing.ts:214-336`, `thread.ts:98-170`).
- **Baseline at research time:** It preserves `thread_ts` for reply placement but supplies Pi
  only the incoming text and Ziggy's existing channel session; it never reads a
  Slack thread root or prior human replies ([`socket.ts`](../../src/adapters/slack/socket.ts#L6-L13),
  [`slack-gateway.ts`](../../src/application/slack-gateway.ts#L97-L126)).
- **Benefit:** Mentioning Squarey inside an existing human thread gives the
  model the conversation it is being asked about, not only the final message.
- **Size:** M (bounded history API, schemas, authorization, prompt projection,
  and tests); larger if combined with G7 session migration.
- **Risk:** History may contain untrusted users, secrets, large payloads, or
  edited/deleted messages. Bound count/bytes and clearly mark it as untrusted
  Slack context rather than durable Profile memory.
- **Priority:** P1 for channel-thread use; P2 for DM-first use.

### G22. Rich inbound text, blocks, forwards, and unfurls

- **Upstreams:** Hermes normalizes Block Kit text, forwarded rich text,
  attachments, and unfurls while preserving commands at character zero
  (Hermes `adapter.py:5388-5485`, `5780-5925`). OpenClaw normalizes assistant
  edits, message bodies, thread starters, and room context (OpenClaw
  `events/messages.ts:254-320`, `prepare.ts:520-568`).
- **Baseline at research time:** The Socket schema accepts only the top-level Slack `text`
  fallback and rejects every message subtype; blocks, rich-text elements,
  forwarded content, edits, and unfurls are not decoded
  ([`socket.ts`](../../src/adapters/slack/socket.ts#L79-L93),
  [`socket.ts`](../../src/adapters/slack/socket.ts#L365-L383)).
- **Benefit:** Requests composed through Slack's rich editor or forwarded/shared
  content reach Pi with their actual visible meaning.
- **Size:** M for bounded rich-text normalization; L if edits must reconcile an
  already-running or persisted turn.
- **Risk:** Slack has many payload variants. Decode once at the adapter, keep
  unsupported elements explicit, and never let an edit silently replay a model
  turn.
- **Priority:** P2 unless live evidence shows lost request content.

### G23. Generated manifest, scope validation, and live Slack doctor checks

- **Upstreams:** Hermes generates a manifest with event subscriptions and
  feature-dependent scopes (Hermes `slack_cli.py:30-163`). OpenClaw documents
  and validates its account modes/scopes and publishes provider health
  (OpenClaw `setup-shared.ts:54-101`, `provider.ts:861-996`).
- **Baseline at research time:** Setup is a manual operations guide; `doctor` validates the
  local config shape, while runtime `auth.test` proves only the bot token/user
  identity. It does not project installed scopes, required event subscriptions,
  bot channel membership, or a live message round trip
  ([`docs/operations/slack.md`](../operations/slack.md#L58-L123),
  [`api.ts`](../../src/adapters/slack/api.ts#L255-L271)).
- **Benefit:** Operators can distinguish an invalid token, missing scope,
  missing subscription, absent channel membership, and client-rendering proof
  instead of treating all of them as "Slack is silent."
- **Size:** M for a generated manifest plus read-only auth/scope/health
  projection; some Slack console settings may remain manual because bot APIs do
  not expose them.
- **Risk:** A generated manifest can request excess privilege or drift from the
  code. Derive it from selected capabilities, keep least privilege, and label
  every fact that cannot be verified through Slack's APIs.
- **Priority:** P1.

## Deliberately out of scope or likely not worth importing

These are upstream capabilities, but importing them would expand Ziggy's
transport/product boundary without a demonstrated need.

### O1. Legacy RTM bot typing events

- **Upstreams:** Slack documents `user_typing` as an inbound RTM event, not a
  Web API method; the [feedback report §5](./slack-agent-feedback-options.md#5-typing-indicators-what-exists-and-what-does-not)
  cites the official event reference and FAQ. Hermes/OpenClaw's status/reaction
  behavior is the supported modern substitute.
- **Baseline at research time:** Socket Mode has no bot typing API; it uses status + placeholder
  ([`docs/operations/slack.md`](../operations/slack.md#L28-L33)).
- **Benefit:** A familiar typing affordance, but weaker than a durable status or
  visible answer.
- **Size:** L (second legacy transport and lifecycle).
- **Risk:** Legacy/deprecated transport, duplicate connection semantics, no fix
  for delivery/streaming gaps.
- **Priority:** P3 / reject.

### O2. OpenClaw HTTP webhook and relay modes

- **Upstreams:** OpenClaw supports `socket`, `http`, and `relay` account modes
  plus route collision handling (OpenClaw `config-schema.ts:26-65`,
  `provider.ts:299-365`, `http/registry.ts:19-57`).
- **Baseline at research time:** The resident intentionally owns a single Socket Mode loop and
  exposes no public request URL ([`docs/operations/slack.md`](../operations/slack.md#L1-L5),
  [`docs/operations/slack.md`](../operations/slack.md#L293-L296)).
- **Benefit:** HTTP deployment flexibility or remote relay.
- **Size:** L (server ingress/auth/signature/replay and operations).
- **Risk:** Public attack surface, deployment complexity, and a second transport
  to keep behaviorally equivalent.
- **Priority:** P3 / defer unless hosting constraints change.

### O3. Slack Agent/Assistant View and `assistant:write`

- **Upstreams:** Hermes/OpenClaw manifests/docs include `assistant:write` for
  Agent/Assistant View; Slack's March 2026 scope update allows ordinary
  channel-based `setStatus` with existing `chat:write` (see [feedback report §1](./slack-agent-feedback-options.md#1-assistantthreadssetstatus)).
- **Baseline at research time:** A blank ordinary Socket Mode app uses `chat:write` and already
  calls `assistant.threads.setStatus` ([`docs/operations/slack.md`](../operations/slack.md#L58-L95)).
- **Benefit:** Slack's top-bar/split-plane Agent experience.
- **Size:** L (Slack app feature migration, scopes, event semantics, UX and live
  proof).
- **Risk:** Adds an Agent-specific product surface and conflicts with Ziggy's
  current ordinary channel/DM contract; status does not require it.
- **Priority:** P3 / do not import for loading feedback.

### O4. Native Slack task cards as the first progress mechanism

- **Upstreams:** OpenClaw can use native Slack task cards/chunks and Hermes has
  rich progress bubbles (OpenClaw `dispatch-progress.ts:567-617`; Hermes
  `run.py:4008-4315`). Slack's streaming chunks support task/plan updates (the
  [feedback report §2](./slack-agent-feedback-options.md#2-native-text-streaming-chatstartstream-appendstream-chatstopstream)).
- **Baseline at research time:** It has no Pi tool-progress event boundary and only needs an
  immediate status/placeholder for the current problem.
- **Benefit:** Rich planning/task visualization.
- **Size:** L (same prerequisites as G10/G14 plus Slack task UX).
- **Risk:** Client/version support, rate limits, sensitive tool detail, and
  visual complexity before basic delivery correctness.
- **Priority:** P3; prefer plain streaming/draft first.

### O5. Full upstream formatting parity and arbitrary Block Kit

- **Upstreams:** Hermes/OpenClaw render rich blocks and sophisticated Slack-safe
  Markdown (anchors in G13).
- **Baseline at research time:** `markdown_text` already handles the supported basic output path.
- **Benefit:** Better tables, cards, and rich structured messages.
- **Size:** M/L depending on scope.
- **Risk:** Format conversion can damage code/links or accidentally trigger
  mentions; Block Kit has accessibility/size constraints.
- **Priority:** P3 until users report a concrete formatting failure.

### O6. OpenClaw's broad multi-user pairing/access model

- **Upstreams:** OpenClaw default pairing/open DM policy and room allowlists
  (OpenClaw `dm-auth.ts:20-71`, `context.ts:560-647`).
- **Baseline at research time:** The product deliberately admits one configured owner and
  documents other users as ignored ([`docs/operations/slack.md`](../operations/slack.md#L18-L27)).
- **Benefit:** Team/bot deployment.
- **Size:** M/L (identity, policy, memory isolation, config UX).
- **Risk:** Weakens the current simple security invariant and can expose owner
  memory if session routing is not redesigned.
- **Priority:** P3 until multi-user operation is explicitly approved; G5 is the
  bounded prerequisite if that decision changes.

### O7. Upstream-specific status emoji vocabulary and plugin callbacks

- **Upstreams:** OpenClaw has specialized coding/web/deploy/browser emojis and
  plugin progress callbacks (OpenClaw `status-reactions.ts:56-188`).
- **Baseline at research time:** It has no reactions and intentionally uses Slack status plus a
  simple placeholder.
- **Benefit:** More expressive status for tool classes.
- **Size:** M after G6/G14.
- **Risk:** Emoji states imply semantics users may not understand and create
  flicker/rate-limit behavior.
- **Priority:** P3; do not import the vocabulary before a product decision.

### O8. OpenClaw's entire Slack action catalog

- **Upstreams:** OpenClaw send/edit/delete/read/pin/member/emoji/file actions
  (OpenClaw `channel-actions.ts:32-85`).
- **Baseline at research time:** The extension documents the same shape but no executable adapter
  is present (G17).
- **Benefit:** Broad Slack automation.
- **Size:** L.
- **Risk:** Destructive external writes and permission expansion; each action
  needs explicit authorization and confirmation policy.
- **Priority:** P3; implement one approved action vertical slice instead.

### O9. Reactions as inbound agent triggers

- **Upstreams:** Hermes can turn authorized human reaction events into synthetic
  threaded prompts and explicitly drops its own lifecycle reactions to prevent
  loops (Hermes `adapter.py:4783-4969`). OpenClaw can publish reaction
  notifications through its channel event surface.
- **Baseline at research time:** It does not subscribe to reaction events, and reactions are not
  part of its request contract.
- **Benefit:** A lightweight emoji could mean approve, retry, summarize, or
  hand off without a text command.
- **Size:** M (event subscription, authorization, loop prevention, semantic
  mapping, thread/session routing, and tests).
- **Risk:** Emoji meanings are ambiguous and lifecycle reactions can recursively
  invoke the agent unless ownership/self filtering is exact.
- **Priority:** P3 / defer until one reaction has an explicit product meaning.

## Prerequisites and dependencies

These are enabling decisions/work items, not independent parity features. Each
should be resolved before the dependent gaps are called complete.

### D1. Confirm the Pi incremental-output and tool-event boundary

- **Upstreams:** Hermes/OpenClaw both receive stream/tool callbacks (Hermes
  `run.py:4583-4645`; OpenClaw `dispatch.ts:406-487`).
- **Baseline at research time:** `ChatHandle` exposes `prompt(): Effect<string, ...>` only
  ([`src/application/slack-gateway.ts`](../../src/application/slack-gateway.ts#L22-L47)).
- **Benefit:** Determines whether G10/G14 are feasible without invasive Pi
  adapter changes.
- **Size:** M for a source/API audit; L if an adapter/event bridge is needed.
- **Risk:** Guessing the Pi API creates a leaky Promise/Effect boundary and stale
  callbacks; the result must be source-pinned and typed.
- **Priority:** P1 prerequisite for G10/G14.

### D2. Capture Slack workspace/team identity at the adapter boundary

- **Upstreams:** Team-qualified keys and mismatch checks are required by both
  upstreams (anchors in G4).
- **Baseline at research time:** `auth.test` decodes only `user_id`; inbound schema omits
  `team_id`/`api_app_id` ([`api.ts`](../../src/adapters/slack/api.ts#L10-L17),
  [`socket.ts`](../../src/adapters/slack/socket.ts#L79-L89)).
- **Benefit:** Enables G4, native channel streaming recipient fields, and safe
  per-workspace status/session keys.
- **Size:** S/M.
- **Risk:** Payload shape changes need schema tests and a compatibility policy.
- **Priority:** P0 prerequisite for multi-workspace/streaming.

### D3. Choose durable storage and replay ownership

- **Upstreams:** OpenClaw durable ingress owns append/replay/adoption lifecycle
  (OpenClaw `ingress.ts:221-363`).
- **Baseline at research time:** The resident has Profile sessions and automation persistence,
  but Slack ingress state is in memory (`Queue`, `Map`, recent IDs)
  ([`socket.ts`](../../src/adapters/slack/socket.ts#L163-L170),
  [`slack-gateway.ts`](../../src/application/slack-gateway.ts#L206-L224)).
- **Benefit:** Makes G1/G2 recoverable across restart.
- **Size:** M/L depending on existing persistence primitives.
- **Risk:** Two authorities (Slack gateway and scheduler) can disagree on claims;
  define one durable owner, retention, and crash transitions.
- **Priority:** P0 prerequisite for durable ingress.

### D4. Define the request lifecycle and freshness invariant

- **Upstreams:** Hermes late-arrival drain/freshness and OpenClaw adoption/abort
  lifecycle (anchors in G2, G8, G20).
- **Baseline at research time:** Tests assert status cleanup and placeholder update but not a
  multi-turn state machine ([`slack-gateway.test.ts`](../../src/application/slack-gateway.test.ts#L89-L217)).
- **Benefit:** Gives G8/G10/G11/G20 one contract: `received → queued → running →
  delivered/failed/unknown`, with one owner for every feedback message.
- **Size:** S/M for model + focused tests.
- **Risk:** Ambiguous cancellation or unknown delivery produces either duplicate
  turns or lost user requests.
- **Priority:** P0 prerequisite.

### D5. Separate write retry policy from read/reconciliation policy

- **Upstreams:** OpenClaw's zero generic write retries and bounded signed
  reconciliation (OpenClaw `client-options.ts:28-44`, `send.ts:941-1064`).
- **Baseline at research time:** `retrySlack` applies the same loop to status, update, post, and
  final chunks ([`slack-gateway.ts`](../../src/application/slack-gateway.ts#L138-L164)).
- **Benefit:** Enables G11 without making transient status failures block turns.
- **Size:** M for taxonomy; L with metadata reconciliation.
- **Risk:** Retry classification is itself a correctness boundary; include
  unknown-commit as a first-class typed outcome.
- **Priority:** P0 prerequisite for G10 and high-volume delivery.

### D6. Decide Slack app scope and reinstall policy per optional feature

- **Upstreams:** Reactions need `reactions:write`; files need `files:read`/
  `files:write`; Socket Mode needs `connections:write`; `chat:write` covers
  current status/post/update/stream paths (Slack sources and scope table in the
  [feedback report](./slack-agent-feedback-options.md#comparison-at-a-glance)).
- **Baseline at research time:** The documented app requests only `chat:write`, history scopes,
  and `connections:write` ([`docs/operations/slack.md`](../operations/slack.md#L68-L95)).
- **Benefit:** Keeps least privilege while making scope-dependent features
  explicit and diagnosable.
- **Size:** S per feature, M for config/doctor checks.
- **Risk:** Slack scope changes require reinstall; stale installs can look like
  application bugs. Never silently request broad scopes.
- **Priority:** P0 for any chosen optional feature.

### D7. Define live proof and telemetry acceptance criteria

- **Upstreams:** Both studies distinguish fake/source tests from deployed scope,
  event, client-rendering, and live Socket Mode proof (Hermes verification
  section; OpenClaw minimal operator checklist).
- **Baseline at research time:** Operations verification proves config/startup but explicitly not
  message delivery ([`docs/operations/slack.md`](../operations/slack.md#L298-L311)).
- **Benefit:** Prevents declaring status/streaming/files complete based only on a
  `{ok:true}` fake response.
- **Size:** S/M (smoke script/checklist plus redacted lifecycle logs).
- **Risk:** Manual proof can leak secrets or be mistaken for a regression suite;
  keep tokens out and record only IDs/status classes.
- **Priority:** P0 for every shipped Slack change.

## Recommended discussion order

1. **P0 safety contract:** D2 + D4 + D5, then G11/G20. Decide whether duplicate
   or unknown Slack writes are acceptable before adding more visible surfaces.
2. **P0/P1 reliability:** G1 + G2 if Slack requests must survive resident
   restarts; otherwise explicitly document the current at-most-in-memory model.
3. **P1 user feedback:** D1, then G10. Native status and the placeholder are
   already present; progressive output depends on a real Pi event boundary.
4. **P1 operations:** G3 + G18, with D7 live proof.
5. **P2 product expansion:** G5/G7/G9/G12/G13/G14/G15 according to observed
   usage; do not import the entire upstream surface wholesale.
6. **P3 decisions:** O1–O8 remain rejected/deferred unless the product contract
   changes.
