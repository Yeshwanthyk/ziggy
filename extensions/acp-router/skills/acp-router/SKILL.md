---
name: acp-router
description: "Route requests to Pi, Claude Code, Cursor, Copilot, Codex, OpenCode, Gemini CLI, Qwen, Kiro, Kimi, iFlow, Factory Droid, or Kilocode through Agent Client Protocol sessions using the acpx CLI. Use when a user explicitly asks to run or continue work in an ACP-compatible coding harness."
---

# ACP harness router

Use `acpx` to start, resume, prompt, cancel, and close Agent Client Protocol (ACP) harness
sessions. Prefer ACP over scraping an interactive terminal when the requested harness supports
ACP.

## Choose an agent

Map the user's requested harness to the corresponding `acpx` agent:

| User request | Agent |
| --- | --- |
| Pi | `pi` |
| Claude Code | `claude` |
| Codex | `codex` |
| GitHub Copilot | `copilot` |
| Cursor | `cursor` |
| Factory Droid | `droid` |
| OpenCode | `opencode` |
| Gemini CLI | `gemini` |
| iFlow | `iflow` |
| Kilocode | `kilocode` |
| Kimi CLI | `kimi` |
| Kiro CLI | `kiro` |
| Qwen Code | `qwen` |

If the configured agent name differs, inspect `~/.acpx/config.json` and use the configured
name. Do not silently substitute a different coding harness.

## Preflight

1. Verify `acpx` is installed with `acpx --version`.
2. Keep the working directory explicit with `--cwd` when repository context matters.
3. Use a stable session name for follow-up requests.
4. Check `acpx --help` and `acpx <agent> --help` if the installed version's syntax differs.

Install `acpx` according to its upstream package documentation when it is missing. Do not
modify local agent configuration or install adapter binaries without explaining the exact
missing dependency.

## Persistent sessions

Derive a short, stable session name from the harness and task, such as
`codex-auth-refactor`. Reuse it for follow-up prompts.

```bash
acpx codex sessions show codex-auth-refactor \
  || acpx codex sessions new --name codex-auth-refactor

acpx codex -s codex-auth-refactor \
  --cwd /path/to/workspace \
  --format quiet \
  "Inspect the authentication flow and propose the smallest safe refactor."
```

Relay the final assistant output to the user. Include raw protocol or adapter logs only when
they explain a failure or the user asks for them.

## One-shot work

Use `exec` when the user does not need to continue the same harness conversation:

```bash
acpx codex exec \
  --cwd /path/to/workspace \
  --format quiet \
  "Review the current diff for correctness."
```

## Lifecycle commands

```bash
# Inspect a session
acpx codex sessions show codex-auth-refactor

# Cancel the in-flight turn
acpx codex cancel -s codex-auth-refactor

# Close the session
acpx codex sessions close codex-auth-refactor
```

## Failure handling

- `acpx: command not found`: report that the upstream CLI is missing and provide its install
  command when known.
- Adapter executable missing: identify the selected agent and the missing executable; do not
  replace it with another agent.
- `NO_SESSION`: create the named session, then retry once.
- Busy session: wait by default; use asynchronous/no-wait behavior only when requested.
- Unsupported configured agent: show the available configured agents and ask the user to pick
  one.

Never expose secrets from ACP configuration or relay unrelated local logs.
