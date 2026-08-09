# Connect a Profile to Discord

This guide connects one Ziggy Profile to Discord through the Discord Gateway WebSocket and HTTP
API. It uses no public webhook, interactions endpoint, inbound port, or Discord-specific daemon.
Native application commands arrive through the same Gateway connection. The existing
`ziggy serve <profile>` resident owns the Discord loop alongside the automation scheduler and any
other configured channels.

Keep the bot token and owner user ID out of documentation, commits, screenshots, logs, and chat
transcripts. Treat the bot token like a password.

## What the gateway provides

A Discord-connected Profile uses the same SOUL, provider/model configuration, selected extension
packages, and Pi runtime as its other faces. Discord owns only message transport and
channel-specific session routing.

- Only text or attachment messages authored by the configured `ownerUserId` are processed.
- Messages authored by the bot or any other Discord user are ignored.
- Direct messages use owner memory and sessions under `sessions/discord/user-<user-id>/`.
- A top-level server message creates a native Discord thread. That root and every follow-up in its
  thread share one Pi session under
  `sessions/discord/group-dc<parent-channel-id>-thread-<thread-id>/`.
- Two top-level messages create two threads and two isolated sessions, while their group memory
  remains scoped to the parent Discord channel. Direct messages retain one owner session.
- Once a DM route or native thread has been resolved, Ziggy commits the owner message to the
  Profile-local `.runtime/discord-ingress.sqlite` journal before scheduling Pi. A resident restart
  recovers unfinished work, and duplicate Gateway deliveries cannot prompt Pi twice while the
  retained message row exists.
- A mention is not required. Every owner-authored text message in a channel visible to the bot is
  admitted, so grant the bot access only to channels intended for Ziggy.
- Accepted work immediately shows `Working on that…`; concurrent work in the same DM or thread
  shows `Queued behind an earlier request…`, then changes to working when it starts. Bounded
  assistant progress replaces the placeholder before the final answer.
- Active work uses Discord's native typing indicator in the DM or thread. Ziggy renews it while Pi
  is running and the scoped worker stops renewing it when the turn settles or is cancelled.
- Ziggy adds 👀 to the owner message at admission, removes it at settlement, then adds ✅ for
  success, 🛑 for cancellation, or ❌ for failure. Reaction and typing failures are best-effort and
  cannot block the model turn or final reply.
- An exact owner-authored `stop` in a DM or thread cancels only that conversation's running and
  queued turns. Generation fencing prevents late progress or completion from overwriting the
  stopped state.
- Replies are split at Discord's 2,000 Unicode-code-point message limit. Outbound messages disable
  mention parsing so model text cannot notify users or roles.
- Image input accepts file-only or captioned messages with up to four PNG, JPEG, WebP, or GIF
  attachments of at most 5 MiB each. Ziggy downloads only Discord attachment paths from
  `cdn.discordapp.com` or `media.discordapp.net`, checks the declared and returned MIME type,
  `Content-Length`, and streamed byte count, and never sends the bot token to the CDN.
- Unsupported, oversized, excess, malformed, or failed image downloads become bounded notices in
  the prompt instead of failing an otherwise valid text turn. Successful images use Pi's typed
  image input.
- Owner-only `/status` and `/stop` commands respond privately in DMs and native threads. `/status`
  reports that conversation's active and queued counts. `/stop` uses the same scoped cancellation
  path and generation fence as the exact text command `stop`. In a top-level server channel, the
  commands direct the owner to use a Ziggy work thread so session identity remains unambiguous.
- On resident startup, Ziggy idempotently creates or repairs only its two global commands. It does
  not bulk-overwrite the command registry or remove commands owned by another integration.
- Skills are used through natural-language requests. Pi's `/skill:<name>` syntax is a TUI command,
  not a Discord slash command.

The ingress journal promises durable at-least-once processing after conversation resolution, not
exactly-once model execution or Discord delivery. Top-level server messages must first create their
native thread, so a crash or ambiguous Discord response during thread creation occurs before the
journal boundary. A later crash can also happen after Discord accepted a reply but before Ziggy
settled its row; replay may therefore repeat model work or delivery. Terminal rows erase prompt text
immediately and retain only bounded routing/deduplication facts, with at most 1,000 terminal rows.
Attachment metadata is erased with the prompt at terminal settlement.

## Prerequisites

Before creating the Discord app:

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
`doctor` validates a present `discord.json` against Ziggy's strict local schema and reports the last
content-free Discord runtime projection. It does not contact Discord or prove that the token,
Gateway intents, installation, channel permissions, or live reply path work. `serve status` reports
Discord as `not configured`, `not observed`, `starting`, `connected`, `reconnecting`, `failed`,
`stopped`, or `stale`, with content-free turn counts and the last bounded failure class. The final
proof is still an actual Discord thread reply plus the corresponding bounded log line.

## 1. Create a Discord application

Open the [Discord Developer Portal](https://discord.com/developers/applications), then:

1. Choose **New Application**.
2. Name the application for the Profile, for example `Squarey`.
3. Accept Discord's terms and create the application.

Use a test server or a dedicated private channel for the first live proof.

## 2. Configure the bot and retain its token

Open **Bot** in the application sidebar:

1. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
2. Leave **Presence Intent** and **Server Members Intent** disabled; Ziggy does not request them.
3. Generate or reset the bot token and store it securely for the Profile configuration step.

Do not put the token in a shell command, source file, issue, or operations guide. Discord only shows
a newly generated token once. If it is exposed, reset it before continuing.

Ziggy identifies with the `Guilds`, `Guild Messages`, `Direct Messages`, and privileged
`Message Content` Gateway intents. Without Message Content, ordinary server messages arrive without
the text Ziggy needs and are ignored.

## 3. Install the bot in a server

Open **Installation** in the application sidebar and configure a server installation:

1. Enable the **Guild Install** context.
2. Add the `bot` and `applications.commands` OAuth2 scopes. The latter exposes Ziggy's native
   `/status` and `/stop` controls.
3. Grant **View Channels**, **Send Messages**, **Create Public Threads**, **Send Messages in
   Threads**, **Read Message History**, and **Add Reactions** for the first text-channel proof.
4. Copy the install link, open it, choose the test server, and authorize the bot.

After installation, keep the bot's server or channel role restricted to the dedicated Ziggy
channel. Channel permission overrides can further limit where it can read owner messages and post
replies.

## 4. Copy the owner user ID

The owner ID is the only Discord account Ziggy accepts:

1. In Discord, open **User Settings** → **Advanced**.
2. Enable **Developer Mode**.
3. Right-click your own user in Discord and choose **Copy User ID**.

Use the numeric ID, not a username, display name, application ID, server ID, or channel ID.

## 5. Create the Profile configuration

Create `<profile>/discord.json` with exactly these fields:

```json
{
  "botToken": "replace-with-the-discord-bot-token",
  "ownerUserId": "replace-with-the-numeric-owner-user-id"
}
```

Both values are JSON strings. `ownerUserId` must contain only ASCII digits. The decoder rejects
unknown fields, missing fields, empty values, and a numeric rather than string owner ID.

Edit the file without placing the token in shell history, then restrict it to the current user:

```sh
${EDITOR:-nano} <profile>/discord.json
chmod 600 <profile>/discord.json
```

## 6. Validate and restart the resident

Run the read-only Profile checks before restart:

```sh
ziggy doctor <profile>
```

The `gateways` row should report the new total number of valid gateway configuration files, and
`discord-runtime` should initially report that Discord is configured but not yet observed. Then
restart the managed resident so it reloads `discord.json`:

```sh
ziggy serve restart <profile>
ziggy serve status <profile>
ziggy serve logs <profile>
```

For a Profile without a managed service, install and start it instead:

```sh
ziggy serve install <profile>
```

Do not run `ziggy discord <profile>`. That old resident alias is intentionally unsupported; one
`ziggy serve` process owns the scheduler and every configured channel loop.

## 7. Prove the live message path

Follow the managed logs in one terminal:

```sh
ziggy serve logs <profile> --follow
```

In the dedicated Discord channel, send a short owner-authored identity question without mentioning
the bot. A successful turn has four independent observations:

1. Discord creates a native thread from the top-level message.
2. The source message receives 👀, the thread shows Discord's typing indicator plus
   `Working on that…` or bounded progress, and the placeholder becomes the model reply.
3. The source reaction settles from 👀 to ✅. A stopped request uses 🛑 and a failed request uses ❌.
4. `ziggy serve status <profile>` reports `discord: connected` and updated turn counts.
5. The service log records a bounded line shaped like
   `[discord] group-dc<channel-id>-thread-<thread-id> in:<count> out:<count> chars`.

The log proves Ziggy completed the accepted turn and called Discord delivery. The visible Discord
reply proves the client-facing path. Neither proof includes the prompt or answer text.

Send a follow-up inside that thread to prove session continuity. Then send a second top-level
message to prove it creates a different thread and Pi session while retaining parent-channel group
memory. Test direct messages separately because Discord account privacy and application
installation settings can affect whether Discord delivers them to the bot.

Open Discord's **Apps** picker inside the work thread and run `/status`; it should return a private
`Ziggy is ready in this thread` response with active and queued counts. Run `/stop` with no active
work to prove command delivery; it should privately report that nothing was running. The exact text
`stop` remains a reliable composer fallback and exercises the same cancellation mechanism.

## Troubleshooting

### The resident is healthy but Discord does not answer

Check these in order:

1. `<profile>/discord.json` exists under the resolved Profile path used by `serve`.
2. `ziggy doctor <profile>` reports the gateway configurations as valid.
3. The resident was restarted after creating or changing `discord.json`.
4. **Message Content Intent** is enabled on the application's **Bot** page.
5. The bot is installed in the intended server.
6. The bot can view the source channel, read message history, create public threads, and send
   messages in threads.
7. The sending account's numeric user ID exactly matches `ownerUserId`.
8. The source message contains non-empty text.
9. `ziggy serve logs <profile>` has no `[gateway] Discord stopped:` or `[discord] ... failed:` line.

The resident isolates a terminal Discord failure from the scheduler and other channel loops. A
running process therefore does not, by itself, prove Discord is connected.

### The bot answers mentions or direct messages but ignores ordinary server text

Confirm **Message Content Intent** is enabled. Discord can omit ordinary server-message content when
that privileged intent is unavailable, while still exposing messages that mention the bot or are
sent directly to it.

### The bot reads the request but cannot reply

Confirm the bot has **View Channels**, **Send Messages**, **Create Public Threads**, **Send Messages
in Threads**, and **Read Message History** in that specific channel, including any channel
permission overrides. If thread creation fails, Ziggy posts one actionable permission message in the
source channel and does not run Pi against an ambiguous shared-channel session. Inspect the managed
logs for the bounded Discord delivery failure.

### Replies work but reactions or typing do not

Confirm **Add Reactions**, **Read Message History**, **Send Messages**, and, for threads, **Send
Messages in Threads** in the source and thread channels. Discord channel overrides can make one
channel fail while another works. Ziggy disables repeated best-effort feedback attempts only for
the affected channel after a non-retriable denial; ordinary replies remain authoritative.

### Native `/status` and `/stop` commands are missing or duplicated

Confirm the app was installed with `applications.commands`, restart the resident, and reopen
Discord's Apps picker. Ziggy registers one global `status` and one global `stop` definition without
deleting unrelated application commands. Do not also register guild copies: global and guild
definitions with the same name appear as duplicate picker entries. A command response saying to use
a work thread is expected when invoked in a top-level server channel.

### Discord stops while opening its ingress database

The strict journal fails closed on an unknown or modified schema. Inspect `ziggy serve logs
<profile>` for `[gateway] Discord stopped: Discord ingress database ...`; the scheduler and other
configured channels remain isolated and continue running. Do not delete or edit
`.runtime/discord-ingress.sqlite` as a first repair step because it may contain accepted unfinished
work. Preserve a copy and diagnose the schema or filesystem failure. On an ordinary resident
restart, Ziggy automatically returns foreign-owner `running` rows to `received` and replays them in
their original admission order.

### The wrong messages reach Ziggy

Ziggy intentionally admits every non-empty owner-authored text message in every visible server
channel; it has no mention-only configuration. Remove the bot's access from unrelated channels or
use channel permission overrides to expose only the dedicated Ziggy channel.

## Verification record

Setup verification began on 2026-08-09 against Ziggy `ca27d16` on macOS with the `squarey` Profile:

- `ziggy doctor squarey` passed before Discord configuration and reported one valid existing gateway
  configuration.
- `ziggy serve status squarey` reported an installed, running launchd supervisor, a live resident
  owner, and an active scheduler.
- `/Users/yesh/.ziggy/profiles/squarey/discord.json` was not present before setup.
- The existing Discord application was named `Squarey` during setup and reported one server
  installation. The bot username remained independently named `Kiri`; neither name participates in
  Ziggy's Profile or message-routing identity.
- The application's Bot page had **Message Content Intent** enabled and the unused **Presence
  Intent** and **Server Members Intent** disabled.
- The application's current default Guild Install scope showed `applications.commands`, without a
  displayed default `bot` scope. This does not establish the permissions of the existing one-server
  installation; the supplied target channel must be proven live before changing installation
  settings.
- The operator stored a strict `discord.json` containing the bot token and numeric owner user ID
  with file mode `600`; the secret values were not printed or copied into repository files.
- `ziggy doctor squarey` passed with both gateway configurations valid. After a managed resident
  restart, `ziggy serve status squarey` reported Discord `connected` with zero failures and Kiri
  appeared online in the installed Discord client.
- A Computer Use E2E in the target server channel sent one top-level request, observed Ziggy create
  a native thread, and received the exact final reply `THREAD-ONE-OK`. A follow-up in that thread
  moved from `Working on that…` to `SAME-THREAD-OK` and reused its session.
- A second top-level request created a different native thread, returned `THREAD-TWO-OK`, and
  materialized a different session directory under the same parent-channel scope. The two observed
  thread IDs were `1536003434036199534` and `1536003704086339644`.
- A live same-thread cancellation exercise showed working and queued placeholders, changed both to
  `Stopped.`, acknowledged `Stopped 2 requests.`, and suppressed late completion. That exercise
  exposed a stale queued health count after cancelling before semaphore admission; the projection
  now records whether a cancelled turn had started and focused regression coverage requires the
  settled state to be active `0`, queued `0`, cancelled `2`. After restarting into the correction,
  a second Computer Use run visibly settled both placeholders and the acknowledgement, while live
  `serve status` reported active `0`, queued `0`, completed `0`, cancelled `2`, failed `0`.
- A later Discord-native feedback E2E visibly showed 👀 on the source message, the client-native
  `Kiri is typing…` indicator, and an edited `Stopped.` placeholder. The first terminal reaction
  swap exposed Discord's per-route reaction rate limit: removing 👀 and immediately adding the
  terminal emoji returned `429`. Ziggy now performs at most three bounded best-effort attempts using
  Discord's `retry_after`. The corrected Computer Use rerun visibly showed 🛑 on the cancelled
  request, ✅ on its `stop` command, and ✅ plus the exact reply `DISCORD-NATIVE-OK` on a subsequent
  successful request. Live status settled at active `0`, queued `0`, completed `1`, cancelled `1`,
  failed `0`.
- A strict `.runtime/discord-ingress.sqlite` journal was subsequently added and focused tests proved
  source-message deduplication before Pi, resident-owner fencing, foreign-owner restart recovery,
  ordered replay before new socket intake, terminal prompt erasure, and bounded terminal retention.
  A managed-resident restart then visibly returned `DISCORD-DURABLE-OK`; the latest row was
  `completed`, owner-released, started and finished, with zero retained prompt bytes.
- Attachment support upgraded that journal from schema v1 to v2 while preserving its existing
  terminal row. A native macOS Discord upload sent a file-only synthetic PNG. Kiri replied, `The
image shows a yellow background with a blue rounded rectangle on the left and a red circle on the
right.` The source message visibly settled with ✅, `serve status` reported Discord connected with
  active `0`, queued `0`, completed `1`, cancelled `0`, failed `0`, and the newest journal row was
  `completed` with zero retained text bytes and empty attachment metadata.
- The resident registered the narrow global `status` and `stop` command definitions while leaving
  the existing guild-scoped `kiri-bind`, `kiri-run`, `kiri-diff`, `kiri-status`, and `kiri-queue`
  commands intact. Temporary guild copies used for immediate cache testing were removed precisely
  to prevent duplicate picker entries.
- Computer Use in `/Applications/Discord.app` selected `/status` from the native Apps picker and
  received the private response `Ziggy is ready in this thread. Active: 0 · queued: 0.` It then
  selected `/stop` through the same picker and received the private response
  `Nothing was running in this conversation.`

This record proves the configured Squarey resident's Gateway authentication, target-channel thread
permission, thread/session routing, same-thread continuity, isolated roots, visible cancellation,
restart-safe durable admission, and bounded image input through the installed macOS Discord app. It
also proves native application-command registration and private thread-scoped responses. It does
not disclose or independently attest the token value.

## Token rotation and removal

To rotate a Discord bot token:

1. Reset the token on the application's **Bot** page.
2. Replace only `botToken` in `<profile>/discord.json` without exposing either token.
3. Preserve file mode `600`.
4. Run `ziggy doctor <profile>`.
5. Restart the resident and repeat the live message proof.

To disconnect Discord without deleting sessions or memory:

1. Move `discord.json` outside the Profile or delete it deliberately.
2. Restart the resident.
3. Remove the bot from the server and reset its token if the integration is no longer needed.

Removing the configuration does not delete `sessions/discord/` or channel-scoped memory.
