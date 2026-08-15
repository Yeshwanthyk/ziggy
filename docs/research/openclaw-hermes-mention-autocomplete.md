# Mention autocomplete in OpenClaw and Hermes Agent

Can latest OpenClaw and Hermes Agent complete specialist / agent / profile
names when a user types `@` in Slack, Discord, Telegram, TUI, or CLI?

Source-only review of snapshots fetched 2026-08-15 with `npx opensrc fetch`
(`opensrc --help`: GitHub specs are `owner/repo`, not the similarly named npm
packages). Trees:

- OpenClaw `2026.8.1` at
  `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main`
- Hermes Agent `0.20.1` at
  `/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main`

## Summary

| Surface | OpenClaw | Hermes Agent |
| --- | --- | --- |
| Slack / Discord native `@` | One installed bot app, or N apps. Config agent ids are not in the picker | Same. Profile names are not Slack/Discord users |
| Slack `/` | Default one `/openclaw`. Optional native slash per built-in command | Native slash per `COMMAND_REGISTRY` entry |
| Discord `/` | Option autocomplete for command args (`/think`, `/acp`, models) | Skills as application commands; `/skill` name autocomplete |
| Telegram `@` | Registered bot username only | One bot token per Profile; `exclusive_bot_mentions` |
| TUI / CLI `@` | File completion via pi-tui, not agent ids | TUI completes `@<profile>`. Classic CLI `@` is files/diffs/URLs only |
| Shell `completion` | Subcommands and flags. `--agent` has no id list | `-p` / `profile use` complete profile dir names |
| In-app agent picker | TUI `Ctrl+G` / `/agent <id>`; Control UI `AgentSelect` | Desktop / Bot Mode roster; TUI `@profile` |
| Mention *detection* | `mentionPatterns` / native bot mention after the user types | `app_mention`, `require_mention`, `@botusername` wake gates |

Native `@` in Slack and Discord lists people and apps. A file-named specialist
is not in that list unless it is a separate bot app.

## OpenClaw

### Native `@` is detection, not a picker

`mentionPatterns` and derived identity names decide whether a typed message
wakes the bot. They do not register entries in Slack or Discord mention UI.
See [`src/auto-reply/reply/mentions.ts`](https://github.com/openclaw/openclaw/blob/main/src/auto-reply/reply/mentions.ts)
and per-agent `groupChat.mentionPatterns`.

### Slash `/` completes commands and args, not `@reviewer`

Default Slack manifest declares one slash:

```46:51:/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/extensions/slack/src/setup-shared.ts
      slash_commands: [
        {
          command: "/openclaw",
          description: "Send a message to OpenClaw",
          should_escape: false,
        },
```

With `commands.native: true`, OpenClaw creates one Slack slash per built-in
command (`/agentstatus` instead of `/status` because Slack reserves `/status`).
[`docs/tools/slash-commands.md`](https://github.com/openclaw/openclaw/blob/main/docs/tools/slash-commands.md)
Slack specifics.

Discord wires option autocomplete when choices are dynamic or exceed 25.
That list is think levels, ACP actions, models — not `agents.entries` ids.
[`extensions/discord/src/monitor/native-command.options.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/discord/src/monitor/native-command.options.ts)

Slack `block_suggestion` filters the same command-arg choices.
[`extensions/slack/src/monitor/slash.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/slack/src/monitor/slash.ts)

Web composer: `/` opens slash commands; **`$`** opens skills. There is no
`@agent` menu.
[`ui/src/pages/chat/components/chat-composer-skill-menu.ts`](https://github.com/openclaw/openclaw/blob/main/ui/src/pages/chat/components/chat-composer-skill-menu.ts)

TUI editor uses `CombinedAutocompleteProvider(slashCommands, cwd)` — slash
names plus file paths, trigger `/` and files, not `@agent`.
[`src/tui/tui.ts`](https://github.com/openclaw/openclaw/blob/main/src/tui/tui.ts),
[`docs/web/tui.md`](https://github.com/openclaw/openclaw/blob/main/docs/web/tui.md)
(`Ctrl+G` agent picker, `/agent <id>`).

`openclaw completion` emits shell scripts from the Commander tree. `--agent`
is a flag without `.choices` of configured ids.
[`src/cli/completion-cli.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/completion-cli.ts)

### Native `@` that does work: one bot app per agent

```97:102:/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/docs/concepts/multi-agent.md
    Create one account per agent on your preferred channels:

    - Discord: one bot per agent, enable Message Content Intent, copy each token.
    - Telegram: one bot per agent via BotFather, copy each token.
    - WhatsApp: link each phone number per account.
```

Each app appears in the platform picker under that bot's registered name.
Bindings route the inbound account to `agentId`. Shared-channel text routing
still uses `mentionPatterns`, not picker injection.

## Hermes Agent

### TUI `@` does complete profile names

TUI `complete.path` lists profiles as `@name` next to `@diff` / `@file:`:

```49:76:/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main/tui_gateway/methods_complete.py
    def _profile_mention_items(prefix: str) -> list[dict]:
        """`@<profile>` completions: agent profiles as mentionable names.

        Multi-agent UIs (and the Bot Mode plugin) route `@<profile>` text to
        another agent profile; completing profile names alongside path refs
        makes that discoverable. Bare-word matches only — never for
        `@kind:` directive queries. The primary profile is also offered
        under the 'hermes' alias when no real profile claims that name.
        """
        ...
                if name.lower().startswith(prefix.lower()):
                    out.append(
                        {
                            "text": f"@{name}",
```

Bare `@tur` ranks matching profiles above files. Classic CLI
`_context_completions` does **not** call `list_profiles()`; `@` there is
files, diffs, and URLs only.
[`hermes_cli/commands.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/commands.py),
[`website/docs/user-guide/features/context-references.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/context-references.md)

Desktop / Bot Mode disambiguates duplicate names as `@name-device`.
[`website/docs/user-guide/multi-connection-desktop.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/multi-connection-desktop.md)

### Slack / Discord `/` completes commands and skills, not profiles

Slack: type `/` and the picker lists every Hermes command from
`COMMAND_REGISTRY`.
[`website/docs/user-guide/messaging/slack.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/slack.md)

Discord: installed skills register as application commands; `/skill` has
dynamic name autocomplete. Native `@` remains users/roles/bots.
[`website/docs/user-guide/messaging/discord.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/discord.md),
[`plugins/platforms/discord/adapter.py`](https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/discord/adapter.py)

Telegram fills `/` via `set_my_commands`. `@botusername` is wake/routing.
One bot token per Profile; duplicate tokens are rejected.
[`website/docs/user-guide/profiles.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md),
[`website/docs/user-guide/messaging/telegram.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md)

`hermes completion` walks argparse: profile names after `-p` / `profile use`,
not chat `@`.
[`hermes_cli/completion.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/completion.py)

## Ziggy implication

- Slack `@reviewer` will not pop a specialist unless `reviewer` is a second
  Slack app (or a person). OpenClaw and Hermes have the same limit.
- Slash `/` is the chat picker that actually completes. Hermes already
  registers every command that way. OpenClaw can with `commands.native`.
  Ziggy would need `/ziggy reviewer` (or native slashes) for Slack complete.
- Hermes TUI `@profile` is the in-app analogue of a GUI rail: complete names
  in the composer, route that text to another agent. OpenClaw's analogue is
  `Ctrl+G` / Control UI agent select, not `@` in Slack.
- Classic CLI `@` in Hermes is context refs, same family as Ziggy TUI file
  completion — do not copy that as specialist addressing.

## Bottom line

Neither product injects config agent/profile ids into Slack or Discord native
`@`. Both complete `/` commands. Hermes TUI (and Bot Mode) complete `@profile`.
OpenClaw picks agents with `Ctrl+G` / AgentSelect. Native `@` for a named
specialist still means a second bot app.
