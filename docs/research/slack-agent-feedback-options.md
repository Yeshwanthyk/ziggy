# Slack acknowledgement, loading, and progressive-output options for Ziggy

Research date: 2026-08-08. Sources are Slack's first-party developer documentation only. The
implementation observations below are read from the current Ziggy worktree and are not claims about
Slack behavior unless explicitly marked as verified Slack facts.

## Executive recommendation

Ziggy's immediate user problem is feedback before the model finishes. The smallest useful change is:

1. On an accepted inbound message, call `assistant.threads.setStatus` immediately. Slack's March 5,
   2026 scope update explicitly allows channel-based apps to use AI loading states with the existing
   `chat:write` scope, without `assistant:write` or the AI assistant split view. The current ordinary
   Socket Mode app therefore has the right scope; live Slack-client proof is still required.
2. For the current ordinary DM/channel app, use `chat.startStream` → `chat.appendStream` →
   `chat.stopStream` to render the reply progressively. It uses the existing `chat:write` scope and
   works for DMs and channel threads, but requires preserving the inbound message timestamp and,
   for channel streams, the workspace team ID and recipient user ID.
3. If streaming is too large a first change, use a `chat.postMessage` placeholder such as
   `Working on that…`, retain the returned message `ts`, and replace it with `chat.update` as the
   answer progresses. This also uses the existing `chat:write` scope and works in DMs and channels.
4. Treat a reaction as an optional low-cost acknowledgement, not the primary loading indicator. It
   needs a new `reactions:write` scope and an app reinstall. Add a reaction to the user's message at
   start and remove it in a guaranteed cleanup path on completion/failure; do not use it as a typing
   substitute.

There is no supported bot typing-indicator Web API for an ordinary Events API/Socket Mode app. Slack's
`user_typing` event is RTM-only; it describes a channel member typing and is not a Web API method that
Ziggy can emit over its current Socket Mode connection.

## Current Ziggy facts

These are direct observations from the current worktree:

- The documented app is a blank Socket Mode app. Its bot scopes are `chat:write`, `im:history`,
  `channels:history`, `groups:history`, and `mpim:history`; no `assistant:write` or `reactions:write`
  is requested ([`docs/operations/slack.md:58-95`](../operations/slack.md#L58)).
- The only three persisted configuration fields are `botToken`, `appToken`, and `ownerUserId`
  ([`src/domain/slack.ts:5-11`](../../src/domain/slack.ts#L5)). There is no team ID in configuration.
- The Web API adapter currently exposes `authTest`, `postMessage`, `setStatus`, and `connectionsOpen`
  in the uncommitted worktree ([`src/adapters/slack/api.ts:43-48`](../../src/adapters/slack/api.ts#L43)).
  `postMessage` sends `chat.postMessage` with `channel`, `markdown_text`, and optional `thread_ts`
  ([`src/adapters/slack/api.ts:263-268`](../../src/adapters/slack/api.ts#L263)).
- Slack's successful `chat.postMessage` response is decoded with a `ts`, but the current adapter
  discards that value and returns `void` ([`src/adapters/slack/api.ts:14-16`](../../src/adapters/slack/api.ts#L14),
  [`src/adapters/slack/api.ts:252-267`](../../src/adapters/slack/api.ts#L252)). A placeholder/update
  implementation must change this boundary to retain the returned message timestamp.
- The gateway waits for the complete agent reply before calling `postMessage`, then sends 4,000-code-
  point chunks ([`src/application/slack-gateway.ts:18-19`](../../src/application/slack-gateway.ts#L18),
  [`src/application/slack-gateway.ts:201-205`](../../src/application/slack-gateway.ts#L201)). Therefore
  the current user sees neither an early acknowledgement nor progressive output.
- Socket message decoding preserves `channel`, `channel_type`, `user`, `text`, `ts`, and optional
  `thread_ts` ([`src/adapters/slack/socket.ts:79-89`](../../src/adapters/slack/socket.ts#L79)), but
  normalization retains only `channel` and `threadTs` for later processing
  ([`src/application/slack-gateway.ts:47-53`](../../src/application/slack-gateway.ts#L47),
  [`src/application/slack-gateway.ts:75-93`](../../src/application/slack-gateway.ts#L75)). Native
  streaming needs the triggering/root message `ts`; channel streaming additionally needs the
  workspace `team_id`, which is not currently decoded or carried.
- The uncommitted gateway work now calls `assistant.threads.setStatus` immediately and clears it in
  an acquire/use/release finalizer for every normalized message
  ([`src/application/slack-gateway.ts:201-247`](../../src/application/slack-gateway.ts#L201)). This
  is aligned with Slack's March 2026 changelog: `chat:write` is specifically sufficient for
  channel-based loading states without requesting `assistant:write` or using the AI assistant split
  view. The remaining unknown is
  actual client-visible rendering in the target workspace, not API scope or channel eligibility.

## Comparison at a glance

| Mechanism | Existing scope fit | DMs | Ordinary public/private channels | Visible feedback | Main Ziggy cost |
| --- | --- | --- | --- | --- | --- |
| `assistant.threads.setStatus` | Yes: current `chat:write` scope is explicitly supported for channel-based apps | Yes, with a valid channel/thread timestamp; DM auto-open is Agent-specific | Yes, including channel-based apps, with a valid channel/thread timestamp | Slack loading status; auto-clears on reply or after timeout; exact client visibility needs live proof | Add typed call plus cleanup; verify target workspace/client rendering |
| `chat.startStream` + `appendStream` + `stopStream` | Yes: `chat:write` | Yes | Yes, as a thread reply; channel streams require recipient user/team IDs | Native progressively rendered message | Preserve root `ts`; decode/carry `team_id`; stream agent output; always finalize/stop |
| `chat.postMessage` placeholder + `chat.update` | Yes: `chat:write` | Yes | Yes | Immediate visible message, then edits in place; notification behavior for updates is not promised by docs | Retain placeholder `ts`; add update API and cleanup/error text |
| `reactions.add` / `reactions.remove` | No: requires new `reactions:write` and reinstall | Yes | Yes | Durable reaction on the user's message; not a loading status and not typing | Add scope and reaction lifecycle; handle duplicate/missing/locked-message errors |
| Typing indicator | No supported Web API | No through current Socket Mode Web API | No through current Socket Mode Web API | None available from an ordinary Socket Mode Web API call | Would require the legacy RTM API, which is a separate transport and deprecated/legacy path |

The “Yes” entries describe Slack API conversation support, not a claim that the current Ziggy code
already implements that mechanism.

## 1. `assistant.threads.setStatus`

### Verified Slack facts

Slack documents this as “Set the status for an AI assistant thread.” It is `POST
https://slack.com/api/assistant.threads.setStatus`, accepts bot `chat:write` (and temporarily
`assistant:write`), and has a default special limit of 600 requests/minute per app per team. The
required payload is:

```json
{
  "channel_id": "D324567865",
  "thread_ts": "1724264405.531769",
  "status": "is working on your request..."
}
```

`channel_id` identifies the channel containing the assistant thread, `thread_ts` identifies the
thread's message, and `status` is required. `loading_messages` is optional and accepts at most ten
rotating strings. A typical success response is `{ "ok": true }`; failures are `{ "ok": false,
"error": "..." }`. The status has a two-minute timeout if no message is sent, and an empty `status`
also clears it. Sending a reply clears it automatically. Slack inserts the app name before the status
text. Sources: [`assistant.threads.setStatus` reference](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)
and [`Developing an agent` loading-state guidance](https://docs.slack.dev/ai/developing-agents/#providing-a-loading-state).

Slack's agent guide says to call it immediately after `message.im` so users see that the app is
working. Its adjacent caveat says that, in the Agent messaging experience, calling it after a new DM
automatically opens the thread and should only be used when the app intends to reply in that thread.
That caveat scopes the auto-open behavior; it is not a general prohibition on channel status calls.
Source: [`Developing an agent`, sections on `message.im` and loading state](https://docs.slack.dev/ai/developing-agents/#listening-for-the-messageim-event).

The directly applicable March 5, 2026 changelog resolves the apparent conflict: `assistant.threads.setStatus`
accepts either `assistant:write` or `chat:write`, and channel-based apps may use AI loading states in
channels without requesting `assistant:write` or using the AI assistant split view. Slack says the
eventual direction is `chat:write` exclusively. Source: [`Set status method scope update`](https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/).

Slack's developing-agent guide still documents the separate Agents feature needed to live in the
top bar/split plane; enabling that feature automatically adds `assistant:write`. That is a prerequisite
for the Agent surface, not for channel-based `setStatus` calls using `chat:write` after the March 2026
scope update. Slack distinguishes the Agent (`agent_view`) and older Assistant (`assistant_view`)
messaging experiences, says new apps can only use Agent, and recommends migrating away from Assistant.
Source:
[`Developing an agent`, enabling and messaging experiences](https://docs.slack.dev/ai/developing-agents/#enabling-the-agent-feature).

### DM/channel and app fit

- The endpoint's current reference and the March 2026 changelog say `chat:write` is accepted, so the
  existing Ziggy bot token has the needed scope. A successful `{ok:true}` still does not prove what the
  target Slack client renders; the loading-state visual and any notification behavior require live
  workspace/client proof.
- DMs: supported with a valid channel/thread timestamp. In the Agent messaging experience, the call
  can auto-open a new DM thread; that auto-open behavior is not a prerequisite for ordinary DM status.
- Ordinary channels: explicitly supported by the March 2026 changelog for channel-based apps, with a
  valid `channel_id` and `thread_ts`. Do not import the Agent DM auto-open caveat as a channel ban.
- Socket Mode: the Web API call itself is independent of whether inbound events arrive by HTTP or
  Socket Mode. The changelog specifically removes the need for the AI assistant split view for
  channel-based loading states.

### Accessibility, notification, and cleanup

Slack describes this as a loading/status indicator, not a normal posted message, so it avoids creating
an acknowledgement message in history. The March 2026 changelog confirms that channel-based apps can
use the loading state without the AI assistant split view. Slack's docs do not promise a push
notification or screen-reader announcement for the status, nor do they guarantee identical rendering
across clients; this is the remaining live-proof boundary.

The documented cleanup is deterministic: a reply clears the status, an empty status clears it, and a
two-minute timeout removes it if no message arrives. If the model fails, Ziggy should explicitly clear
the status rather than relying on the timeout. This final recommendation is an implementation
inference from the documented timeout/empty-string behavior.

### Recommendation for Ziggy

Make this the first fix for the current blank app. It needs no new OAuth scope or Agent-surface
migration, and it directly provides an immediate working signal for both ordinary DMs and channels.
Keep the current acquire/use/release clear path, and verify the loading state in the target Slack
workspace/client before declaring the UX proven. Native streaming remains the stronger follow-up for
progressive answer text.

## 2. Native text streaming: `chat.startStream`, `chat.appendStream`, `chat.stopStream`

### Verified Slack facts and contracts

Slack describes these three methods as a text-streaming experience for LLM responses:

1. `chat.startStream` (`POST https://slack.com/api/chat.startStream`) starts a stream.
2. `chat.appendStream` appends to the existing stream.
3. `chat.stopStream` ends/finalizes it.

All three accept bot `chat:write` and JSON or form-encoded bodies. The published rate-limit tiers are
Tier 2 (20+/minute) for `startStream`, Tier 4 (100+/minute) for `appendStream`, and Tier 2
(20+/minute) for `stopStream`. Sources: [`chat.startStream`](https://docs.slack.dev/reference/methods/chat.startStream/),
[`chat.appendStream`](https://docs.slack.dev/reference/methods/chat.appendStream/), and
[`chat.stopStream`](https://docs.slack.dev/reference/methods/chat.stopStream/).

`chat.startStream` requires `channel` and `thread_ts`. Slack says `channel` is an encoded channel
thread or DM, and streamed messages should always reply to a user request. Optional `markdown_text`
and `chunks` can seed output. For channel streams, `recipient_user_id` and `recipient_team_id` are
required; they are optional for DMs. `task_display_mode` may be `timeline`, `plan`, or `dense`.

`chat.appendStream` requires `channel`, the stream message `ts`, and `markdown_text` (each field is
limited to 12,000 characters), with optional `chunks`. `chat.stopStream` requires `channel` and
stream `ts`; it can carry final `markdown_text`, `chunks`, and `blocks`. The docs say to call stop
when there is no more text. A start success returns `{ ok: true, channel, ts }`; append returns the
same identity; stop returns `{ ok: true, channel, ts, message: { text, bot_id, ts, type: "message",
subtype: "bot_message" } }`. Sources: the method references linked above.

Chunks can be `markdown_text`, `task_update`, `plan_update`, or `blocks`. Task/plan chunk fields are
limited to 256 characters; a blocks chunk may contain at most 50 blocks, with excess blocks dropped
and a warning. The `task_update` status vocabulary is `pending`, `in_progress`, `complete`, or
`error`. This creates a richer “what is happening” signal if Ziggy later exposes tool/task progress,
but plain markdown chunks are sufficient for the initial fix.

### DM/channel and app fit

- DMs: supported. Pass the DM channel ID (`D...`) and the triggering message's root `ts` as
  `thread_ts`. The `recipient_*` fields are not required for DM starts.
- Public/private channels: supported only as a thread reply. Pass the channel ID and root user message
  `ts`; include `recipient_user_id` and `recipient_team_id` because Slack requires them for channel
  streams. The app must be able to post in the conversation and the bot must be present in the channel.
- Existing thread replies: use the incoming `thread_ts` as the root. For a top-level inbound message,
  use that message's own `ts` as the thread root. This is an implementation mapping inferred from
  Slack's requirement that `thread_ts` identify the user request and from Ziggy's current event
  fields.
- Socket Mode: compatible. These are ordinary Web API calls made with the bot token; Socket Mode only
  changes inbound/event delivery.

### Accessibility, notification, and cleanup

The stream is a message visible in the conversation, so it gives stronger proof of work than a status
indicator. Slack's streaming reference does not promise a separate notification for every appended
chunk. Treat notification behavior as client/workspace-dependent; do not use chunk frequency as a
notification strategy. A final stream is a normal bot message, and the final response object gives the
message identity.

The lifecycle is explicit in the docs: start, append, stop. There is no documented automatic finalizer
for a process crash or model failure. Ziggy should hold the returned `ts` and call `stopStream` in a
success and failure cleanup path, using a short error/failure finalization if Slack accepts it. If
`startStream` succeeds and the process dies before stop, the docs do not specify whether Slack will
auto-finalize or how long an unfinished stream remains; this is an uncertainty requiring a live test.

### Recommendation for Ziggy

This is the best long-term fit for ordinary Ziggy DMs and channels. It keeps the current `chat:write`
scope and transport, directly addresses “no typing/progress,” and avoids a new reaction permission.
The implementation must extend the adapter's typed response schemas and transport, preserve inbound
`ts` and `team_id`, and ensure stop/failure cleanup. It also requires coordinating model output into
bounded chunks instead of waiting for `ChatHandle.prompt` to return one completed string; whether Pi
0.82.0 exposes token/tool deltas at the current boundary must be checked before committing to this
slice.

## 3. Placeholder `chat.postMessage` + `chat.update`

### Verified Slack facts and contracts

`chat.postMessage` sends a message to a public channel, private channel, or DM, accepts bot
`chat:write`, and has a special rate limit. Its `channel` is required; `thread_ts` is optional and
makes the message a reply. A successful response contains `ok`, `channel`, and `ts` (the current
adapter's schema recognizes `ts` but discards it). Source: [`chat.postMessage` reference](https://docs.slack.dev/reference/methods/chat.postMessage/).

For a placeholder, post a short `text` or `markdown_text` immediately, retain `{ channel, ts }`,
then update that bot-authored message. Slack's message-sending guide explicitly demonstrates that the
post result includes the message TS. Source: [`Sending messages`, publishing example](https://docs.slack.dev/messaging/sending-and-scheduling-messages/).

`chat.update` is `POST https://slack.com/api/chat.update`, accepts bot `chat:write`, and is Tier 3
(50+/minute). It requires `channel` and the message `ts`; for DMs, Slack explicitly requires the DM
ID (`D...`), not a user ID. `text`, `markdown_text`, `blocks`, and related fields are optional update
content. Only messages posted by the authenticated user can be updated; bot users can update messages
they posted. The success response includes `ok`, `channel`, `ts`, `text`, and a message object. Sources:
[`chat.update` reference](https://docs.slack.dev/reference/methods/chat.update/).

### DM/channel and app fit

- DMs: supported, using the `D...` channel ID for both post and update.
- Public/private channels: supported, with normal channel membership/posting permissions. Preserve
  the incoming thread root when posting the placeholder so the placeholder does not break Ziggy's
  current thread behavior.
- Socket Mode: compatible; this is a normal bot-token Web API sequence.

### Accessibility, notification, and cleanup

Slack says top-level `text` is the fallback used in notifications when blocks are present, and screen
readers default to the top-level `text` rather than interior blocks. A placeholder therefore should
have a meaningful, short top-level `text` (for example, `Working on that…`) and the final update should
replace it with the complete accessible answer. Source: [`chat.postMessage` accessibility guidance](https://docs.slack.dev/reference/methods/chat.postMessage/#the-text-blocks-and-attachments-fields).

Slack documents update as modifying an existing message, but does not promise that each update emits a
new push notification. The safe UX assumption is one initial message notification at most, followed by
in-place edits; verify in the target Slack clients if notification behavior matters. This is explicitly
an inference, not a Slack guarantee.

The placeholder is durable history. If the model fails, update it to an error/ retry message, or delete
it only if that policy is intentionally chosen. Leaving a permanent “working” placeholder is the main
failure hazard. Updates can fail with `cant_update_message` if the bot does not own the message, so the
returned `ts` must not be reconstructed or confused with the user message timestamp.

### Recommendation for Ziggy

This is the smallest safe first implementation if the Pi boundary cannot provide incremental output.
It gives an immediate visible acknowledgement with the current scope and can later be replaced by
native streaming without changing the user-facing lifecycle. The adapter should return the post
identity, add a typed `chat.update` operation, and the gateway should use a generation/ownership guard
so a late result cannot overwrite a newer request's placeholder.

## 4. Reactions: `reactions.add` / `reactions.remove`

### Verified Slack facts and contracts

`reactions.add` is `POST https://slack.com/api/reactions.add`, requires bot `reactions:write`, and is
Tier 3 (50+/minute). Required fields are `channel`, `name`, and `timestamp`; success is `{ ok: true
}` and a duplicate returns `{ ok: false, error: "already_reacted" }`. Slack says the reaction is saved
and a `reaction_added` event is broadcast through Events and RTM. Source: [`reactions.add` reference](https://docs.slack.dev/reference/methods/reactions.add/).

`reactions.remove` requires `reactions:write`, is Tier 2 (20+/minute), and requires `name` plus either
the `channel` + `timestamp` pair or a file/file-comment target. It returns `{ ok: true }` or an error
such as `no_reaction`. Slack describes removal as applying to a channel message, group message, or
direct message and says a `reaction_removed` event is broadcast through RTM for the calling user.
Source: [`reactions.remove` reference](https://docs.slack.dev/reference/methods/reactions.remove/).

### DM/channel and app fit

- DMs: supported; the message target is the DM channel ID plus the user's message timestamp.
- Public/private channels: supported where the bot can access/react to the message. Slack may return
  `thread_locked`, archived/channel access, or permission errors.
- Socket Mode: the Web API calls are compatible, but the event broadcasts do not themselves provide a
  typing/loading UI and Ziggy does not currently subscribe to reaction events.

### Accessibility, notification, and cleanup

A reaction is a durable emoji annotation on the user's message, not a status message. It can be a
clear “received” marker, but it is ambiguous as “still working” and may be missed by screen readers or
notification settings. Slack's reaction method docs do not promise a user notification or a loading
semantics. Use a stable, semantically chosen emoji only if the team accepts that UX.

The lifecycle must be explicit: add once after acceptance; remove on normal completion, model error,
cancellation, or gateway shutdown. Treat `already_reacted` as an idempotent start condition only if the
reaction is known to belong to this run; never remove a reaction that the user had already placed.
Because current Ziggy has no reaction scope, this option requires app-scope change, reinstall, typed
adapter methods, and ownership bookkeeping.

### Recommendation for Ziggy

Use only as an optional immediate receipt signal, perhaps alongside streaming or a placeholder. It is
not a replacement for an actual progressive response and has more visible-history/permission risk than
the existing `chat:write` options.

## 5. Typing indicators: what exists and what does not

Slack's `user_typing` event is documented as “A channel member is typing a message.” Its required
scopes are none, but its only compatible API is `RTM`. The event payload identifies the channel and
user; it is an inbound observation, not a Web API method for an app to emit. Source: [`user_typing` event reference](https://docs.slack.dev/reference/events/user_typing/).

Slack's FAQ explicitly lists “sending `user_typing` events” as a reason to choose the legacy RTM API,
while recommending Socket Mode for most applications. Source: [`Slack FAQ`, RTM vs Socket Mode](https://api.slack.com/faq#rtm).

Therefore an ordinary Events API/Socket Mode app has no documented bot typing-indicator call. Switching
Ziggy to RTM solely for typing would introduce a separate legacy transport and would not solve the
other acknowledgement/progressive-output requirements. `assistant.threads.setStatus`, native streams,
or a visible placeholder are the supported current alternatives.

## Suggested implementation sequence

For the current configuration, in risk order:

1. Keep the immediate `assistant.threads.setStatus` call and explicit empty-status cleanup. It uses
   Ziggy's existing `chat:write` scope and is now explicitly supported for channel-based apps by the
   March 2026 Slack changelog. Verify actual rendering in the target Slack client.
2. If Pi exposes a safe incremental output boundary, add
   `chat.startStream`/`appendStream`/`stopStream`. Preserve the root message `ts`, decode Socket Mode
   `team_id`, require channel recipient IDs, and make `stopStream` a guaranteed finalizer.
3. If streaming is not immediately feasible, add a `chat.postMessage` placeholder and retain its
   returned `ts`; update it to the final answer or an explicit failure. This is the smallest durable
   visible acknowledgement fallback.
4. Optionally add a reaction only if the workspace wants a durable receipt marker and accepts adding
   `reactions:write`.

Regardless of mechanism, the request lifecycle should expose at least `received → working → completed`
or `received → working → failed`, and failures in the feedback call must not prevent the model reply.
That lifecycle statement is Ziggy design guidance, not a Slack API contract.

## Primary source index

- [Slack Socket Mode](https://api.slack.com/apis/connections/socket)
- [`assistant.threads.setStatus`](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)
- [Set status method scope update (March 5, 2026)](https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/)
- [Developing an agent](https://docs.slack.dev/ai/developing-agents/)
- [`chat.startStream`](https://docs.slack.dev/reference/methods/chat.startStream/)
- [`chat.appendStream`](https://docs.slack.dev/reference/methods/chat.appendStream/)
- [`chat.stopStream`](https://docs.slack.dev/reference/methods/chat.stopStream/)
- [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [`chat.update`](https://docs.slack.dev/reference/methods/chat.update/)
- [Sending and scheduling messages](https://docs.slack.dev/messaging/sending-and-scheduling-messages/)
- [`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add/)
- [`reactions.remove`](https://docs.slack.dev/reference/methods/reactions.remove/)
- [`user_typing` event](https://docs.slack.dev/reference/events/user_typing/)
- [Slack FAQ](https://api.slack.com/faq)
