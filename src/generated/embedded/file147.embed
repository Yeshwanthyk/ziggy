---
name: github
description: Interact with GitHub through the authenticated `github` Pi tool.
---

# GitHub

Pass the `gh` subcommand and flags as the `args` array. Use `--repo owner/repo`
outside a Git repository, or use a GitHub URL directly.

Prefer structured output with `--json` and `--jq`.

Before any mutation, state the exact repository/resource target and intended
effect. Mutations remain normal `github` tool calls.

Examples:

```json
{"args":["pr","checks","55","--repo","owner/repo"]}
```

```json
{"args":["run","view","12345","--repo","owner/repo","--log-failed"]}
```

```json
{"args":["issue","list","--repo","owner/repo","--json","number,title"]}
```

Use `api` when a typed `gh` subcommand does not expose the needed operation:

```json
{"args":["api","repos/owner/repo/pulls/55","--jq",".title, .state, .user.login"]}
```
