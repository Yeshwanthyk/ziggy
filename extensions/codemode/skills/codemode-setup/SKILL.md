---
name: codemode-setup
description: "Set up or troubleshoot Ziggy Code Mode for a Profile: select the package, create codemode.json, allow MCP stdio tools, and reopen the runtime."
---

# Code Mode setup

1. Identify the target Profile and check whether `codemode` is selected with
   `profile_extensions list` (or inspect the approved catalogue with `ziggy extensions list`). Select it with
   `ziggy extensions add <profile> codemode` or `profile_extensions add` when needed.
2. Read the installed package's `README.md` for the `codemode.json` example and limits.
   Create `<profile>/codemode.json` as a regular, non-symlink file. Start with
   `{ "mcpServers": {} }` if no MCP tools are needed yet. For each server, specify its
   executable `command`, optional `args` and `env`, and explicit nonempty `allowTools`.
   Verify the command and tool names with the user before granting access; configured MCP
   servers execute with the permissions of that process. Keep credentials in `env`, never in
   generated code, and do not write secrets to logs or chat.
3. Reopen the Profile runtime, or restart its resident with `ziggy serve restart <profile>`
   when changing selection or configuration. Code Mode reads configuration once per Pi
   session; an existing session does not refresh it.
4. Use `codemode_execute` to search for allowed MCP tools and then call them. Its interpreter
   supports `while` and `for...of`, but not classic `for` loops or `try/catch`. If a call
   fails, inspect its bounded error content before changing the allowlist or configuration.

Completion: the reopened runtime can execute a harmless discovery call against the intended
allowlist without exposing credentials.
