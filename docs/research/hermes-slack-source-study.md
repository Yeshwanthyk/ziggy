# Hermes Slack source study

## Scope and source identity

**Source provenance.** This note studies the refreshed opensrc tree at
`/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main`, supplied
as byte-identical to GitHub archive commit
`3e6a081d60e8d04a03d37008464f44555bc88832` (remote `main` observed 2026-08-08).
The anchors below are absolute local paths into that tree; they are not claims
about a live deployed Ziggy process.

The user-visible question is: after a Slack message is sent, what should show
that Hermes received it and is working, and why might none of those surfaces be
visible? The important distinction is that Hermes does not have one universal
receipt. It has transport acknowledgement, optional emoji lifecycle reactions,
Slack Assistant status, optional progress bubbles, optional token streaming, and
the final response.

### Current Slack contract correction

Hermes' checked-in manifest and docs still describe `assistant:write` as the permission for custom
Assistant status. Slack's March 5, 2026 first-party changelog now permits channel-based apps to call
`assistant.threads.setStatus` with `chat:write`, without `assistant:write` or the AI assistant split
view. References below to an `assistant:write` requirement are therefore faithful descriptions of
Hermes' source and generated manifest, not the minimum current Slack API requirement. Ziggy's
ordinary Socket Mode app can use the status endpoint with its existing `chat:write` scope.

## Executive finding: the “no acknowledgement” symptom

**[Implementation]** The normal Slack message listener hands the event to the
adapter pipeline; the event can be dropped before `MessageEvent` construction by
deduplication, ignored-channel rules, bot policy, DM disablement, authorization,
channel allowlists, mention/thread gates, or an existing-session wake decision
([adapter.py:5249-5318](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5249), [adapter.py:5320-5364](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5320), [adapter.py:5522-5560](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5522), [adapter.py:5664-5741](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5664)). A silent Slack chat therefore does not prove the agent is running.

**[Implementation]** The only immediate visual receipt is the `eyes` reaction,
and it is deliberately narrow: the adapter arms lifecycle reactions only for a
1:1 DM or a message that mentions the bot, then `on_processing_start` adds
`:eyes:` ([adapter.py:6322-6339](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:6322), [adapter.py:3753-3769](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:3753)). Unmentioned channel messages, MPIM messages, and messages dropped by routing never receive it.

**[Implementation]** The second surface is `assistant.threads.setStatus`, not a
message placeholder. It only runs when Hermes can resolve a real thread; a
top-level event with no resolved thread returns without calling Slack
([adapter.py:2860-2887](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2860)). The call is best-effort and exceptions are debug-level/nonfatal
([adapter.py:2926-2955](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2926)). Thus “no status” can mean no thread, no `typing_indicator`, missing Slack authorization (`assistant:write` in Hermes' docs; current Slack also accepts `chat:write`), an unsupported context, or a transport/API failure.

**[Implementation]** Token streaming is a third, independent surface. The
gateway does not build a stream consumer unless global streaming is enabled (or
the per-platform override enables it); when built, Slack uses the edit transport
because it does not support native draft streaming
([run.py:4591-4645](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/run.py:4591), [config.py:720-742](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/config.py:720), [stream_consumer.py:1669-1710](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/stream_consumer.py:1669), [base.py:3175-3192](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:3175)). With the default `enabled: false`, there is no progressive message at all.

**[Inference / diagnostic implication]** For the reported symptom, check in this
order: (1) whether the event reaches Hermes (Socket Mode connection and event
subscriptions), (2) whether the message is admitted by Slack routing, (3) the
`eyes` reaction eligibility and `SLACK_REACTIONS`, (4) a thread plus
`typing_indicator` and status authorization, and (5) streaming/display configuration.
The final answer path is not evidence that the earlier surfaces were enabled.

## Configuration, authentication, and lifecycle

**[Implementation]** `connect()` obtains the bot token from `config.token` and
the app token from the profile-scoped secret `SLACK_APP_TOKEN`, falling back to
the process environment only for an unscoped read. Missing `SLACK_BOT_TOKEN` or
`SLACK_APP_TOKEN` is a permanent configuration failure, not a reconnectable
network failure ([adapter.py:1764-1815](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:1764)). It also supports comma-separated bot tokens and saved workspace tokens in `~/.hermes/slack_tokens.json`, warning when that plaintext credential file is broadly readable ([adapter.py:1824-1854](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:1824)).

**[Implementation]** Each token is checked with `auth_test` and mapped by
`team_id` to a workspace client and bot user ID. Reconnect tears down the old
watchdog, Socket Mode handler, and workspace clients before rebuilding them, to
avoid duplicate event delivery ([adapter.py:1856-1948](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:1856)). The Socket Mode handler is started asynchronously and a watchdog observes handler/task/transport health ([adapter.py:1183-1196](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:1183), [adapter.py:2167-2189](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2167)).

**[Implementation]** The generated manifest enables Socket Mode and declares
`chat:write`, message history/read scopes, DM open/read scopes, file scopes,
`reactions:read`, and user lookup, plus `message.channels`, `message.groups`,
`message.im`, `message.mpim`, `app_mention`, and reaction events. Assistant or
Agent view additionally adds `assistant:write` and its lifecycle/context events
([slack_cli.py:30-163](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/hermes_cli/slack_cli.py:30)). The documentation emphasizes that missing channel history events prevent Slack from delivering channel messages, while `assistant:write` controls Hermes’ custom working status ([slack.md:79-110](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/website/docs/user-guide/messaging/slack.md:79)).

**[Implementation]** Named listeners include generic messages, `app_mention`,
file lifecycle events, reactions, Assistant lifecycle events, slash commands,
and Block Kit actions. A regex catch-all listener intentionally ACKs other
subscribed event types so Slack does not see unhandled 404s and eventually
disable Event Subscriptions ([adapter.py:1951-2045](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:1951)). This is a transport-level receipt, not a user-visible “working” indicator.

## Ingress, gating, normalization, and identity

**[Implementation]** Slack Socket Mode can redeliver events after reconnects;
Hermes scopes deduplication by workspace and suppresses duplicate timestamps
([adapter.py:5309-5318](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5309)). Ignored channels are dropped before any response or status is attempted. Bot/app messages obey `allow_bots` (`none` by default, `mentions`, or `all`), and Hermes always ignores its own bot user ([adapter.py:5320-5364](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5320), [adapter.py:3106-3132](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:3106)).

**[Implementation]** 1:1 `im` DMs are mention-exempt; MPIMs are treated as
shared surfaces and obey channel-style allowlists and mention controls
([adapter.py:5518-5538](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5518)). User authorization is checked before thread lookups, display-name resolution, or file downloads ([adapter.py:5540-5560](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5540)).

**[Implementation]** Session/thread identity is explicit. DM top-level messages
normally use their own timestamp as a thread/session key; channel top-level
messages do the same when `reply_in_thread` is true, while `reply_in_thread:
false` uses a channel-wide session key and sends a non-threaded reply. Existing
thread replies retain the real root timestamp ([adapter.py:5562-5611](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5562)).

**[Implementation]** Channel admission composes `allowed_channels`,
`free_response_channels`, `require_mention`, `strict_mention`,
`thread_require_mention`, `require_mention_channels`, and optional
`ignore_other_user_mentions`. The default requires a mention for a new channel
conversation; a bot-mentioned thread is remembered for follow-ups unless strict
or thread mention gating disables that memory ([adapter.py:5613-5780](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5613), [adapter.py:8252-8370](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:8252)). The docs confirm that 1:1 DMs are always responsive, while MPIMs are not ([slack.md:532-612](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/website/docs/user-guide/messaging/slack.md:532)).

**[Implementation]** Message text is enriched before agent invocation: Block Kit
text/mentions, forwarded rich-text, unfurls/attachments, thread context, and
cached files are normalized; commands are kept at character zero so enrichment
cannot corrupt command dispatch ([adapter.py:5388-5485](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5388), [adapter.py:5780-5925](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5780), [adapter.py:6194-6203](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:6194)). The resulting `MessageEvent` carries source/thread identity, media, reply context, channel context, and team/channel metadata into `handle_message` ([adapter.py:6204-6320](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:6204)).

**[Implementation]** The base runner then invokes the gateway message handler
asynchronously, while `run.py` wires the event message/thread anchor into the
agent’s stream consumer and installs stream, interim-message, tool-progress, and
status callbacks on the `AIAgent` ([base.py:6159-6173](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:6159), [run.py:4583-4645](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/run.py:4583), [run.py:4966-4984](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/run.py:4966)). This is the handoff at which the visible working surfaces become active; an event that never reaches this background path cannot produce them.

## Receipt reactions and processing lifecycle

**[Implementation]** Reactions are controlled by `SLACK_REACTIONS`, enabled by
default. On processing start Hermes calls `reactions.add(name="eyes")`; on
success it removes `eyes` and adds `white_check_mark`; on failure it removes
`eyes` and adds `x`. Reaction API errors are debug-only and never fail the turn
([adapter.py:3722-3790](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:3722)).

**[Implementation]** The reaction lifecycle is hooked by the base adapter’s
background turn runner: typing starts, `on_processing_start` runs, the message
handler/agent runs, `on_processing_complete` receives success/failure, and
cleanup stops typing ([base.py:6111-6163](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:6111), [base.py:6627-6642](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:6627), [base.py:6688-6721](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:6688)). Therefore a reaction is not added at raw Socket Mode receipt; it appears only after the event survives ingress and the background turn begins.

**[Implementation]** Incoming human reactions are a separate, opt-in feature.
Hermes always forwards reaction hooks, but by default ACKs and drops them. With
`reaction_triggers`, it synthesizes a threaded message such as
`reaction:added:👍`, applies user authorization/allowlist, and can optionally
handoff to another channel. Self-reactions are dropped so Hermes’ own `eyes` and
final markers cannot create loops ([adapter.py:4783-4816](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:4783), [adapter.py:4862-4969](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:4862)).

## Typing, Assistant status, and placeholders

**[Implementation]** The base runner starts `_keep_typing` unless
`typing_indicator: false`. It refreshes every two seconds, bounds each
`send_typing` call to about 1.5 seconds, treats errors as nonfatal, and always
stops the platform indicator in `finally` ([base.py:5002-5086](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:5002), [base.py:6131-6157](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:6131)). It pauses this loop while waiting for approvals so Slack’s status does not prevent the user typing `/approve` or `/deny` ([base.py:5015-5019](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:5015)).

**[Implementation]** Slack’s `send_typing` resolves the event’s thread using
`reply_to`/metadata, records a workspace+channel+thread status entry, and calls
`assistant_threads_setStatus` with configured `typing_status_text`, otherwise
`is thinking...`; after 30 seconds the default changes to an elapsed
`still working… (XmYYs)` heartbeat. It returns early for ignored channels,
disconnected adapters, or no thread ([adapter.py:2860-2951](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2860)).

**[Docs / implementation contrast]** The docs say `assistant:write` is required
for the custom status and that Slack may show its own rotating generic
placeholders without it. They also clarify that Hermes’ custom status is in the
footer beneath the reply composer, while inline “Generating response…” style
indicators are Slack-owned and not controlled by Hermes ([slack.md:105-110](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/website/docs/user-guide/messaging/slack.md:105), [slack.md:467-485](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/website/docs/user-guide/messaging/slack.md:467)).

**[Implementation]** Final delivery, empty output, slash ephemeral delivery,
and pre-thread failures all call quiet status cleanup. `stop_typing` uses the
tracked workspace/thread identity and clears the Assistant status with an empty
string; ambiguity across Slack Connect workspaces is intentionally not cleared
with an unsafe channel-only client ([adapter.py:2405-2423](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2405), [adapter.py:2957-3034](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2957)).

## Progress bubbles, streaming, and `chat.update`

**[Implementation]** Tool progress is not the same as typing/status. The gateway
only starts its progress sender when `tool_progress` or `thinking_progress`
needs a queue; it skips the feature for adapters without a real edit method.
Slack therefore uses one editable progress bubble, throttled to at least 1.5
seconds between edits, with overflow continuation bubbles when needed
([run.py:4008-4063](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/run.py:4008), [run.py:4119-4171](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/run.py:4119)). Tool progress can be disabled while the ephemeral Slack status remains enabled ([run.py:25075-25120](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/run.py:25075)).

**[Implementation]** Progress edits recover from transient transport failures,
back off on flood control, and fall back to new messages for permanent edit
failures. After each progress send/edit the gateway refreshes typing
([run.py:4248-4315](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/run.py:4248)). `cleanup_progress` collects temporary progress/status message IDs and deletes them after a successful final response; failed runs retain them as breadcrumbs ([run.py:25157-25178](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/run.py:25157)).

**[Implementation]** When streaming is enabled, `GatewayStreamConsumer` sends
the first visible text as a real Slack message and edits that message with each
flush. The default edit cadence is 0.8 seconds or 24 characters, and the
consumer guards partial silence markers, balances code fences, splits overflow,
and stops editing after permanent/flood failures so final delivery can recover
([config.py:710-742](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/config.py:710), [stream_consumer.py:781-805](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/stream_consumer.py:781), [stream_consumer.py:2061-2137](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/stream_consumer.py:2061), [stream_consumer.py:2301-2407](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/stream_consumer.py:2301)). Slack is not eligible for native draft streaming, so its progressive surface is ordinary message + edit.

**[Implementation]** Slack `send` formats content, splits messages at 39,000
characters, optionally adds Block Kit only for a single chunk, posts with
`chat.postMessage`, and clears Assistant status after the final post. Empty
content still clears status; a send exception clears status and returns a
retryable result when the error looks like transport/upload failure
([adapter.py:2522-2605](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2522), [adapter.py:2608-2632](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2608)).

**[Implementation]** `edit_message` uses `chat.update`; intermediate edits stay
plain mrkdwn, final edits may add Block Kit, and a rejected block payload is
retried with `blocks=[]`. Final edits clear status. Timeout/connection failures
are marked retryable while retaining the message ID because `chat.update` is
idempotent ([adapter.py:2721-2782](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2721), [adapter.py:2783-2830](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2783)). Status callbacks use `send_or_update_status` to edit the same `(channel, thread, status_key)` bubble rather than spam new messages ([adapter.py:2678-2719](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2678)).

**[Implementation]** The base send rail retries retryable failures with one
server `Retry-After` delay or exponential backoff plus jitter. After exhaustion
it attempts a delivery-failure notice; non-network/formatting failures get a
plain-text fallback ([base.py:5367-5456](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:5367)). Agent exceptions also attempt a user-visible error message, while final cleanup still stops typing ([base.py:6695-6721](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:6695)).

## Markdown, blocks, and attachments

**[Implementation]** `format_message` first converts GFM pipe tables into aligned
fenced text, then protects fenced/inline code, converts Markdown links to Slack
`<url|label>`, preserves Slack entities and blockquotes, escapes `&<>`, maps
headings to bold, `**bold**` to Slack `*bold*`, single-star emphasis to `_italic_`,
and `~~strike~~` to `~strike~`. It escapes executable broadcast mentions such as
`<!channel>` before entity formatting ([adapter.py:3561-3718](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:3561)).

**[Implementation]** `rich_blocks` is opt-in. Standard sends retain the `text`
fallback for notifications/accessibility, use Block Kit only for a single
chunk, and retry without blocks if Slack rejects the payload. Streaming edits
avoid re-rendering blocks until the final edit ([adapter.py:2541-2582](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2541), [adapter.py:2752-2777](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2752)).

**[Implementation]** Inbound files are authorized before download, Slack
Connect stubs are expanded with `files.info`, and images/audio/video/documents
are downloaded and cached into `MessageEvent.media_urls/media_types`. Small
text-like files can be injected into the prompt; failures become attachment
notices instead of aborting the whole message ([adapter.py:5938-6018](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5938), [adapter.py:6105-6183](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:6105)). Outbound files use `files_upload_v2`, preserve caption/thread routing, and retry retryable uploads up to two times ([adapter.py:3172-3223](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:3172)).

## Slash commands and interactive tools

**[Implementation]** Native slash commands are ACKed immediately with an
ephemeral `Running /cmd…` response. The eventual command output is sent through
the saved `response_url`, with `chat.postEphemeral` fallback; Hermes refuses to
make a failed private slash response public ([adapter.py:2052-2083](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2052), [adapter.py:2473-2520](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2473)).

**[Implementation]** Approval, clarify, feedback, and plugin actions are Block
Kit handlers. Plugin exceptions are caught and followed by a best-effort ACK so
one plugin cannot poison the Slack interaction path ([adapter.py:2085-2156](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2085)). This is interaction acknowledgement, not a general acknowledgement of ordinary messages.

## Security and concurrency invariants

**[Implementation]** Workspace-scoped maps are used for bot identity, clients,
deduplication, status tracking, reactions, and session metadata. Status cleanup
refuses ambiguous channel-only clears across Slack Connect workspaces
([adapter.py:2889-2925](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2889), [adapter.py:2973-3024](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:2973)).

**[Implementation]** The base runner marks a session active before spawning its
background task, queues concurrent follow-ups instead of running two agent turns
for one session, and drains them after cleanup. It stops typing before deferred
callbacks and has a late-arrival drain so messages arriving during cleanup are
not dropped ([base.py:6075-6082](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:6075), [base.py:6644-6686](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:6644), [base.py:6717-6785](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/platforms/base.py:6717)). Streaming also checks run freshness before emitting deltas, preventing `/new` or `/stop` stale output from overwriting the current session ([stream_consumer.py:795-801](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/gateway/stream_consumer.py:795)).

**[Implementation]** The adapter escapes Slack broadcast mentions in model output,
uses private ephemeral delivery for slash replies, applies early authorization
before file downloads, and filters self/bot messages to prevent echo loops
([adapter.py:3591-3597](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:3591), [adapter.py:5540-5560](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5540), [adapter.py:5325-5364](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/plugins/platforms/slack/adapter.py:5325)).

## Verification surface

**[Implementation]** The refreshed tree contains focused tests for Slack ingress,
mention/thread gating, channel session scope, Socket Mode reconnect, dedup TTL,
send retry, status updates, streaming/edit behavior, Block Kit, attachments,
peer-agent safety, and media delivery (for example the files under
`tests/gateway/test_slack*.py`, `tests/gateway/test_stream_consumer*.py`, and
`tests/tools/test_slack_send_message*.py`); representative exact test anchors are
`test_slack.py:305`, `test_slack.py:484`, `test_slack_send_retry.py:87`,
`test_slack_status_update.py:74`, `test_slack_peer_agent_smoke.py:132`, and
`test_stream_consumer.py:275` ([test_slack.py:305](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/tests/gateway/test_slack.py:305), [test_slack.py:484](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/tests/gateway/test_slack.py:484), [test_slack_send_retry.py:87](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/tests/gateway/test_slack_send_retry.py:87), [test_slack_status_update.py:74](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/tests/gateway/test_slack_status_update.py:74), [test_slack_peer_agent_smoke.py:132](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/tests/gateway/test_slack_peer_agent_smoke.py:132), [test_stream_consumer.py:275](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/tests/gateway/test_stream_consumer.py:275)). The tests are source-level/fake
transport evidence, not proof that a deployed workspace has the generated
manifest, scopes, event subscriptions, bot invitation, or live Socket Mode
connection configured correctly.

**[Inference / practical smoke path]** To make work visible in a real Slack
workspace, use a 1:1 DM or an explicit `@Hermes` mention in an admitted channel,
ensure the app is subscribed to the matching `message.*`/`app_mention` event,
install Hermes' generated manifest (which currently includes `assistant:write`) or otherwise grant
Slack's current accepted status scope, leave `typing_indicator` enabled,
and set `streaming.enabled: true` plus the Slack platform streaming override if
progressive token edits are desired. `display.platforms.slack.tool_progress`
controls tool bubbles separately; `live_status`/Assistant status is the lower-
noise working signal. The docs’ configuration examples describe these as
separate controls ([configuration.md:1835-1857](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/website/docs/user-guide/configuration.md:1835), [configuration.md:1960-1981](/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/website/docs/user-guide/configuration.md:1960)).
