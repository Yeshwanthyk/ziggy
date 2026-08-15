# Ziggy

Ziggy is a folder that is an assistant: one Bun/TypeScript runtime around the published Pi coding-agent SDK. Pi owns models, sessions, tools, and transcripts; Ziggy owns visible Profile policy and composition.

Current version is **0.1.0**. Notable changes live in [CHANGELOG.md](CHANGELOG.md).

## Install

macOS Apple Silicon:

```sh
curl -fsSL https://github.com/Yeshwanthyk/ziggy/releases/latest/download/install.sh | sh
```

That installs `~/.local/bin/ziggy`, verifies the SHA-256 published next to the binary, and refuses to overwrite a symlink. Then:

```sh
ziggy version
ziggy init my-bot
```

Direct binary download:

```sh
curl -fL -o ziggy https://github.com/Yeshwanthyk/ziggy/releases/latest/download/ziggy-darwin-arm64
chmod +x ziggy
```

`ziggy update` uses the same GitHub release assets. Linux and Intel Mac builds are not in 0.1.0.

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

Session list/show output is transcript-free: it includes only paths, IDs, lineage, timestamps, entry counts, model/thinking changes, usage, and safe terminal state. It never prints prompts, replies, thinking, tool arguments, or tool output.

Run `ziggy help` for the complete command surface.

## Operations guides

- [Supervise `ziggy serve`](docs/operations/serve.md)
- [Connect a Profile to Discord](docs/operations/discord.md)
- [Connect a Profile to Slack](docs/operations/slack.md)
- [Operate automations](docs/operations/automations.md)

## Development

```sh
bun install --frozen-lockfile
bun run check
bun test ./test ./extensions ./tooling && bun run test:helpers
```
