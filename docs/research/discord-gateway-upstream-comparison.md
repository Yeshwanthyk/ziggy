# Discord gateway setup, state, and operator UX comparison

Research date: 2026-08-09. This note is a source-grounded comparison of the
Ziggy checkout and the pinned OpenClaw and Hermes Agent snapshots. It describes
the baseline as inspected at Ziggy `ca27d16` (`feat: keep Slack channel replies
in threads`). The worktree was already dirty; unrelated changes were not
modified. `[Fact]` is directly implemented or documented at the cited anchor,
`[Inference]` follows from those facts, and `[Gap]` is not proven by the cited
source or local checks.

> Implementation follow-through: the baseline below records the pre-change state used for the
> comparison. The selected slices were subsequently implemented in this worktree: native
> message-thread session identity, visible queued/working/progress/failure/stopped UX, scoped stop
> with generation fencing, receipt-backed message edits, Discord-native typing and source-message
> reaction settlement, socket lifecycle events, a strict content-free Discord health projection
> consumed by `doctor` and `serve status`, and a strict owner-fenced Discord ingress journal with
> startup recovery and replay. A bounded file-only-capable image slice accepts four validated
> Discord CDN images and persists only their replay metadata until terminal erasure. Narrow,
> owner-only global `/status` and `/stop` commands now provide private thread/DM controls without
> importing an arbitrary command surface. The operations guide is the current setup/runbook; this
> note preserves the research contrast that led to those choices.

## Source pins and proof boundary

| System       | Pin                                                                                                          | Snapshot/source location                                                                                                 | Proof boundary                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ziggy        | `ca27d16`                                                                                                    | this checkout                                                                                                            | Source, focused tests, and setup documentation; no live Discord reply was proven in this baseline.                                                                      |
| OpenClaw     | historical study pin `7492f6937c6144121a42632408dd7ffa01f850f1`; current export is **not commit-verifiable** | `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main` (`package.json` 2026.8.1; files stamped 2026-08-08 19:22) | The requested export has no `.git`; `git rev-parse`/`git log` fail. Claims below are pinned to this snapshot fingerprint, not falsely attributed to the historical SHA. |
| Hermes Agent | historical study pin `36cb5ae5530a75def7df3195e49b7a4aa2add482`; current export is **not commit-verifiable** | `/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main`                                                   | The requested export likewise has no `.git`; use the cited source files plus this nominal study pin, with no claim that a live Hermes gateway was exercised here.       |

The two historical upstream SHAs above are retained because they are the
revisions pinned by the repository's prior source study
(`docs/research/hermes-openclaw-service-supervision.md:7-10`), but neither
opensrc export contains Git metadata. This is an explicit revision limitation,
not a claim that the exports can be reproduced by SHA.

Recent Ziggy Slack commits are useful implementation context, not Discord
evidence: `313b8d4` setup docs, `495aedb` observable/reliable turns,
`a90a326` runtime health, `aa6250a` durable ingress, `e8ed5e0` scoped
cancellation, `2250b96` progress, `9c5c895` channel activation, and `ca27d16`
thread-preserving replies.

## The short comparison

Ziggy is deliberately a small, owner-only face inside one Profile and one
`ziggy serve` resident. It already has a strong Discord transport boundary:
strict config decoding, typed HTTP/socket failures, bounded reconnect/resume,
heartbeat supervision, queue bounds, and a bounded in-memory message-ID
dedupe set. Its operator UX currently proves only Profile/config validity,
resident process ownership, scheduler state, and logs. It cannot truthfully
say whether Discord is connected, whether a turn is queued/running, or whether
the latest reply was delivered.

OpenClaw has the broadest operator and Discord surface: account/channel
configuration, doctor repairs, allowlists, route/session keys, thread binding,
native commands, typing/status, draft/progressive output, and a Gateway/UI
projection. Hermes has the clearest setup and failure guidance for a single
Profile: explicit intents and permissions, fail-closed authorization, thread
and per-user session policy, liveness checks that combine socket/READY/
heartbeat evidence, and persisted reconnect recovery. Both are much larger
systems than Ziggy; copying their account/multiplexing or command surfaces
would cross Ziggy's current product boundary.

## Ziggy current execution map

### Configuration and resident ownership

- `[Fact]` `DiscordGatewayConfig` accepts exactly non-empty `botToken` and a
  numeric-string `ownerUserId`; JSON decoding rejects excess properties
  (`src/domain/discord.ts:3-20`).
- `[Fact]` `<profile>/discord.json` is optional. A present file is decoded
  during resident preflight; a malformed present file fails before ownership,
  scheduler, or channel work (`src/application/resident-gateway.ts:39-51`,
  `src/application/resident-gateway.test.ts:22-98`). With no channel config,
  the resident is valid and scheduler-only (`src/application/resident-gateway.ts:99-127`).
- `[Fact]` the single resident owns scheduler, Telegram, Discord, and Slack;
  a typed Discord failure is logged as `[gateway] Discord stopped: ...` and
  isolated from siblings (`src/application/resident-gateway.ts:94-145`,
  `src/application/resident-gateway.test.ts:100-143`).
- `[Fact]` `ziggy serve status` reports managed service/supervisor/process/
  scheduler/Slack projections, but no Discord projection; `ziggy serve logs`
  exposes service stdout/stderr (`src/application/resident-service.ts:51-78,
516-555`, `src/faces/serve-cli.ts:86-163`, `src/main.ts:472-489`).

### Connection and transport lifecycle

- `[Fact]` the application asks for `Guilds | GuildMessages | DirectMessages |
MessageContent` (`src/application/discord-gateway.ts:18-20`; the value passed
  in `src/application/discord-gateway.ts:165-171` is `37377`). Ziggy does not
  request Presence or Server Members intents.
- `[Fact]` the socket starts with a fresh connect, performs `/gateway/bot`,
  opens a WebSocket, sends IDENTIFY or RESUME after HELLO, tracks READY/
  RESUMED sequence/session state, heartbeat ACK, and reconnects with bounded
  exponential delay (`src/adapters/discord/socket.ts:202-225,
291-355, 416-583`). Invalid-session and fatal close handling are explicit
  (`src/adapters/discord/socket.ts:493-515, 593-619`).
- `[Fact]` HTTP 401/403 is non-retriable authentication; 429 and 5xx are
  retriable with retry-after/backoff; transport errors redact the token
  (`src/adapters/discord/api.ts:24-50, 100-120, 123-151`).
- `[Fact]` inbound and command queues are bounded; overflow fails closed. The
  socket uses a recent-ID set capped at 1,000 and drops duplicate message IDs
  in memory (`src/adapters/discord/socket.ts:208-224, 447-474`;
  `src/adapters/discord/socket.test.ts:239-256`).
- `[Inference]` transport reconnection is stronger than the operator
  projection: READY/RESUMED and heartbeat are authoritative inside the socket,
  but they are not persisted or displayed outside the running fiber.

### Message, session, and turn lifecycle

- `[Fact]` admission is owner-only, bot/self messages are ignored, blank text
  is ignored, DMs map to `user-<owner-id>`, and guild messages map to
  `group-dc<channel-id>` (`src/application/discord-gateway.ts:47-90`; tests
  `src/application/discord-gateway.test.ts:23-45`).
- `[Fact]` each chat key gets one semaphore and one Pi `ChatHandle`; the handle
  is opened through the existing `ZiggyAgent.openChat` at
  `sessions/discord/<chat-key>` and replies are posted in Unicode-code-point
  chunks of at most 2,000 (`src/application/discord-gateway.ts:181-207`;
  tests `src/application/discord-gateway.test.ts:47-121`).
- `[Fact]` the current path has no explicit accepted/queued/working/progress/
  cancelled/delivered state. Admission forks `processMessage`; a per-chat
  semaphore makes later turns wait, the Pi prompt runs, output posts, then one
  bounded success log is emitted. Failures are only a bounded error log
  (`src/application/discord-gateway.ts:181-224`).
- `[Fact]` shutdown disposes chat handles, but there is no Discord stop command,
  cancellation API, progress message, durable turn ledger, or delivery receipt
  (`src/application/discord-gateway.ts:131-145, 172-179`; `docs/operations/discord.md:25-29`).
- `[Gap]` Discord message payload decoding carries message ID/channel/guild/
  author/content only; there is no thread/root identifier, so all messages in
  a guild channel share one group route (`src/adapters/discord/socket.ts:97-113`,
  `src/application/discord-gateway.ts:73-89`).

### Lifecycle parity and proof tiers

| State/flow                      | Ziggy baseline                                                                                                                                                                 | Upstream evidence                                                                                                                                                                                                     | Smallest truthful operator surface                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Config absent/invalid           | Absent Discord file is a valid scheduler-only resident; present malformed JSON fails preflight (`src/application/resident-gateway.ts:39-51, 99-127`)                           | OpenClaw doctor repairs config; Hermes documents missing-token/intent/permission repair (`extensions/discord/src/doctor.ts:112-216`; `website/docs/user-guide/messaging/discord.md:128-146`)                          | `doctor`: `not configured` vs actionable `invalid`                                   |
| Credentials/intents/permissions | Token auth is typed; requested intents are fixed; no live permission probe (`src/adapters/discord/api.ts:24-50`; `src/application/discord-gateway.ts:18-20`)                   | OpenClaw/Hermes expose actionable account/setup checks (`extensions/discord/src/doctor.ts:112-216`; `website/docs/user-guide/messaging/discord.md:28-39, 196-229`)                                                    | Token-free setup/doctor diagnostics                                                  |
| Connect/reconnect/auth failure  | READY/RESUMED, heartbeat, bounded reconnect; 401/403 non-retriable; branch failure only logs (`src/adapters/discord/socket.ts:416-619`; `src/adapters/discord/api.ts:100-151`) | Provider lifecycle/health snapshots distinguish recovering vs blocked (`extensions/discord/src/monitor/provider.lifecycle.ts:322-505`; `src/gateway/channel-health-policy.ts:82-191`)                                 | `starting/connected/reconnecting/failed/stopped` plus last error/freshness           |
| Accepted/ignored                | Owner accepted; bot/self/blank ignored; no projection (`src/application/discord-gateway.ts:47-90`)                                                                             | OpenClaw preflight distinguishes ignored/denied/pairing/mention decisions (`extensions/discord/src/monitor/message-handler.preflight.ts:662-831`)                                                                     | Content-free admission event and reason                                              |
| Queued/running/progress         | Semaphore implies wait; no visible queue/running/progress state (`src/application/discord-gateway.ts:181-224`)                                                                 | OpenClaw draft/progress and Hermes typing/status/batching are tested/documented (`extensions/discord/src/monitor/message-handler.process-progress.ts:78-218`; `website/docs/user-guide/messaging/discord.md:336-390`) | Per-root placeholder + bounded progress with run/generation fence                    |
| Cancelled/failed                | Shutdown disposes handles; no user stop/cancel; failures are logs (`src/application/discord-gateway.ts:131-145, 172-224`)                                                      | OpenClaw cancellation/final failure recovery; Hermes scoped `/stop` (`extensions/discord/src/monitor/message-handler.process.draft-progress.test.ts:570-731`; `website/docs/user-guide/messaging/discord.md:336-390`) | Same-root owner stop and terminal failure message                                    |
| Delivered/unknown               | Successful HTTP post is followed by a log, but no receipt/ambiguous-send state (`src/application/discord-gateway.ts:195-224`)                                                  | OpenClaw distinguishes final delivery/partial recovery; ingress claims settle or abandon (`extensions/discord/src/monitor/message-run-queue.ts:33-151`)                                                               | `delivered`, `failed`, `delivery-unknown`; never claim delivery from process success |
| Dedupe/replay                   | Recent message IDs capped at 1,000 in memory; restart replay is unproven (`src/adapters/discord/socket.ts:208-224, 447-474`)                                                   | OpenClaw persists ingress claims; Hermes persists recovery and supports RESUME/backfill (`extensions/discord/src/monitor/ingress.ts:46-163`; `plugins/platforms/discord/recovery.py:1-110`)                           | Keep fast path; add durable ledger only behind restart/replay acceptance gates       |

### Setup and proof UX

- `[Fact]` `ziggy doctor` validates present gateway files and reports a generic
  `gateways` count; it does not contact Discord or validate intents, install,
  channel permissions, or live delivery (`src/application/doctor.ts:238-257`;
  `src/faces/doctor-cli.ts:8-12`; `docs/operations/discord.md:47-52`).
- `[Fact]` the setup guide correctly calls out Message Content Intent, minimal
  View Channels/Send Messages permissions, owner ID, restart, `serve status`,
  `serve logs --follow`, channel/session continuity, and a bounded
  `[discord] group-dc... in:... out:... chars` log line
  (`docs/operations/discord.md:64-91, 103-170`).
- `[Fact]` the guide's verification record says strict setup, Gateway auth,
  resident restart, and live reply proof were pending at the baseline
  (`docs/operations/discord.md:209-231`).
- `[Gap]` resident health is therefore process/scheduler truth, not Discord
  application truth. A running resident can have a stopped Discord branch;
  the guide says this explicitly (`docs/operations/discord.md:173-190`).

## Upstream operator patterns

### OpenClaw

- `[Fact]` the Discord extension resolves account/channel policy, allowlists,
  thread-binding settings, and session routing before starting the monitor
  (`extensions/discord/src/monitor/provider.ts:143-202, 257-293`). Its provider
  startup log includes `gatewayConnected` and reconnect attempts
  (`extensions/discord/src/monitor/provider.startup-log.ts:1-15`).
- `[Fact]` Discord doctor logic produces actionable warnings and repair guidance
  for missing tokens, numeric IDs, mutable allowlist entries, and invalid
  configuration (`extensions/discord/src/doctor.ts:112-216, 223-316`).
- `[Fact]` route/session identity is explicit and can bind a thread to a stable
  session key; unlike Ziggy's channel-only key, this supports DM, channel,
  thread, guild, and account specificity (`extensions/discord/src/monitor/route-resolution.ts:1-145`,
  `src/gateway/session-store-key.ts:60-104`).
- `[Fact]` Discord draft streaming has explicit modes and tests for delayed
  progress, tool narration, final replacement, cancellation, and no updates
  after final delivery (`extensions/discord/src/monitor/message-handler.process.draft-final.test.ts:128-173,
251-347, 599-660`).
- `[Fact]` the OpenClaw operator UI subscribes to a gateway snapshot, exposes a
  connected/readiness phase, and fences requests by client/epoch so stale work
  from a replaced connection cannot settle into the current UI
  (`ui/src/lit/gateway-page-controller.ts:30-36, 58-90, 161-168`,
  `ui/src/lib/gateway-connection-lifecycle.ts:24-53`).
- `[Inference]` OpenClaw's strongest transferable pattern is an operator-visible
  projection fed by gateway truth plus a stable session/thread key. Its broad
  account routing, native command registry, and multi-agent bindings are not
  prerequisites for Ziggy's owner-only Profile.

### Hermes Agent

- `[Fact]` Hermes setup explicitly documents Message Content and Server Members
  intents, minimum View Channel/Read Message History/Send Messages permissions,
  allowlists, and restart/troubleshooting (`website/docs/user-guide/messaging/discord.md:28-39,
128-146, 196-229, 800-869`).
- `[Fact]` Hermes documents distinct DM, channel, and thread session namespaces,
  with optional per-user isolation in shared channels and scoped interruption
  (`website/docs/user-guide/messaging/discord.md:41-83`).
- `[Fact]` Hermes does not treat REST success as Gateway liveness. Its Discord
  adapter combines READY/socket openness/closure, heartbeat ACK age, and finite
  heartbeat latency, then emits a retryable fatal event after consecutive
  unhealthy samples (`website/docs/user-guide/messaging/discord.md:85-89`;
  `plugins/platforms/discord/adapter.py:1059-1110, 1541-1698`).
- `[Fact]` Hermes has persistent thread participation, typing tasks, a durable
  recovery store, RESUME-based replay, and optional missed-message backfill
  (`plugins/platforms/discord/adapter.py:1063-1125, 2108-2199`,
  `plugins/platforms/discord/recovery.py:1-110`).
- `[Fact]` the adapter supports slash commands such as `/status` and `/stop`,
  native status/typing, auto-threading, and bounded progressive text batching
  (`plugins/platforms/discord/adapter.py:995-1040, 1063-1140`; docs
  `website/docs/user-guide/messaging/discord.md:336-390`).
- `[Inference]` Hermes demonstrates that setup can remain Profile-scoped while
  Discord runtime truth is richer than a process PID. Its role-based/multi-user
  policy, slash command surface, attachments, voice, and backfill are outside
  Ziggy's smallest owner-only slice.

## Authority, derived state, and displayed state

| Concern                 | Authoritative owner in Ziggy                                                       | Derived projection today                       | Displayed/operator proof today                                      |
| ----------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| Profile/config validity | Profile files plus Effect Schema decoders                                          | `doctor` gateway count/error                   | `ziggy doctor` `gateways` row                                       |
| Resident ownership      | `.runtime/gateway-owner.lock` and lease                                            | `GatewayOwnerStatus` (`stopped/running/stale`) | `serve status` process/PID/acquired-at                              |
| Scheduler liveness      | scheduler SQLite heartbeat/run ledger                                              | `AutomationStatusProjection`                   | `serve status` scheduler lines                                      |
| Discord WebSocket       | live `openDiscordSocket` fiber: current socket, READY/RESUMED, sequence, heartbeat | none persisted                                 | only logs on terminal branch/failure                                |
| Discord turn admission  | `normalizeDiscordMessage` + chat semaphore                                         | none                                           | no accepted/queued row                                              |
| Pi session identity     | `ZiggyAgent.openChat` path and Pi session files                                    | `sessions` metadata                            | `ziggy sessions` (not Discord route health)                         |
| Discord delivery        | `createMessage` calls and HTTP result                                              | one success/failure log                        | bounded `[discord] ... in/out chars` line and visible Discord reply |
| Freshness               | none for Discord                                                                   | none                                           | cannot distinguish connected, stale, or not observed                |

The operator-facing state should remain a projection. The socket and turn
runtime must remain authoritative; a health file or `serve status` row must
never be used to drive reconnect or replay. This mirrors the Slack health
pattern (`src/domain/slack-health.ts:5-64`; `src/application/slack-gateway.ts:598-620`)
and preserves the existing face -> application -> domain boundary.

## Compact parity matrix

| Capability                   | Ziggy baseline                            | OpenClaw                                 | Hermes                                     | Smallest useful Ziggy direction                                            |
| ---------------------------- | ----------------------------------------- | ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| Optional strict config       | strict two-field JSON; no live validation | rich config/doctor/repair                | Profile/env setup and troubleshooting      | keep strict config; add actionable checks only                             |
| Owner/auth policy            | one numeric owner ID; bot/blank filtered  | account + user/guild/channel/role policy | users/roles/channels, fail-closed defaults | preserve owner-only policy                                                 |
| Intents/permissions proof    | documented, not live-probed               | doctor/account diagnostics               | documented and actionable                  | doctor explains required intent/permission failures                        |
| Connect/reconnect            | bounded fresh/resume + heartbeat          | provider monitor/reconnect and status    | liveness watchdog + supervisor recovery    | project socket state; do not add a second reconnect loop                   |
| DM/channel sessions          | owner DM + channel group                  | account/peer/thread/session keys         | DM/channel/thread/per-user keys            | add thread/root key while reusing Pi `openChat`                            |
| Accepted/queued/running      | implicit fork + semaphore                 | explicit runtime/UI event paths          | gateway queue/session lifecycle            | add bounded per-chat turn state                                            |
| Progress UX                  | none                                      | draft stream/tool narration              | typing/status/progressive batching         | placeholder/progress message with freshness fence                          |
| Stop/cancel                  | shutdown only                             | abort/cancel paths                       | `/stop` and scoped interruption            | owner-only stop command, same chat/root only                               |
| Dedupe/replay                | 1,000-ID in-memory recent set             | durable Gateway/session/event mechanisms | durable recovery + optional backfill       | defer ledger until replay is required; retain fast-path dedupe             |
| Health/freshness             | process/scheduler only; no Discord row    | gateway/account/status projection        | socket/heartbeat liveness + logs           | `.runtime/discord-health.json` + stale warning                             |
| Setup/status/logs/live proof | docs + doctor + serve logs; no live proof | setup/doctor/status/UI surfaces          | setup/doctor/status/logs                   | `doctor` config checks, `serve status` Discord projection, live reply gate |

## Recommended bounded slices

These slices are intentionally gateway UI/UX work. They do not replace Pi,
introduce a Discord daemon, alter Profile policy, or create a second resident.

### Slice 1: explicit DM/channel/thread session identity (S, P0)

Extend the Discord inbound payload with an optional Discord thread/root ID and
derive stable route keys:

```text
DM                         user-<owner-id>
guild channel root          group-dc<channel-id>
guild thread/root           group-dc<channel-id>-thread-<root-id>
```

Pass the same existing `ChatContext`/`openChat` seam and keep all session files
under `sessions/discord/`. Do not add multi-user or agent routing.

Acceptance gates: DM continuity remains unchanged; two channels remain isolated;
two threads in one channel are isolated; a thread reply never falls back to the
channel root; all derived IDs pass the existing memory-ID sanitizer; tests prove
the exact route/session directory and no cross-context memory.

### Slice 2: admitted → queued → working/progress → terminal UX (M, P0)

Add a domain-owned, content-free turn projection for each chat/root with
`accepted`, `queued`, `running`, `completed`, `cancelled`, `failed`, and
`delivery-unknown` terminal states plus counters/timestamps. The application
owns transitions; a renderer uses them for `serve status` and bounded logs.
Add one visible Discord placeholder or status message after admission, update it
at a bounded cadence, replace it with the final answer, and clear/replace it on
stop or failure. Use a per-turn generation/run ID so late Pi or delivery work
cannot overwrite a newer turn (the same freshness principle now used by Slack).

Acceptance gates: a second same-root turn visibly queues; working/progress is
observable without prompt/answer leakage; successful final delivery settles as
`delivered`; non-retriable API failure settles `failed`; ambiguous send settles
`delivery-unknown` without unsafe retry; stop prevents stale progress/final
answers; cleanup always clears status; Unicode and 2,000-code-point chunking
remain safe.

### Slice 3: Discord health/freshness and operator projections (S-M, P0)

Persist a content-free `.runtime/discord-health.json` through an atomic,
profile-local adapter. Evolve it from connection/turn events, analogous to
`slack-health`, but never make it socket authority. Include `starting`,
`connected`, `reconnecting`, `failed`, `stopped`, last-connected/heartbeat/
inbound/turn times, active/queued counts, and last failure. Add independent
`discord: not configured | not observed | stale | connected | failed` lines to
`serve status`; add a `discord-runtime` doctor check that distinguishes config
validity from no observation/stale/failure.

Acceptance gates: absent config says not configured; valid config with no runtime
says not observed; old snapshot says stale; live heartbeat updates freshness;
authentication/intent/permission failure is actionable and token-free; a Discord
failure does not degrade scheduler/Slack projections; `serve status` exit code
degrades when Discord is stale/failed.

### Slice 4: durable ingress/replay (implemented, L, P1)

The restart requirement became concrete after live Discord operation. Ziggy now uses a small
Profile-local `.runtime/discord-ingress.sqlite` ledger keyed by Discord source message ID with
`received → running → completed/failed/cancelled/unknown`, a resident UUID owner, timestamps, and
bounded terminal retention. It commits after the DM/thread conversation route is stable and before
scheduling Pi; startup returns foreign-owner running rows to received and schedules replayable rows
in original admission order before waiting for new Gateway messages. Running and terminal
transitions are owner-fenced, terminal settlement erases prompt text, and duplicate source message
IDs are rejected before Pi.

Focused acceptance gates prove duplicate suppression, deterministic replay ordering, single-owner
claims, recovery of only foreign running rows, terminal non-replay, prompt erasure, unknown-schema
failure, and a 1,000-row terminal bound that never prunes pending work. The resulting contract is
durable at-least-once accepted ingress after conversation resolution, not exactly-once model
execution or Discord delivery. Thread creation remains before the journal because its successful
Discord-assigned thread ID is part of session identity; ambiguous create-message delivery still
requires a later delivery-reconciliation slice before Ziggy can use `unknown` precisely.

## Explicit exclusions

Do not import OpenClaw's multi-account/multi-agent binding graph, Hermes's
role-based multi-user policy, broad slash-command registry, voice machinery,
auto-thread naming, arbitrary Discord actions, or a separate Discord daemon.
Do not use a PID, heartbeat file, or health projection as proof that a live
message can be received or delivered. The final live proof remains two-sided:
the operator observes `serve status`/logs and Discord displays the reply in the
intended DM/channel/thread.

## Baseline verification

The focused baseline suite passed on Bun 1.3.13: 35 tests, 0 failures, across
`src/application/discord-gateway.test.ts`,
`src/adapters/discord/socket.test.ts`, `src/adapters/discord/api.test.ts`,
`src/application/resident-gateway.test.ts`, `src/application/doctor.test.ts`,
and `src/faces/serve-cli.test.ts`. This is local/fake transport proof only; it
does not prove Discord Developer Portal intents, installation permissions,
Gateway authentication, a live reply, or deployed status freshness.
