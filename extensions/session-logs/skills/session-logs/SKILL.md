---
name: session-logs
description: "Search and analyze Pi session JSONL, including older or parent conversations, message history, tool use, token usage, and cost."
---

# Session Logs

Search Pi's append-only session JSONL when a user asks about earlier conversations or historical context.

## Locate sessions

Ziggy runs with the active Profile as its working directory and stores Profile sessions under `./sessions`. Standalone Pi normally stores sessions under `~/.pi/agent/sessions/<encoded-cwd>/`. Use the location that matches the current runtime; do not search unrelated user directories.

For Ziggy:

```bash
SESSION_DIR="$PWD/sessions"
fd -e jsonl . "$SESSION_DIR"
```

Each JSONL file starts with a `session` header. Later entries include `message`, `compaction`, and branch metadata. Message entries use `message.role` values such as `user`, `assistant`, and `toolResult`.

## Common queries

List sessions by modification time and size:

```bash
fd -e jsonl . "$SESSION_DIR" -0 |
  xargs -0 stat --printf '%y %s %n\n' |
  sort -r
```

Find sessions from a specific day:

```bash
while IFS= read -r file; do
  head -n 1 "$file" | jq -e 'select(.timestamp | startswith("2026-01-06"))' >/dev/null &&
    printf '%s\n' "$file"
done < <(fd -e jsonl . "$SESSION_DIR")
```

Extract user text from one session:

```bash
jq -r '
  select(.type == "message" and .message.role == "user")
  | .message.content
  | if type == "string" then .
    else .[]? | select(.type == "text") | .text
    end
' <session>.jsonl
```

Search assistant text:

```bash
jq -r '
  select(.type == "message" and .message.role == "assistant")
  | .message.content[]?
  | select(.type == "text")
  | .text
' <session>.jsonl | rg -i 'keyword'
```

Get total assistant and tool cost:

```bash
jq -s '
  [
    .[]
    | if .type == "message" then .message.usage.cost.total
      else .usage.cost.total
      end
    | numbers
  ]
  | add // 0
' <session>.jsonl
```

Count messages and show the time span:

```bash
jq -s '{
  messages: [.[] | select(.type == "message")] | length,
  user: [.[] | select(.type == "message" and .message.role == "user")] | length,
  assistant: [.[] | select(.type == "message" and .message.role == "assistant")] | length,
  first: .[0].timestamp,
  last: .[-1].timestamp
}' <session>.jsonl
```

Show tool usage:

```bash
jq -r '
  select(.type == "message" and .message.role == "assistant")
  | .message.content[]?
  | select(.type == "toolCall")
  | .name
' <session>.jsonl | sort | uniq -c | sort -rn
```

Search every session for a phrase:

```bash
rg -l -i 'phrase' "$SESSION_DIR" -g '*.jsonl'
```

## Practice

- Sample large logs with `head` and `tail` before running broad extraction.
- Quote paths and use null-delimited output when filenames are piped between commands.
- Treat session logs as sensitive: return only the context needed for the user's request.
- Do not edit session JSONL while Pi or Ziggy may be using it.
