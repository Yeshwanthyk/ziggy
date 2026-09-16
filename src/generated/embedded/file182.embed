# Connect a Profile to Telegram

This guide connects one Ziggy Profile to Telegram through the Bot API's long-polling interface. The
existing `ziggy serve <profile>` resident owns the Telegram loop alongside the automation scheduler
and any other configured channels.

Keep the bot token and owner user ID out of documentation, commits, screenshots, logs, and chat
transcripts. Treat the bot token like a password.

## What the gateway provides

A Telegram-connected Profile uses the same SOUL, provider/model configuration, selected extension
packages, and Pi runtime as its other faces. Telegram owns only message transport and chat-specific
session routing.

- Only text messages authored by the configured `ownerUserId` are processed.
- Private chats use owner memory and sessions under `sessions/telegram/user-<user-id>/`.
- Group and supergroup chats use group memory and sessions under
  `sessions/telegram/group-tg<absolute-chat-id>/`.
- Each Telegram chat has one serialized Pi chat handle. Follow-up messages continue the same chat
  session while separate chats remain isolated.
- The exact owner-authored text `stop` or `/stop` aborts the active turn in that chat and replies
  `Stopped.`. When no turn is active, Telegram replies `Nothing was running.`.
- Replies are split at Telegram's 4,096 Unicode-code-point message limit. Specialist progress is
  delivered as bounded text messages before the final reply when a specialist emits progress.
- Messages from other users, unsupported chat types, and updates without text are ignored.
- Skills are used through natural-language requests. Pi's `/skill:<name>` syntax is a TUI command,
  not a Telegram command.

Telegram keeps the current update offset in process memory. On startup Ziggy performs a zero-timeout
poll, advances past the returned updates, and logs that the pending backlog was discarded. A restart
does not recover accepted Telegram work: pending messages can be discarded, and the offset is not a
durable ingress journal. Telegram also has no Telegram health projection in the current
implementation.

## Prerequisites

Before creating the bot:

1. Initialize and configure the Profile.
2. Confirm that its model and authentication work.
3. Select any optional extension packages the gateway should admit.
4. Install or run the resident owner.

Useful checks:

```sh
ziggy doctor <profile>
ziggy serve status <profile>
```

`doctor` validates a present `telegram.json` against Ziggy's strict local schema. `serve status`
does not report a Telegram health projection; use `ziggy serve logs <profile>` and a live message
round trip to prove Telegram connectivity.

## 1. Create a bot with BotFather

In Telegram, open [@BotFather](https://t.me/BotFather):

1. Send `/newbot`.
2. Choose a display name for the Profile.
3. Choose a unique username ending in `bot`.
4. Store the returned token securely for the Profile configuration step.

Do not put the token in a shell command, source file, issue, or operations guide. If it is exposed,
revoke it with BotFather and issue a replacement.

## 2. Copy the owner user ID

The owner ID is the only Telegram account Ziggy accepts. Use a trusted Telegram user-ID bot or an
equivalent account-information method to obtain your numeric user ID. Use the user ID, not the bot
ID, username, chat ID, or group ID.

## 3. Create the Profile configuration

Create `<profile>/telegram.json` with exactly these fields:

```json
{
  "botToken": "replace-with-the-telegram-bot-token",
  "ownerUserId": 123456789
}
```

`ownerUserId` is a positive safe integer JSON number. The decoder rejects unknown fields, missing
fields, empty tokens, non-integer IDs, and IDs outside JavaScript's safe integer range. Store the file
privately:

```sh
umask 077
${EDITOR:-nano} <profile>/telegram.json
chmod 600 <profile>/telegram.json
```

Do not commit this file. Managed service definitions contain the Profile path but no channel token.

## 4. Validate and restart the resident

Validate before restart:

```sh
ziggy doctor <profile>
```

Then restart the existing resident so it rereads `telegram.json`:

```sh
ziggy serve restart <profile>
ziggy serve logs <profile>
```

For a Profile without a managed service, install and start it instead:

```sh
ziggy serve install <profile>
```

Use one `ziggy serve` process for the scheduler and every configured channel loop. The compatibility
foreground names are `ziggy serve <profile>` and `ziggy gateway <profile>`; there is no separate
Telegram resident command.

## 5. Prove the live message path

Follow the managed logs while testing:

```sh
ziggy serve logs <profile> --follow
```

Send a short message from the configured owner account to the bot. A successful private-chat turn
has these observations:

1. Telegram receives a reply from the bot.
2. The log contains a bounded line shaped like
   `[gateway] user-<user-id> in:<count> out:<count> chars`.
3. `ziggy sessions list <profile>` shows the Telegram session after the first turn.

Send a follow-up to prove session continuity. Then test a group or supergroup separately if the bot
is intended to operate there. Only the configured owner can trigger a turn, but every owner-authored
text message in an admitted group is processed; restrict the bot's group membership accordingly.

Send `stop` during a long-running turn to prove scoped cancellation. Test an automation with a
`broadcast: telegram:chat:<chat-id>` target only after the resident and its Telegram configuration
are healthy; automation delivery loads the same `telegram.json` and reports bounded delivery status.

## Troubleshooting

### The resident is healthy but Telegram does not answer

Check these in order:

1. `<profile>/telegram.json` exists under the resolved Profile path used by `serve`.
2. `ziggy doctor <profile>` reports the gateway configuration as valid.
3. The resident was restarted after creating or changing `telegram.json`.
4. `botToken` is the current token from BotFather.
5. The sending account's numeric user ID exactly matches `ownerUserId`.
6. The message contains text and is sent in a private chat, group, or supergroup.
7. `ziggy serve logs <profile>` has no `[gateway] Telegram stopped:` or Telegram API failure line.

The process and scheduler can remain healthy while Telegram is disconnected because Telegram has no
separate status projection. Inspect the logs and perform a fresh message proof.

### The bot ignores a message in a group

Confirm the sender is exactly `ownerUserId`, the update contains text, and the chat is a group or
supergroup. Telegram privacy settings can prevent a bot from receiving ordinary group messages;
adjust the bot's group privacy setting with BotFather when the bot must receive them. Ziggy does not
implement mention-only admission or a multi-user allowlist.

### A message is missing after restart

The current Telegram adapter keeps its offset only in memory and discards pending startup backlog.
A restart can therefore lose messages that were waiting in Telegram or still being processed. Inspect
logs before repeating an operator action; do not assume Telegram delivery is durable or exactly once.

### A long reply is incomplete

Telegram messages are split at 4,096 Unicode code points. Inspect the log's `out:<count>` value and
confirm that all chunks arrived. A provider or Telegram API failure is logged as a bounded gateway
failure; retry only after checking whether Telegram accepted the preceding chunk.

## Token rotation and removal

To rotate a Telegram bot token:

1. Revoke or regenerate the token with BotFather.
2. Replace only `botToken` in `<profile>/telegram.json` without exposing either token.
3. Preserve file mode `600`.
4. Run `ziggy doctor <profile>`.
5. Restart the resident and repeat the live message proof.

To disconnect Telegram without deleting sessions or memory:

1. Move `telegram.json` outside the Profile or delete it deliberately.
2. Restart `serve`.
3. Revoke the bot token with BotFather if the integration is no longer needed.

Removing the configuration does not delete `sessions/telegram/`, memory, automation history, or the
resident service.
