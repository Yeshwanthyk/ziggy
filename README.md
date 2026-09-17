# Ziggy

Ziggy is a folder that is an assistant: one Bun/TypeScript runtime around the published Pi coding-agent SDK. Pi owns models, sessions, tools, and transcripts; Ziggy owns visible Profile policy and composition.

Current version is **0.2.8**. Notable changes live in [CHANGELOG.md](CHANGELOG.md).

## Install

macOS Apple Silicon:

```sh
curl -fsSL https://github.com/Yeshwanthyk/ziggy/releases/latest/download/install.sh | sh
```

That curl command is the canonical install path. It publishes `~/.local/bin/ziggy`, verifies the
SHA-256 published next to the binary, and refuses to overwrite a symlink. If that user-local bin
directory is not already on the interactive shell's `PATH`, add it before invoking `ziggy`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Then:

```sh
ziggy version
ziggy init my-bot
```

`ziggy update` uses the same GitHub release assets. Linux and Intel Mac builds are not in 0.2.8.

## Core commands

```text
ziggy init <name|path>
ziggy [<name|path>]
ziggy run [-c] <name|path> <prompt...>
ziggy sessions list <name|path>
ziggy sessions show <name|path> <session-id|relative-path>
ziggy serve <name|path>
```

`serve` runs the resident Profile owner, including the automation scheduler and any configured channel loops. `ziggy gateway <name|path>` remains a compatibility alias.

Run `ziggy help` for the complete command surface.

## Web access

After `ziggy init my-bot`, configure a stable local port, install the resident, and issue a browser
pairing link:

```sh
ziggy web configure my-bot --port 8797
ziggy serve install my-bot
ziggy web pair my-bot
```

Use `ziggy serve restart my-bot` instead of `install` when the resident is already installed.
The pairing link works for 10 minutes; the resulting browser session lasts 30 days across resident
restarts. Tailscale is an optional way to enable remote access. See
[Web access](docs/operations/web-access.md) for remote setup, additional browsers, revocation, and
troubleshooting.

## Operations guides

- [Supervise `ziggy serve`](docs/operations/serve.md)
- [Use Ziggy from a browser](docs/operations/web-access.md)
- [Inspect stored sessions](docs/operations/sessions.md)
- [Update bundled extensions](docs/operations/extension-updates.md)
- [Connect a Profile to Telegram](docs/operations/telegram.md)
- [Connect a Profile to Discord](docs/operations/discord.md)
- [Connect a Profile to Slack](docs/operations/slack.md)
- [Drive a Profile from Buzz over ACP](docs/operations/acp-buzz.md)
- [Operate automations](docs/operations/automations.md)
- [Operate Profile memory](docs/operations/memory.md)

Architecture note: [Web access ownership](docs/architecture/web-access.md).

## Development

```sh
bun install --frozen-lockfile
bun run check
bun test ./test ./extensions ./tooling && bun run test:helpers
```
