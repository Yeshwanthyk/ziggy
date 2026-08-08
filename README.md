# Ziggy

Ziggy is a folder that is an assistant: one Bun/TypeScript runtime around the published Pi coding-agent SDK. Pi owns models, sessions, tools, and transcripts; Ziggy owns visible Profile policy and composition.

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

## Development

```sh
bun install --frozen-lockfile
bun run check
bun test ./src ./extensions && bun run test:helpers
```
