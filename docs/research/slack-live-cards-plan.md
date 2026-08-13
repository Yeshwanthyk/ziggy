# Slack live cards for Ziggy

Research date: 2026-08-13. This is an implementation plan, not a claim that Ziggy
already renders native Slack cards.

Linear's public Slack screenshot is the target UX: one in-thread card that updates
while the agent works, names the current action, lists files being changed, and
links back to the owning surface. Slack's first-party name for that surface is
**Thinking Steps** (task cards + plan blocks streamed through
`chat.startStream` / `chat.appendStream` / `chat.stopStream`). It is not a
separate "Live Cards" API.

`[Fact]` is a cited Slack, Hermes, OpenClaw, Linear, or Ziggy source.
`[Inference]` is a Ziggy-specific recommendation that follows from those facts.

## What Slack actually shipped

Slack announced Thinking Steps on 2026-02-11 and documented the agent-facing
guide on 2026-04-14.

- Changelog: [Apps can now display thinking steps](https://docs.slack.dev/changelog/2026/02/11/task-cards-plan-blocks)
- Guide: [Make your AI agent think out loud in Slack](https://slack.dev/slack-thinking-steps-ai-agents/)
- Methods: [`chat.startStream`](https://docs.slack.dev/reference/methods/chat.startStream),
  [`chat.appendStream`](https://docs.slack.dev/reference/methods/chat.appendStream),
  [`chat.stopStream`](https://docs.slack.dev/reference/methods/chat.stopStream)
- Blocks: [`task_card`](https://docs.slack.dev/reference/block-kit/blocks/task-card-block),
  [`plan`](https://docs.slack.dev/reference/block-kit/blocks/plan-block),
  [URL source](https://docs.slack.dev/reference/block-kit/block-elements/url-source-element)

**[Fact]** The existing `chat:write` scope is enough. Streamed messages must
reply to a user request (`thread_ts` is required). Channel streams also require
`recipient_user_id` and `recipient_team_id`. `task_display_mode` is `timeline`
(default), `plan`, or `dense`.

Chunks:

| Chunk | Role | Limits |
| --- | --- | --- |
| `markdown_text` | Streaming prose | 12,000 characters |
| `task_update` | One action/tool card (`id`, `title`, `status`, optional `details`/`output`/`sources`) | 256 characters per field in the stream API |
| `plan_update` | Plan title | 256 characters |
| `blocks` | Arbitrary Block Kit | 50 blocks per chunk |

Task status vocabulary: `pending`, `in_progress`, `complete`, `error`.

**[Fact]** Linear Agent coding sessions appear in Slack as this kind of live
card: issue title, status, current natural-language action, edited file paths,
and a "View in Linear" link
([Linear coding sessions](https://linear.app/docs/coding-sessions)). Linear did
not publish a separate Slack API; it is using Slack's streaming/task-card
surface as a coding-session progress object.

## Hermes Agent, checked 2026-08-13

Pinned earlier Ziggy study: Hermes archive
`3e6a081d60e8d04a03d37008464f44555bc88832` in
[hermes-slack-source-study.md](./hermes-slack-source-study.md). That tree had
progress bubbles (`chat.postMessage` + `chat.update`), Assistant status, and
reactions. It did not have native task cards.

Live `main` today (`8018f9e`, observed 2026-08-13):

| Surface | Status on Hermes `main` | Notes |
| --- | --- | --- |
| Native Slack Thinking Steps (`chat.startStream`, `task_update`) | **Not shipped** | Confirmed against current `plugins/platforms/slack/adapter.py`: zero `startStream` / `appendStream` / `task_update` references |
| Live per-tool Assistant status | **Shipped** | [#67080](https://github.com/NousResearch/hermes-agent/pull/67080) merged 2026-07-18. Status line becomes `is reading docs/api.md…` / `is running pytest tests/…` on the existing `assistant.threads.setStatus` refresh, with `display.live_status`: `full` \| `verb` \| `off` |
| Native task-card PRs | **Open, competing, not merged** | [#29496](https://github.com/NousResearch/hermes-agent/pull/29496) (minimal opt-in cards; adapter path is stale vs plugin layout). [#59010](https://github.com/NousResearch/hermes-agent/pull/59010) (richest: plan mode, reasoning cards, subagent streams, ~306s rollover, live-probed Slack quirks). Both still P3 / needs-decision |
| Desktop inbox session cards | **Shipped today, not Slack** | `feat(desktop): live task progress on inbox cards` and related sidebar work on 2026-08-13. Do not import this into the Slack gateway |

Do not wait for Hermes to merge native cards. The useful Hermes artifacts for
Ziggy are the measured Slack API physics in #59010 and the shipped live-status
phrase builder in #67080.

### Hermes #59010 physics worth encoding

These are live-probed Slack behaviors from that PR, not first-party docs:

1. Bot-token streams need **both** `recipient_team_id` and `recipient_user_id`
   (`missing_recipient_*` otherwise), even where docs call them optional for DMs.
2. `task_update` `title`/`status` **replace**; `details` **appends**. Send details
   as deltas, not full snapshots.
3. A streamed message has an absolute lifetime of about **306 seconds**. Periodic
   appends do not extend it. Later appends return `message_not_in_streaming_state`.
   Rollover: stop with a "continued below" footer, start a fresh stream, replay
   in-progress tasks. They roll at ~240–290s.
4. `msg_too_long` is per chunk, not cumulative. Titles cap near 256 characters.
5. Leading whitespace can disappear at chunk-join boundaries.
6. A rich-text `output`/`details` value that starts with `##` can render empty.

Delivery rules from that PR that match Ziggy's existing Slack contract:

- Serialize all stream writes. Parallel tool events otherwise race `startStream`.
- On any native-stream failure, self-disable for the rest of the turn and keep
  the existing text fallback alive.
- Keep the native stream **progress-only** if the final answer still uses the
  ordinary send path. Do not accidentally dump the assistant reply into a
  progress card.
- Failed tools should not always use Slack `error` (red triangle reads as agent
  breakage). Hermes maps routine tool failure to `complete` + a failure title.

## OpenClaw, for the TypeScript transport shape

OpenClaw already has native `chatStream` helpers
([`extensions/slack/src/streaming.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/slack/src/streaming.ts)
on current main): start/append/stop, `taskDisplayMode`, recipient team/user IDs,
and a `SlackStreamNotDeliveredError` so short buffered text can fall back to a
normal post. Progress dispatch can opt into native task cards.

Ziggy should copy the **lifecycle and fallback taxonomy**, not the Slack SDK.
Ziggy talks to Slack through raw `fetch` in `src/adapters/slack/api.ts` and
should keep that boundary. Do not add `@slack/web-api`.

## Current Ziggy baseline

Ziggy already has a complete non-native progress stack
([`docs/operations/slack.md`](../operations/slack.md),
[`src/application/slack-gateway.ts`](../../src/application/slack-gateway.ts)):

- 👀 → ✅ / ❌ / 🛑 reactions
- `assistant.threads.setStatus` (`is thinking...`, 30s heartbeat, `Using <tool>…`)
- Immediate `Working on that…` placeholder, then `chat.update`
- Bounded assistant-text placeholder edits (1.5s and 48 code points)
- Per-chat generation fences so cancelled/stale progress cannot overwrite a newer turn
- Pi `onProgress` already maps `message_update` and
  `tool_execution_{start,update,end}`
  ([`src/adapters/pi/pi-agent.ts`](../../src/adapters/pi/pi-agent.ts))

The earlier inventory parked native cards as O4 / P3
([slack-upstream-integration-gaps.md](./slack-upstream-integration-gaps.md#o4-native-slack-task-cards-as-the-first-progress-mechanism))
because the placeholder compositor (G10) and tool status (G14) were the first
feedback fix. That work is done. Native cards are now the next visible Slack
surface, not a substitute for delivery correctness.

### Gaps that block a Linear-like card

| Gap | Current fact | Why the card needs it |
| --- | --- | --- |
| No stream API | Adapter exposes post/update/status/reactions only | Thinking Steps is start/append/stop, not `chat.update` of Block Kit |
| No `team_id` | `auth.test` keeps only `user_id`; Socket Mode payload schema has no `team_id` | Channel `startStream` requires `recipient_team_id` |
| No recipient identity on the turn | Inbound message has `userId` but it is not carried as a stream recipient | Channel streams require `recipient_user_id` |
| Tool cards have names, not files | `ChatProgressEvent` for tools is `{ toolCallId, toolName, phase, failed }` | Linear's card lists `Edit path/to/File.swift`. Pi events already include `args`; Ziggy drops them |
| Stream lifetime | Placeholder `chat.update` has no 306s cap | Long coding turns must rollover or fall back |
| Block Kit still open (G13) | Progress is markdown_text only | Cards are structured chunks, not a general Block Kit renderer |

## Target UX for Ziggy

Map Linear's Slack card onto Ziggy without importing Linear:

| Linear card | Ziggy equivalent |
| --- | --- |
| Issue title + status circle | Plan title, default `Working on that…`, later the first-line user request (bounded) |
| "Now I'll add the border…" | Current in-progress task title, or a short assistant-text snapshot |
| `Edit rider/src/.../LoginView.swift` | One `task_update` per Pi tool, title `Edit path` / `Read path` / `Run command` from sanitized args |
| "View in Linear" | Out of v1. Ziggy has no issue tracker. A later slice can add a GitHub PR source chip if a diffs/GitHub tool result includes an https URL |

Keep the current receipts. The live card replaces the **placeholder compositor**,
not reactions or Assistant status.

Recommended visible stack during a turn:

1. 👀 on the source message (already shipped)
2. Native status `Using edit…` or, once args exist, `is editing src/foo.ts…` (Hermes #67080 shape)
3. One streamed plan card in the thread, updating as tools run
4. Final assistant answer either finalized onto that stream or posted as today if the stream failed
5. ✅ and status clear (already shipped)

## Product decisions

These should be settled before coding, but the plan has a default for each.

1. **One message vs two.** Default: **one native stream** that starts as the live
   card and receives the final markdown on `stopStream`. The current placeholder
   remains the fallback when `startStream` fails. Two-message Hermes style
   (progress stream + separate final reply) is noisier in owner DMs.
2. **Display mode.** Default: **`plan`**. Hermes and Linear both group work as
   one collapsible card. `timeline` is a later knob, not v1.
3. **Opt-in vs default.** Default: **on for Slack**, with silent fallback to
   today's placeholder. Hermes kept a flag because they already had a markdown
   progress bubble in production. Ziggy's placeholder is already that fallback.
4. **Failed tools.** Default: Hermes' mapping — routine `isError` → `complete`
   plus a `Failed: <tool>` title. Reserve Slack `error` for stream abandonment.
5. **Secrets.** Never put tool args, env, tokens, or file bodies on a card.
   Allow only a bounded path/command preview from known Pi coding tools.

## Implementation slices

Dependencies point inward: Slack adapter → application compositor → Pi progress
events. No Pi import outside `src/adapters/pi/`. Effects execute only at
`src/main.ts`.

### Slice 0 — Stream identity and typed API

No user-visible change.

- Decode `team_id` from `auth.test` and from the Events API envelope payload
  (`EventsPayloadSchema` currently has only `event_id` and `event`).
- Carry `teamId` and `recipientUserId` on the inbound/turn value used for
  delivery. Fail closed for channel streams if either is missing; DMs should
  still send both because Hermes observed `missing_recipient_*` on bot tokens.
- Add typed adapter methods, Schema-decoded, same error class as the rest of
  Slack:

```ts
startStream({ channel, threadTs, recipientUserId, recipientTeamId, taskDisplayMode, chunks? })
appendStream({ channel, ts, chunks?, markdownText? })
stopStream({ channel, ts, chunks?, markdownText? })
```

- Extend `SlackApiOperation` with `startStream` | `appendStream` | `stopStream`.
- Treat start/append/stop like other writes: no generic retry of an unknown
  start (duplicate streams), bounded retry of `rate-limited` only, unknown
  network on stop is "maybe still streaming" and must be fenced by generation.
- Tests: fake transport for recipient fields, decode failures, and
  `missing_recipient_*`.

### Slice 1 — Native stream replaces the placeholder path

User-visible: the working message becomes a Slack stream instead of
`postMessage` + `update`.

- On accepted turn, `startStream` in the same thread root already used for
  status/placeholder (`statusThreadTs` / inbound `ts`).
- Seed with `plan_update` title `Working on that…` and no tasks yet.
- Continue bounded assistant-text progress as `markdown_text` chunks, using the
  existing 1.5s / 48 code-point compositor so append rate stays inside Tier 4.
- On success, `stopStream` with the final answer markdown. On failure/stop,
  `stopStream` with `I couldn't complete that request.` / `Stopped.`
- If `startStream` fails, keep today's `Working on that…` placeholder and do
  not retry native streaming for that turn.
- `stop` / generation fence must call `stopStream` in the release path, the
  same way status is cleared today.
- Tests: start/append/stop order, fallback when start fails, stop on cancel,
  no append after generation bump.

This slice is G10's native transport. It does not yet look like Linear.

### Slice 2 — Tool calls become task cards

User-visible: the stream shows `read` / `edit` / `bash` as in-progress then
complete.

- Map existing `ChatProgressEvent` tool phases:

| Pi phase | Slack chunk |
| --- | --- |
| `start` / `update` | `task_update` `{ id: toolCallId, title: toolName, status: "in_progress" }` |
| `end` and not failed | same id, `status: "complete"` |
| `end` and failed | same id, `status: "complete"`, title `Failed: toolName` |

- `plan_update` title stays `Working on that…` until the first tool, then can
  become `Using <n> tools…` or remain static. Prefer static in v1.
- Serialize stream writes through the existing progress owner (G12 already
  serializes text and status). Do not fork a second writer.
- Cap visible tasks (Hermes-style: bounded map, drop oldest completed if needed)
  so a 40-tool turn cannot emit an unbounded chunk list.
- Tests: start→complete order per `toolCallId`, repeated same-name tools stay
  distinct, failed tool does not use Slack `error`, tool events after native
  failure still update the text fallback.

### Slice 3 — File paths and Linear-like titles

User-visible: `Edit src/foo.ts` instead of `Using edit…`.

- Pi `tool_execution_start` already has `args`. Extend `ChatProgressEvent` with
  an optional bounded `preview: string` produced **only** in
  `src/adapters/pi/pi-agent.ts`.
- Allowlist known coding tools and known arg keys (`path`, `file_path`,
  `command` for `bash`/`edit`/`read`/`write`). Reject everything else.
- Sanitize like `safeProgressToolName`: strip controls, bound to well under
  256 characters, never pass raw args objects into Slack.
- Task title examples: `Edit src/application/slack-gateway.ts`,
  `Read docs/operations/slack.md`, `Run bun test`.
- Optionally set Assistant status to the same phrase (Hermes #67080) so the
  composer footer and the card agree.
- Do not attach `sources` unless the preview is already an `https://` URL from
  a GitHub tool result. Local paths are not URLs.
- Tests: path preview, rejected unknown args, no secrets in titles, status
  phrase uses the same preview.

### Slice 4 — Long-turn rollover and live proof

- Track stream age from `startStream`. Before ~240s, `stopStream` with a short
  footer and start a new stream that replays in-progress tasks.
- On `message_not_in_streaming_state`, do the same reactively, once, then fall
  back to placeholder if rollover also fails.
- Cap rollovers. A runaway loop must not open a new stream per tool.
- Live proof in a real workspace: a read+edit turn shows a plan card while work
  is running, then a finalized answer; a `stop` leaves no spinning card; a
  channel mention includes recipient fields. Record only IDs and status classes,
  no tokens or prompt text.
- Operations: document that no new Slack scopes are required, and that channel
  streams need the bot present in the channel (already true).

### Later, not v1

- Reasoning/thinking cards (Hermes 💭 cards). Pi would need a thinking-delta
  event at the current `onProgress` boundary.
- Specialist/subagent as a second streamed message. Ziggy specialists are a
  different product than Hermes `delegate_task`.
- `dense` mode, GitHub PR source chips, "View session" links, Block Kit action
  buttons, Agent View / `assistant:write`.
- Hermes desktop inbox cards.

## What not to copy

- Hermes' full `SlackTaskStream` module, reasoning pipeline, and subagent
  fan-out. Too much surface for Ziggy's owner-only Slack face.
- OpenClaw's `@slack/web-api` `ChatStreamer`. Ziggy owns fetch + Schema.
- Linear's issue tracker, sandbox, or "View in Linear" CTA.
- A second progress architecture beside the current placeholder compositor.
  Replace or fall back; do not run both as independent writers on one turn.
- Generic Block Kit (G13) as a prerequisite. Task/plan chunks are enough.

## Test and Effect rules

- Fake Slack transport only. No live tokens in CI.
- Decode stream responses once at the adapter with Effect Schema. Application
  code sees `{ channel, ts }`, never raw JSON.
- Stream failures stay `SlackApiError`. Fallback is application policy, not a
  swallowed unknown.
- `onProgress` remains a synchronous, non-Effect callback into bounded queues,
  matching the current Pi adapter contract. The compositor Effect owns the
  Slack writes.
- Focused tests for: recipient identity, chunk mapping, fallback, freshness,
  cancel/stop finalization, path sanitization. No tests whose only job is to
  exist.

## Suggested commit order if this plan is approved

1. Slice 0: `team_id` / recipient fields + stream API + tests
2. Slice 1: gateway uses the stream as the working message, placeholder fallback
3. Slice 2: tool → `task_update`
4. Slice 3: Pi path preview + richer titles/status
5. Slice 4: rollover + operations note + live proof checklist

That order keeps a shippable Slack face after every commit: first a native
streaming answer, then cards, then coding-session detail.
