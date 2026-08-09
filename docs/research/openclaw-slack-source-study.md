# OpenClaw Slack source study

## Source boundary and provenance

This note is based on the byte-verified OpenClaw snapshot at
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main`, which is identical to
the GitHub archive for commit `b55e1e3a554a4b55165f532dec30f53d04f5a7f2` (remote main
observed 2026-08-08). The snapshot has no `.git`; the commit identity is therefore
the supplied archive-verification fact, not a claim derived from a local checkout.

`[Impl]` means executable source, `[Docs]` means OpenClaw documentation/manifests,
`[Tests]` means test evidence, and `[Inference]` is a diagnosis or operational
conclusion derived from those facts.

## Executive diagnosis for “nothing shows while Ziggy works”

There are four different Slack-visible progress mechanisms, and they are independently
gated:

1. **Acknowledgement reaction.** The configured `ackReaction` is a reaction on the
   inbound message, not a new placeholder message. OpenClaw reads the global
   `messages.ackReactionScope`, whose default is `group-mentions`; that deliberately
   excludes direct messages. The reaction is only scheduled after the inbound message
   has passed preparation and mention/access gates. [Impl]
   `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider.ts:397-411`,
   [Impl]
   `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/prepare.ts:1408-1463`

2. **Status-reaction lifecycle.** `messages.statusReactions.enabled` is opt-in. When
   enabled, the initial acknowledgement becomes a queued/thinking/tool/done/error
   reaction state machine; when disabled, the normal configured ack remains static.
   The state machine serializes Slack calls, debounces intermediate changes, raises
   soft/hard stall reactions after 10/30 seconds by default, and cleans up old
   reactions at terminal transitions. [Impl]
   `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch-setup.ts:125-175`,
   [Impl]
   `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/src/channels/status-reactions.ts:191-353`,
   [Impl]
   `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/src/channels/status-reactions.ts:377-454`

3. **Slack Assistant thread status / typing.** OpenClaw calls
`assistant.threads.setStatus` with `"is typing..."` only when it has a Slack
   `thread_ts`. The reply pipeline starts that status and an optional temporary
   `typingReaction`, then clears both when the run stops. A top-level DM normally has
   no reply thread, so it cannot show this thread-status affordance. [Impl]
   `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/context.ts:530-550`,
   [Impl]
   `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch-setup.ts:189-247`

4. **Progressive text / draft.** Native Slack streaming and the portable draft
   preview are delivery modes, not receipt guarantees. Native streaming requires a
   reply thread; otherwise the plugin uses a draft message that is posted and then
   edited. The documented default top-level DM path is therefore “post/edit a draft,”
   not Slack’s thread-style stream/status UI. [Docs]
   `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/docs/channels/slack.md:1414-1453`

**Likely explanation for the reported symptom [Inference]:** a top-level Slack DM
with the default `group-mentions` acknowledgement scope has no ack reaction; with no
thread target it has no Assistant thread status; and a draft/native stream may not
become visible until the first partial/progress payload is emitted or the draft
throttle flushes. The first useful operator test is to set
`messages.ackReactionScope: "all"`, configure `messages.ackReaction` (for example
`"eyes"`), and use a thread-capable `replyToMode` if Slack-native status/streaming is
desired. [Docs]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/docs/channels/slack.md:1369-1412`,
[Docs]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/docs/channels/slack.md:1443-1453`

### Current Slack contract correction

OpenClaw's checked-in setup guide still recommends `assistant:write` for Assistant/Agent View and
thread status. Slack's March 5, 2026 first-party changelog now permits channel-based apps to call
`assistant.threads.setStatus` with `chat:write`, without `assistant:write` or the AI assistant split
view. The scope statements below are accurate descriptions of OpenClaw's manifest/docs; they are not
the minimum current Slack requirement for this method.

## Plugin, configuration, identity, and lifecycle

The bundled channel entry registers the Slack plugin, secret contract, runtime setter,
read-only account inspector, and HTTP route registration. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/index.ts:1-31`
The plugin advertises DM/channel/thread capabilities, native commands, reactions,
threads, media, and live capabilities for draft previews, finalization, progress, and
native streaming. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/channel.ts:596-614`

The account schema supports `socket`, `http`, and `relay` modes; bot/app/user tokens,
signing secret, relay credentials, `ackReaction`, `typingReaction`, reaction
notifications, thread history, reply modes, streaming, actions, DM policy, and
channel entries. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/config-schema.ts:26-65`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/config-schema.ts:85-144`

At startup, bot identity requires a bot token and app token in Socket Mode, or a bot
token and signing secret in HTTP mode; user identity substitutes a user token; relay
requires bot token plus URL/auth token/gateway ID. Missing required credentials fail
startup. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider.ts:299-364`,
[Docs]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/docs/channels/slack.md:1154-1163`

Socket Mode uses Bolt’s auto-reconnecting receiver with a fixed 15-second client ping
timeout. OpenClaw wraps the receiver with durable ingress, starts the ingress monitor,
then loops through socket start/wait/disconnect with bounded backoff. Permanent auth,
revocation, and missing-scope errors fail fast; recoverable failures are stopped,
logged, and retried. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider-support.ts:323-383`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider.ts:849-945`

HTTP uses the configured webhook path and signing secret. Relay attaches a dispatcher
that feeds the same message handler and marks forwarded events as mentioned. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider.ts:315-365`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider.ts:947-962`
The HTTP plugin route registry resolves account-specific webhook paths and rejects
collisions rather than silently replacing an existing route. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/http/plugin-routes.ts:12-30`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/http/registry.ts:19-57`

## Ingress, events, durability, and deduplication

Events API `event_callback` payloads are appended to the durable channel ingress queue
before Slack is acknowledged; replay then calls Bolt with the turn lifecycle attached.
Non-event callbacks are passed directly to Bolt. Relay frames follow the same durable
admission path. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/ingress.ts:221-315`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/ingress.ts:317-363`

Ingress derives a lane from workspace plus conversation (or user when no conversation
exists), and logical relay identity uses workspace/channel/timestamp. Malformed
payloads and authorization failures are classified non-retryable; relay dispatch is
transiently retryable until the relay source reattaches. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/ingress.ts:81-205`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/ingress.ts:275-315`

Slack can deliver the same post as both `message` and `app_mention`, with distinct
event IDs. The message handler merges same-flush twins by account/team/channel/timestamp,
retains mention information, claims the logical key at turn adoption, commits on
adoption, and releases on abandonment/error. Retry is limited to retryable non-relay
flush errors. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler.ts:110-178`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler.ts:183-229`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler.ts:301-363`

The registered event is literally `message`, not `message.channels` or
`message.groups`: those are subscription labels, while `channel_type` distinguishes
channel/group/DM/MPIM. `app_mention` is separately registered, and DM/MPIM
`app_mention` payloads are dropped to avoid duplication with `message.im`. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/events/messages.ts:329-355`

Bolt is configured with `ignoreSelf: false` because OpenClaw applies its own filter.
Bot-authored messages from the configured bot are dropped; bot-authored
`message_changed` is retained so assistant updates can be normalized, while other
self-events are dropped except membership events. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider-support.ts:296-320`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider-support.ts:366-383`

## Routing, sessions, and access gates

Slack routing starts with a stable peer: `user:<id>` for DMs and channel ID for rooms;
Enterprise events qualify the peer with the workspace/team. A DM scoped to the main
session is further partitioned by account and team so same-looking IDs across
workspaces cannot collide. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/prepare-routing.ts:125-175`

True room thread replies are thread-scoped. Top-level room messages stay on the channel
session unless a mention seeds a reply thread. Ordinary DM threads are a UI affordance,
not a new agent session; Slack Agent/Assistant View roots are the explicit exception.
Thread history is keyed to the thread only when configured for thread history, otherwise
to account/team/channel. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/prepare-routing.ts:214-336`
Outbound delivery maps a parent conversation plus child conversation to `to` plus
`threadId`, keeps session IDs folded, and restores unambiguous Slack ID casing at the
API boundary. Explicit reply tags are disabled when `replyToMode` is off. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/channel.ts:687-705`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/channel.ts:970-985`

DMs are enabled by default but default to pairing policy. `open` is accepted only with
`allowFrom: ["*"]`; disabled DMs, unauthorized senders, and unpaired senders are
dropped (pairing mode sends a pairing reply). [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider.ts:366-395`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/dm-auth.ts:20-71`

Room admission checks group policy, explicit channel configuration, DM/MPIM enablement,
and optional room allowlists. A channel allowlist denial on an explicit bot mention
attempts a user-visible ephemeral explanation; otherwise the event is silently dropped
from the agent path. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/context.ts:560-647`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/prepare.ts:605-647`

Room messages require a mention according to channel/account policy; DMs do not. If
mention detection is unavailable, the room event fails closed and is recorded as
dropped history. `ignoreOtherMentions` drops messages mentioning someone else. Bot
messages are off by default and can be admitted only under the configured bot policy.
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/prepare.ts:1100-1110`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/prepare.ts:1348-1375`

## Normalization, context, and media

The event handler remembers channel type before asynchronous lookups, normalizes
assistant `message_changed` records into ordinary message-shaped input, rejects
Enterprise bot-authored/subtype events, and drops self-attributed edits. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/events/messages.ts:254-320`

Preparation resolves channel type/name, room/direct/group classification, channel
config, bot policy, sender authorization, mentions, thread starter, message body, and
history. The agent envelope carries Slack message ID, channel, thread, sender, and
untrusted room metadata/system context. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/prepare.ts:520-568`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/prepare.ts:1339-1367`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/prepare.ts:1439-1479`

Inbound Slack files are downloaded through HTTPS-only, Slack-host allowlisted URLs;
bearer authorization is retained only across trusted same-origin redirects. Download
concurrency is capped at three, and forwarded/shared attachments are narrowly recognized
and limited. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/media.ts:40-95`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/media.ts:229-230`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/media.ts:336-379`
Audio clips with Slack’s video MIME metadata are remapped to audio for transcription;
file-only content gets a placeholder, and thread-root files can be hydrated as starter
context. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/media.ts:191-205`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/media.ts:300-309`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/thread.ts:98-170`

## Agent invocation and visible progress

After preparation, `dispatchChannelInboundTurn` receives the resolved agent route,
session key, inbound context, history, bot-loop protection, turn-adoption lifecycle,
skills filter, and delivery callbacks. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch.ts:356-405`

Reasoning payloads are not directly delivered as ordinary replies. Depending on config,
partial replies update the preview, reasoning updates become preview/progress lines,
tool starts update status reactions and/or progress drafts, and plan/approval/command/
patch callbacks feed the progress compositor. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch.ts:406-487`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch-progress.ts:326-373`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch-progress.ts:484-549`

The dispatch setup starts status reactions immediately when enabled, then starts
Assistant thread status and the optional typing reaction through the reply pipeline.
Room-event turns explicitly suppress typing because they are observe-style turns and
should not imply an automatic visible reply. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch-setup.ts:158-239`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch.ts:377-405`

## Reactions and receipts in detail

The ack reaction is resolved from account/global/message/agent identity settings. It
is gated by inbound event kind, DM/group/room classification, mention detection, and
the configured scope; if status reactions are enabled, the status controller owns the
ack reaction instead of issuing a second independent reaction. Reaction failures are
logged as verbose best-effort failures. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/prepare.ts:1408-1463`

Status reactions use default queued `👀`, thinking `🧠`, tool `🛠️`, done `✅`, error
`❌`, soft-stall `⏳`, and hard-stall `⚠️` mappings. Tool names can specialize to coding,
web, deploy, build, or browser-control emojis. The controller serializes calls through
a promise chain, debounces intermediate states, and keeps old reactions until cleanup
to avoid flicker. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/src/channels/status-reactions.ts:56-80`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/src/channels/status-reactions.ts:145-188`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/src/channels/status-reactions.ts:191-353`

On dispatch failure it sets the error reaction; on a visible reply it sets done and
restores the initial ack; on silent success it restores the initial state. The typing
status and typing reaction are also cleared by the reply pipeline. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch.ts:569-598`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch-setup.ts:220-247`

## Native streaming, draft previews, updates, and fallback

Native streaming calls `client.chatStream` with channel, required thread timestamp,
optional recipient team/user IDs, task display mode, and identity. The SDK can buffer
short Markdown locally; OpenClaw treats only a non-null append result as Slack-visible
delivery. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/streaming.ts:116-187`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/streaming.ts:193-232`

Stopping finalizes the stream into a normal Slack message. If buffered text has not
reached Slack and finalization returns a definitive recipient/channel/scope rejection,
OpenClaw throws `SlackStreamNotDeliveredError` with the pending text so normal
`deliverReplies` can post it. If earlier appends were delivered, known benign finalize
errors such as `user_not_found`, `team_not_found`, closed-DM recipient errors, and
unsupported channel type are swallowed; ambiguous transport failures propagate because
the send may have committed. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/streaming.ts:246-323`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/streaming.ts:326-352`

The fallback posts the pending text through the normal reply planner, preserving
threading, identity, text limits, metadata, and chunking; it then finalizes/cleans the
native stream if needed. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch-streaming.ts:217-278`

Portable draft previews post the first non-empty preview with `chat.postMessage`, retain
the channel/message IDs, and edit the same message on later throttled updates. A
conversation-boundary tracker forces a new message if a human interposes. `clear()`
deletes the preview when no final reply was committed; cleanup failures are logged.
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/draft-stream.ts:71-153`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/draft-stream.ts:163-204`
Final text is edited in place only when it fits the Slack edit byte limit and no custom
identity/media/error/split condition prevents finalization; otherwise normal delivery
is used. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch.ts:141-229`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch.ts:233-350`
The direct edit path uses `chat.update` and truncates to the UTF-8 edit limit. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/send.ts:279-300`

Progress mode can use the portable draft compositor or opt into native Slack task cards;
completion chunks are appended only after the final answer lands, and a progress receipt
can then be collapsed into the final stream message. Queued follow-ups rotate/reset the
visible stream and delivery tracker so a later turn cannot edit or dedupe against a
settled turn. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch.ts:88-121`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch-progress.ts:567-617`

## Markdown, blocks, chunking, and outbound delivery

Outbound Markdown is rendered into Slack mrkdwn with rich headings, blockquotes,
Slack-safe links, bold/italic/strike/code/code-block markers, escaped text, and
protected assistant transcript role headers. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/format.ts:423-460`
Already-rendered mrkdwn is chunked without splitting Slack entities, angle tokens,
escapes, or code markers. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/format.ts:462-541`
The normal Slack text limit is 8,000 characters; the recommended post size is 4,000,
live edit limit is 4,000 UTF-8 bytes, and Slack’s hard post truncation limit is 40,000.
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/limits.ts:1-15`

Outbound sends resolve a target/channel, serialize sends through a keyed async queue,
post native Block Kit when valid, retain accessible fallback text, split oversized text,
upload media with the first chunk as caption, and return message IDs/receipts for every
logical part. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/send.ts:1096-1121`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/send.ts:1215-1392`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/send.ts:1395-1455`

Native-data Block Kit rejection falls back to complete accessible text. Media upload
uses `files.getUploadURLExternal`, a guarded HTTPS transfer, then one completion call;
only DNS retries are allowed after the upload because completion may have committed and
an ordinary timeout retry could duplicate the file. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/send.ts:1251-1313`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/client-delivery.ts:240-348`

The Web API client uses two retries for ordinary reads/default operations, but zero
automatic retries for writes. Dedicated reads have a 30-second timeout and zero lookup
retries; mutation paths use explicit unknown-send handling instead. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/client-options.ts:28-44`
Unknown text sends are reconciled by scanning recent conversation history using signed
delivery metadata, bounded lookback/page budgets, and retryable unresolved outcomes.
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/send.ts:941-1064`

## Attachments, files, actions, and tools

The Slack action adapter exposes send/edit/delete, react/reactions, read, pin/unpin/list
pins, upload/download file, member info, and emoji list. It preserves host-owned media
and requester context rather than trusting generic tool context for sensitive fields.
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/channel-actions.ts:32-85`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/message-action-dispatch.ts:84-185`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/message-action-dispatch.ts:260-363`
Action groups are individually configurable in the account schema. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/config-schema.ts:118-143`
Slack reaction action inputs normalize common Unicode glyphs to Slack shortcodes and
treat `no_reaction` removal as idempotent while propagating unrelated API errors. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/actions.ts:110-164`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/actions.ts:240-288`

## Security and concurrency invariants

- **Self-loop prevention:** OpenClaw owns the self-event filter, including special
  handling for assistant message edits. [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider-support.ts:296-320`
- **Workspace isolation:** incoming `api_app_id` and team IDs are checked against the
  configured installation; mismatches are dropped. [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/context.ts:649-675`
- **Serialized reactions:** status reaction API calls run through one promise chain;
  duplicate/add and missing/remove errors are treated idempotently by the Slack setup.
  [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/src/channels/status-reactions.ts:232-314`,
  [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch-setup.ts:134-156`
- **Serialized sends:** normal outbound sends are keyed by account/token/recipient/
  thread/team to prevent concurrent writes from racing one another. [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/send.ts:63-75`,
  [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/send.ts:1096-1106`
- **Durable-before-ack and replay:** the ingress queue appends before HTTP ack and
  carries adoption/abort lifecycle into dispatch. [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/ingress.ts:268-296`
- **Unknown-send safety:** writes disable generic SDK retries and reconcile only with
  bounded, signed metadata scans; ambiguous native-stream failures are not retried as
  if definitely unsent. [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/client-options.ts:28-44`,
  [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/streaming.ts:252-263`
- **Media SSRF/token protection:** inbound URLs must be HTTPS Slack hosts; outbound
  uploads use guarded fetch and preserve only safe failure metadata. [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/media.ts:40-95`,
  [Impl]
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/client-delivery.ts:291-328`

## Required Slack scopes and configuration checks

The recommended manifest includes `assistant:write` for Assistant/Agent View and native
thread-status features, `chat:write` for posts/edits, `reactions:write` for ack/status/
typing reactions, `files:read`/`files:write` for media, conversation history/read
scopes for ingress/context, and `connections:write` for Socket Mode’s app token. [Docs]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/docs/channels/slack.md:344-390`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/setup-shared.ts:54-101`,
[Docs]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/docs/channels/slack.md:469-472`
`chat:write.customize` is optional and only controls custom username/icon authorship;
without it, the app identity is used. [Docs]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/docs/channels/slack.md:1133-1139`

Status and typing failures are intentionally best-effort: the `setStatus` helper catches
and logs the error, while typing reaction failures are logged and do not abort the agent
turn. Therefore a missing scope can manifest to a user as “no status/typing” while the
agent continues and eventually posts a final answer. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/context.ts:541-550`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/message-handler/dispatch-setup.ts:203-247`

## Observability and tests

The provider publishes connected/disconnected/blocked status, logs retry/backoff and
identity health, and cleans ingress, presence, relay identity, HTTP routes, and Bolt
transport on shutdown. [Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider.ts:861-945`,
[Impl]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider.ts:984-996`
Focused tests cover native stream acknowledgement/buffering, missing-scope fallback,
benign finalize errors, ambiguous transport behavior, and metadata finalization. [Tests]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/streaming.test.ts:36-179`,
[Tests]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/src/channels/status-reactions.slack-lifecycle.test.ts:38-100`
Startup cleanup is tested when durable ingress fails: ingress is stopped and Bolt is
stopped without starting the app transport. [Tests]
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/monitor/provider.ingress-start-cleanup.test.ts:32-50`

## Minimal operator checklist for the reported symptom

This is an operational checklist derived from the implementation, not a claim that the
current Ziggy runtime has any one of these settings. [Inference]

1. Confirm the event is admitted: Socket/HTTP connected, correct app/team identity,
   DM policy allows the sender, and channel policy allows the room.
2. For an immediate visible receipt in DMs, set `messages.ackReactionScope: "all"`
   and a non-empty `messages.ackReaction`; reinstall/update the app if
   `reactions:write` is missing, then restart because scope is read at provider startup.
3. For Assistant thread status, ensure the reply target has a thread timestamp and an accepted
   status scope (`chat:write` under Slack's current contract; OpenClaw's guide still recommends
   `assistant:write` for Agent View); inspect verbose logs for `slack status update failed`.
4. For the temporary emoji fallback, configure `channels.slack.typingReaction` (or
   account override) and ensure `reactions:write`; inspect `typing reaction failed`/
   `typing reaction removal failed` logs.
5. For progressive text in a top-level DM, use draft preview (`streaming.mode` not
   `off`) or make the reply thread-capable. Native streaming cannot show until Slack
   accepts a flushed append; draft preview cannot show until its first update flushes.
6. If a final answer appears but progress did not, distinguish a best-effort status
   scope/API failure from an agent/delivery failure. If no final answer appears, inspect
   ingress admission, mention/DM gates, dispatch error, and stream fallback logs before
   changing progress configuration.
