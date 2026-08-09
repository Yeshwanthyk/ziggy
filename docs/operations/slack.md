# Connect a Profile to Slack

This guide connects one Ziggy Profile to Slack through Slack Socket Mode. It uses no public webhook,
request URL, inbound port, or Slack-specific daemon. The existing `ziggy serve <profile>` resident
owns the Slack loop alongside the automation scheduler and any other configured channels.

The procedure below was verified through Slack app creation, strict Profile configuration, doctor,
managed macOS LaunchAgent restart, healthy resident status, and a clean Slack startup. A successful
DM and channel reply remain the final operator proof. Keep tokens and user IDs out of documentation,
commits, screenshots, logs, and chat transcripts.

## What the gateway provides

A Slack-connected Profile uses the same SOUL, provider/model configuration, selected extension
packages, and Pi runtime as its other faces. Slack owns only channel transport and channel-specific
session routing.

- Only messages authored by the configured `ownerUserId` are processed.
- Direct messages use owner memory and sessions under `sessions/slack/user-<member-id>/`.
- Channel conversations use channel-scoped group memory. Top-level channel turns retain the existing
  session under `sessions/slack/group-sl<channel-id>/`, while replies inside a real Slack thread use
  a thread-root session under `sessions/slack/group-sl<channel-id>-thread-<thread-ts>/`. This keeps
  separate threads from contaminating one another without exposing owner-DM memory to the channel.
- Personal direct-message memory is intentionally not admitted into channel conversations.
- Other Slack users are ignored.
- Channel activation is mention-only by default. A `channels` entry can opt one channel into
  `"always"`; root messages and thread replies both inherit the setting for their Slack channel ID.
  Direct messages are always active, and every accepted request in a mention-only channel must
  contain the app's real Slack mention.
- Accepted messages immediately show Slack's native `is thinking...` loading status on the source
  thread. The status is best-effort, never blocks the model turn, and is explicitly cleared after
  success, failure, or cancellation.
- Ziggy reacts to the source message with 👀 at admission, removes it at settlement, and adds ✅ on
  success or ❌ on failure. Reactions are best-effort; a missing permission disables them for the
  current resident process without blocking the turn or its other feedback.
- Accepted messages also post `Working on that…` immediately, then replace that same message with
  the final answer. This is the client-visible fallback when Slack does not render the native status;
  a failed turn replaces it with an explicit failure notice instead of leaving stale working text.
- During a slow Pi turn, Ziggy progressively edits that same placeholder with bounded assistant text
  snapshots. It requires both 1.5 seconds and at least 48 Unicode code points of meaningful growth
  between edits, coalesces faster deltas, and serializes them with native status updates. While Pi is
  using a tool, the native thread status changes to a bounded `Using <tool>…` label and returns to
  thinking or heartbeat text after the tool ends. These intermediate writes are best-effort; the
  ordinary final placeholder edit and overflow chunks remain authoritative. `stop` prevents queued
  progress, waits behind any already in-flight native status write, and then clears every unique
  cancelled request or shared channel-thread status target last. Scoped progress workers finish
  interrupting before final delivery begins.
- A second turn admitted to the same chat first shows `Queued behind an earlier request…`, changes to
  `Working on that…` when it gets the chat permit, and refreshes the native status every 30 seconds
  during a long Pi turn.
- Owner-authored messages may include up to four PNG, JPEG, WebP, or GIF files, each no larger than
  5 MiB. File-only messages are valid. Ziggy validates Slack's private-file metadata before using
  the bot credential, downloads only `https://files.slack.com` content, verifies the response type
  and a bounded byte stream, and supplies successful images through Pi's native image prompt input.
  Unsupported, oversized, inaccessible, or excess attachments become concise metadata notices in
  the prompt instead of failing the whole turn. Private URLs and credentials are never placed in
  prompts or diagnostics. The configured provider and model must also support image input.
- Send the exact owner-authored message `stop` to cancel every earlier queued or running request in
  that direct message, channel, or Slack thread. `/stop` is also accepted when Slack delivers it as
  message text, but the Slack composer may reserve slash-prefixed text unless that command is
  registered for the app. In mention-only channels, send `@Squarey stop`; the ordinary mention
  normalization must leave exactly `stop`. The command is journaled before
  ACK like other accepted input, but cancellation runs outside the chat queue. It marks cancelled
  placeholders `Stopped.`, changes their source reaction to 🛑, and posts a short count such as
  `Stopped 2 requests.` A different channel or thread is unaffected, and the next ordinary message
  starts on a fresh generation. Stop feedback is best-effort and cannot delay Pi interruption or
  the owner-fenced `cancelled` journal transition.
- Replies preserve an incoming Slack thread when one is present and are split at Slack's 4,000
  Unicode-code-point limit, preferring line and word boundaries. Standard Markdown is sent through
  Slack's `markdown_text` boundary, so constructs such as `**bold**` render without Slack mrkdwn
  delimiters. Executable `<!channel>`, `<!here>`, and `<!everyone>` output tokens are escaped before
  delivery.
- Accepted inbound Socket Mode messages are committed to
  `<profile>/.runtime/slack-ingress.sqlite` before Ziggy acknowledges the originating live socket.
  The inbox is independent from the automation scheduler database. Its strict, versioned schema
  deduplicates the logical Slack message key (`channel` plus source timestamp) and the optional
  Slack event ID. A duplicate envelope is acknowledged but never prompts the model twice in the
  same resident lifecycle.
- On resident startup, rows left `received` or `running` by a prior resident owner are replayed with
  bounded concurrency. Completed, failed, cancelled, and delivery-unknown rows are terminal and
  never replayed. Only the resident UUID that claims a row may mark it terminal. Prompt text and
  private-file metadata are cleared at that transition, and old routing/deduplication rows are
  retained only within a fixed count bound. An ACK is bound to the WebSocket that supplied its
  envelope and is not attempted after that socket becomes stale or reconnects.
- This is durable at-least-once ingress, not an exactly-once claim for model execution or outbound
  Slack delivery. A process loss after the model starts but before its terminal commit can replay
  the prompt. Ambiguous outbound message posts are still not retried, because doing so could create
  duplicate Slack replies.
  Valid work enters Ziggy's bounded in-memory queue only after its durable commit.
  Slack-generated link markup is normalized back to its visible label before prompting, including
  telephone-looking numeric text; HTML entities are decoded, while user and channel mentions remain
  explicit Slack tokens. Mention-only admission still requires the real bot mention in the original
  event text.
  Message edits use at most four idempotent retries. New message posts retry only explicit Slack rate
  limits, never ambiguous network or server failures that could otherwise duplicate a reply.
- Skills are used through natural-language requests. Pi's `/skill:<name>` syntax is a TUI command,
  not a Slack slash command.

## Prerequisites

Before creating the Slack app:

1. Initialize and configure the Profile.
2. Confirm that its model and authentication work.
3. Select any optional extension packages the gateway should admit.
4. Install or run the resident owner.

Useful checks:

```sh
ziggy doctor <profile>
ziggy serve status <profile>
```

A resident with no `telegram.json`, `discord.json`, or `slack.json` is valid but scheduler-only.
When Slack is configured, `serve status` also reports its connection state, observation freshness,
active and queued turn counts, completed, cancelled, and failed counts, and a bounded failure
category. An intentional `stop` increments cancellation without fabricating a turn failure. `doctor`
reports a missing, stale, reconnecting, or failed Slack runtime independently from configuration
validity. The resident atomically refreshes this projection at
`<profile>/.runtime/slack-health.json`; inability to write it is logged but never blocks a turn.

The projection is deliberately content-free. It contains no prompt or response text, channel or
user IDs, Slack timestamps, tokens, session paths, or external error messages. It is operational
evidence, not a transcript.

## 1. Create a blank Slack app

Open [Slack API apps](https://api.slack.com/apps), then:

1. Choose **Create New App**.
2. Choose **Blank app**. Do not use the AI agent template; Ziggy does not need its additional Slack
   features or permissions.
3. Name the app for the Profile, for example `Squarey`.
4. Select the target workspace and create the app.

## 2. Enable Socket Mode and create the app token

Open **Socket Mode** in the Slack app sidebar:

1. Enable Socket Mode.
2. Create an app-level token named `ziggy-socket`.
3. Add the app-level scope `connections:write`.
4. Generate and securely retain the resulting `xapp-...` token.

This is the **app token**. It opens the Socket Mode connection and is different from the bot token
created later. Socket Mode means no public request URL is required.

## 3. Add bot token scopes

Open **OAuth & Permissions**. Under **Bot Token Scopes**, not User Token Scopes, add:

- `chat:write`
- `reactions:write`
- `files:read`
- `im:history`
- `channels:history`
- `groups:history`
- `mpim:history`

`chat:write` also authorizes `assistant.threads.setStatus`; `reactions:write` authorizes the 👀, ✅,
and ❌ source-message lifecycle. `files:read` allows the bot to receive usable private-file metadata
and download owner-attached images. Install or reinstall the app after adding this scope. Without
it, the text turn still proceeds with an attachment-unavailable notice. Attachments arrive on the
ordinary message events configured below, so no separate file event subscription is required.
Since Slack's March 2026 scope update, channel-based apps can use that loading state without
`assistant:write` or the AI assistant split view.

`mpim:history` is only needed for multi-person direct messages, but keeping it with the corresponding
event below makes the complete DM-and-channel setup explicit.

## 4. Subscribe to message events

Open **Event Subscriptions**:

1. Enable events.
2. Under **Subscribe to bot events**, add:
   - `message.im`
   - `message.channels`
   - `message.groups`
   - `message.mpim`
3. Save changes when Slack prompts.

These subscriptions cover direct messages, public channels, private channels, and multi-person DMs.
Ziggy still filters every event by the configured owner member ID.

## 5. Enable direct messages

Open **App Home**:

1. Enable the **Messages Tab**.
2. If Slack shows the option, enable sending messages from the Messages Tab.
3. Save the changes.

Slack changes labels occasionally; the required outcome is that a workspace member can open the app
and send it a direct message.

## 6. Install the app and retain the bot token

Open **Install App** and install or reinstall the app into the workspace. Approve the requested
permissions, then securely retain the **Bot User OAuth Token** beginning with `xoxb-`.

This is the **bot token**. Ziggy uses it for `auth.test` and `chat.postMessage`. Reinstall the app
after changing bot scopes or event subscriptions when Slack requests it.

## 7. Copy the owner member ID

The owner ID identifies the only Slack user Ziggy will accept.

1. Open your own Slack profile, not a channel menu.
2. Open the profile's **More** (`...`) menu.
3. Choose **Copy member ID**.
4. Confirm the value begins with `U`.

A channel ID begins with `C` and is not valid for `ownerUserId`.

## 8. Create the Profile configuration

Create `<profile>/slack.json` with these fields:

```json
{
  "botToken": "xoxb-...",
  "appToken": "xapp-...",
  "ownerUserId": "U...",
  "channels": {
    "C0A06UL1CKW": "always",
    "C0BP3QUQ3CL": "mention"
  }
}
```

`channels` is optional. Any omitted channel defaults to `"mention"`; use an explicit `"always"`
entry only for a channel where every owner-authored message should activate Ziggy. An explicit
`"mention"` entry is allowed when documenting policy matters. The former Profile-wide
`channelMode` field is no longer accepted. Channel keys must be Slack channel IDs beginning with
`C` or `G`; the decoder rejects invalid IDs, unknown modes, missing required fields, empty values,
and additional fields. Store the file privately:

```sh
umask 077
${EDITOR:-nano} <profile>/slack.json
chmod 600 <profile>/slack.json
```

Do not commit this file. The managed launchd or systemd service definition contains the Profile path
but does not contain channel tokens.

## 9. Validate and restart the resident

Validate before restart:

```sh
ziggy doctor <profile>
```

A valid result includes a gateway check such as:

```text
OK  gateways  1 present gateway config file valid
```

Then restart the existing resident so it rereads channel configuration and the selected extension
set:

```sh
ziggy serve restart <profile>
ziggy serve status <profile>
ziggy serve logs <profile>
```

A healthy restart reports a ready supervisor, a running process, and an active scheduler. Slack logs
then distinguish authenticated socket-supervisor startup, a connected socket, admitted chat keys,
mention-required ignores, reconnect degradation, and terminal failures without printing message
content or tokens. Use `--follow` while testing:

```sh
ziggy serve logs <profile> --follow
```

## 10. Test direct messages and channels

### Direct message

Open the Slack app's Messages tab and send a simple identity question:

```text
Hi. Who are you?
```

Then test owner memory with a harmless fact and confirm it remains available in a later direct
message.

Attach one supported image with or without accompanying text and confirm the reply addresses the
image. Also verify that an unsupported or oversized attachment yields an unavailable notice without
preventing Ziggy from answering the text portion.

### Channel

Invite the app into each channel where it should receive events:

```text
/invite @Squarey
```

By default, send `@Squarey` followed by the request; Ziggy strips its Slack mention before prompting
Pi. Every request in a thread must mention Squarey too: one earlier mention does not latch activation
for later replies. A channel configured as `"always"` treats any ordinary owner-authored message as
a request, both at the root and in its threads. Messages from other users are ignored in both modes,
and the channel receives isolated group memory rather than the owner's direct-message memory.

To stop work in the current conversation, send `stop` in a direct message or `@Squarey stop` in a
mention-only channel. The command affects only that exact chat key: separate channel threads keep
running. Text such as `stop now` is an ordinary model request, and `stop` from another member is
ignored. `/stop` has the same gateway meaning if Slack delivers it as message text.

### Selected extensions

Use natural language to exercise one selected package, for example a weather lookup or an Apple
Reminders request. The resident must be restarted after changing `<profile>/extensions.json`; a TUI
`/reload` does not recreate the resident or reread its startup admission set.

## Troubleshooting

### The resident is healthy but Slack does not answer

Check, in order:

1. `slack.json` exists under the resolved Profile path used by `serve`.
2. `ownerUserId` is your member ID beginning with `U`, not a channel ID.
3. The app token begins with `xapp-`; the bot token begins with `xoxb-`.
4. Socket Mode is enabled and the app token has `connections:write`.
5. The required message events are subscribed.
6. The app was reinstalled after permission changes, including `reactions:write` for progress
   reactions and `files:read` for image input.
7. The bot is invited to the target channel.
8. The sender is exactly the configured owner.
9. The resident was restarted after creating or changing `slack.json`.
10. `ziggy serve logs <profile>` contains no authentication, socket, or provider failure.

For an owner-authored channel message without a mention in the default mention-only mode, the log says
`reason:mention-required`. An accepted message logs its chat key and activation mode. A healthy live
transport logs `socket connected`; repeated `socket connection degraded` lines mean the resident is
running but Socket Mode is reconnecting.

Run the read-only projections before editing files:

```sh
ziggy doctor <profile>
ziggy serve status <profile>
ziggy serve logs <profile>
ziggy sessions list <profile>
```

### Direct messages work but channels do not

Verify `message.channels` and `message.groups`, the corresponding history scopes, and membership of
the bot in the channel. Public and private channels use different Slack event/scope pairs.

### The bot sees the channel but ignores a message

This is expected when the sender is not `ownerUserId`, the text is blank, or the event was authored
by the bot itself. Unless that exact channel is configured as `"always"`, the message must also
contain the app's real Slack mention; plain text such as `Squarey` is not an activation. Ziggy
currently has no multi-user allowlist and intentionally ignores those messages.

### The reply works but no loading status appears

Search `ziggy serve logs <profile>` for `status update failed`. Status delivery is intentionally
best-effort, so a Slack API failure does not block the model or final reply. Confirm the app was
reinstalled with `chat:write`, then restart the resident. Client-visible status remains a live Slack
proof: a successful API response alone does not prove that a particular Slack client displayed it.
The ordinary `Working on that…` message is the guaranteed visible fallback and should still be
replaced by the final answer.

### A `Working on that…` message never changes

Search `ziggy serve logs <profile>` for `final working-message update failed`, `postMessage`, or
`updateMessage`. A slow response may also log `progress message update failed`; progressive edits
are deliberately rate-bounded and their failure does not change final delivery settlement. The
placeholder, progressive edits, and final edit all use `chat:write`; no reaction, streaming, or
Agent-view scope is required. A model failure should replace the placeholder with a failure notice.

### Text replies work but attached images are unavailable

Check that `files:read` is under **Bot Token Scopes**, reinstall the app after adding it, and restart
the Ziggy resident. Confirm the file is PNG, JPEG, WebP, or GIF, no larger than 5 MiB, and shared in
a direct message or channel the bot can access. The configured provider/model must support image
input. Unsupported or inaccessible files intentionally become bounded notices while the text turn
continues; Ziggy never forwards a private Slack URL to the model.

### A selected command-line extension works in the TUI but not under `serve`

A managed service does not inherit the interactive terminal's shell initialization. On macOS,
launchd commonly has a narrower `PATH`. System tools such as `/usr/bin/osascript` remain available,
but Homebrew commands such as `gh` or `qmd` may require future explicit managed-service PATH support
or package-owned absolute executable resolution. Inspect logs rather than assuming the package was
not selected.

### Slack asks for a request URL

Confirm Socket Mode is enabled. Ziggy receives Events API envelopes over the app-level Socket Mode
connection and does not expose an HTTP callback.

## Verification record

On 2026-08-08, the manual path above produced these secret-free observations for a live Profile:

- `slack.json` had mode `0600`, the three required keys plus its explicit channel mode, and correctly
  prefixed token and member-ID values.
- `ziggy doctor` reported the Profile, model, auth, agents, automations, memory, resources, one
  gateway configuration, sessions, and runtime healthy.
- `ziggy serve restart` reached `readiness: ready` under launchd.
- `ziggy serve status` reported the supervisor and process running and the scheduler active.
- Initial resident stdout and stderr were empty, with no Slack authentication or Socket Mode error.
- A direct message rendered the immediate working message and its edited final Markdown reply.
- An owner-authored channel message completed without an app mention under compatibility `always`
  mode, and a real Slack thread used a distinct thread-root Pi session.
- Two concurrent direct messages visibly moved from working/queued feedback to independent edited
  final replies.
- After installing `reactions:write`, a completed direct message changed its source reaction from 👀
  to ✅. A controlled resident restart during a second active turn changed 👀 to ❌, edited the
  placeholder to `I couldn't complete that request.`, and returned with a healthy replacement
  resident. Conversation history was sufficient for this proof; `reactions:read` was not added.
- After installing `files:read`, a PNG-only `file_share` direct message showed 👀 and the working
  placeholder, passed the image to the configured Pi model, and edited the placeholder with an
  accurate description of the page and its folded upper-right corner. The source reaction changed
  to ✅, health returned to zero active/queued turns, and the completed ingress row contained neither
  prompt text nor private-file metadata.

This record proves the configured workspace's startup, direct-message, channel, thread, queue,
success-reaction, cancellation-reaction, and PNG image-input paths. It does not prove a different
Slack workspace, client version, app manifest, provider/model, attachment format, or channel
membership.

## Token rotation and removal

To rotate either token:

1. Generate or reinstall the corresponding Slack credential.
2. Replace only that value in `<profile>/slack.json`.
3. Preserve file mode `600`.
4. Run `ziggy doctor <profile>`.
5. Run `ziggy serve restart <profile>`.
6. Revoke the old token in Slack after the new connection is healthy.

To disconnect Slack without deleting sessions or memory:

1. Move `slack.json` outside the Profile or delete it deliberately.
2. Restart `serve`.
3. Revoke the Slack app credentials if the integration is no longer needed.

Removing the channel configuration does not remove Profile memory, selected extensions, Pi
sessions, automation history, or the resident service.
