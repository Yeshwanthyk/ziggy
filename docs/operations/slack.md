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
- Channel conversations use channel-scoped group memory and sessions under
  `sessions/slack/group-sl<channel-id>/`.
- Personal direct-message memory is intentionally not admitted into channel conversations.
- Other Slack users are ignored.
- Channel messages do not require an `@Squarey` mention after the app has been invited.
- Replies preserve an incoming Slack thread when one is present and are split at Slack's 4,000
  Unicode-code-point limit.
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
- `im:history`
- `channels:history`
- `groups:history`
- `mpim:history`

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

Create `<profile>/slack.json` with exactly these fields:

```json
{
  "botToken": "xoxb-...",
  "appToken": "xapp-...",
  "ownerUserId": "U..."
}
```

The decoder rejects missing, empty, or additional fields. Store the file privately:

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

A healthy restart reports a ready supervisor, a running process, and an active scheduler. An empty
Slack log immediately after startup is normal; authentication or Socket Mode failures appear on
stderr. Use `--follow` while testing:

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

### Channel

Invite the app into each channel where it should receive events:

```text
/invite @Squarey
```

Send a normal message as the configured owner. No mention is required. Messages from other users are
ignored, and the channel receives isolated group memory rather than the owner's direct-message
memory.

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
6. The app was reinstalled after permission changes.
7. The bot is invited to the target channel.
8. The sender is exactly the configured owner.
9. The resident was restarted after creating or changing `slack.json`.
10. `ziggy serve logs <profile>` contains no authentication, socket, or provider failure.

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
by the bot itself. Ziggy currently has no multi-user allowlist and intentionally ignores those
messages.

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

- `slack.json` had mode `0600`, exactly the three expected keys, and correctly prefixed token and
  member-ID values.
- `ziggy doctor` reported the Profile, model, auth, agents, automations, memory, resources, one
  gateway configuration, sessions, and runtime healthy.
- `ziggy serve restart` reached `readiness: ready` under launchd.
- `ziggy serve status` reported the supervisor and process running and the scheduler active.
- Initial resident stdout and stderr were empty, with no Slack authentication or Socket Mode error.

This record proves configuration and startup, not message delivery. Add a successful DM and channel
round trip before calling a particular workspace integration complete.

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
