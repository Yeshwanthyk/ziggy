# Plugins

A plugin is an [Agent Plugin](https://agent-plugins.org) folder: `plugin.json`, `mcp.json`
(MCP servers) and `skills/`. It runs as separate MCP server processes, works in Codex, ChatGPT and
Claude too, and may ship an MCP Apps view. An extension, by contrast, is a Pi package that runs
in-process and only in Ziggy.

```text
<profile>/
├── extensions.json            selects plugins by id, like extensions
├── plugins/<id>/              plugin.json, mcp.json, skills/, server code, ui/
└── plugin-data/<id>/          PLUGIN_DATA: the plugin's own state (Ziggy never writes plugins/<id>/)
```

## Add, remove, write

- Select or drop a plugin with `ziggy extensions add|remove <profile> <id>` or the
  `profile_extensions` tool. A plugin applies to new sessions.
- An extension owns its id. `plugins/<id>` is ignored, with a warning, when `extensions/<id>`
  exists or `<id>` is bundled.
- To have Ziggy write one, enable the bundled `plugin-authoring` extension and describe what you
  want. The skill copies its template, runs `bun install` in `plugins/<id>/`, writes the server, view
  and skills, runs the plugin's `bun run check`, and selects it. The check covers the build, a smoke
  test and screenshots. A plugin carries its own `node_modules` and `bun.lock`. `bun` must be on the
  resident's PATH.

## `mcp.json`

- Server types:
  - `stdio` and `streamable-http` are supported.
  - `sse` is skipped, because Pi has no SSE transport.
  - `http` must be `https`, except on loopback.
- Server names:
  - A plugin with one server names it `<plugin-id>`. With more, they are `<plugin-id>_<name>`.
  - Tools are `mcp__<server>__<tool>`.
- `command` is a bare name looked up on PATH, or a `./` path inside the plugin.
- `cwd` is one of `./…`, `${PLUGIN_ROOT}[/…]` or `${PLUGIN_DATA}[/…]`.
- `${NAME}` expands only in `env`, `headers` and `url`, never in argv:
  - Values put into a url are URI-encoded.
  - An unset `${NAME}` skips that server, with a warning naming the variable.

## Secrets

```sh
ziggy plugin secret set squarey LINEAR_API_KEY
```

- The command prompts with input masked on a terminal, and otherwise reads stdin. It never echoes
  the value. The web UI SDK calls the same thing as `setPluginSecret`.
- Values live in the macOS Keychain under service `ziggy-plugin`, keyed by name. If the Keychain has
  no value, the process environment is used.
- **Secrets are shared by every Profile on the machine**:
  - The Profile argument only checks that the Profile exists.
  - Any process running as you can read a secret with
    `security find-generic-password -s ziggy-plugin -a NAME -w`.
  - Off macOS, reads find nothing and writes fail.
- Known secret values are redacted from MCP and codemode tool results. These count as known:
  - header values;
  - `env` values whose name contains TOKEN, KEY, SECRET, PASS, AUTH or CREDENTIAL;
  - every `${NAME}` substitution.
- Two places can still hold secrets unredacted:
  - Pi's `mcp.log`, a plaintext file in the user cache, outside the Profile;
  - results over 20 KB, which Pi writes to temp files before redaction runs.
- OAuth sign-in for MCP servers is off. Use API keys.

## Who gets plugin tools

- Main sessions always load the MCP stack: MCP servers, codemode and tool search.
- Specialists and automations load it only when their tool allowlist names `codemode` or an
  `mcp__…` tool:
  - A script must name `codemode` and each MCP tool it calls.
  - An automation with no allowlist never loads plugin tools.
- Plugin tools are exposed through codemode by default, so large plugins stay out of the model's
  context.

## Views (MCP Apps)

- A tool with `_meta.ui.resourceUri` renders a view inline in the web UI, but only in a live web UI
  conversation.
- Everywhere else the model and the reader get the tool's text result. This covers stored
  sessions, Slack, Discord, Telegram, ACP, automations and specialists.
- **Isolation:**
  - Views run in a `srcdoc` iframe with `sandbox="allow-scripts"`, plus a CSP built from the
    resource's `_meta.ui.csp`.
  - `ui/message` only drafts into the composer.
  - `ui/open-link` opens http(s) links only, after a user gesture or a confirm.
- **Tool visibility:**
  - Tools whose `_meta.ui.visibility` lacks `"model"` are hidden from the model in every exposure
    mode.
  - A view can call only tools of its own server whose visibility includes `"app"`.
  - App results get the same redaction.
- **How it works on stock Pi:**
  - One transport tap, `src/extensions/mcp-apps.ts`, passed through
    `createMcpExtension({ createTransport })`.
  - It adds the `io.modelcontextprotocol/ui` capability to `initialize` and records `_meta.ui` from
    `tools/list`.
  - It sends the view's `tools/call` and `resources/read` on Pi's live connection, with string ids
    `ziggy-app-<n>`.
  - App calls skip Pi's `tool_call`/`tool_result` hooks, because stock Pi can't put an app-only tool
    in that pipeline without the model reaching it. The tap enforces the server and visibility rules
    instead.
- **Limits:**
  - A codemode script that opens several views shows only the last one.
  - App calls fail while Pi's connection is down. Pi reconnects on its next call, and Ziggy doesn't
    open a second connection, which would start a second stdio server.
  - History entries from before views, or with a truncated result, show a placeholder.

## Writing good views

The `plugin-authoring` template's `ui/kit.css` and `ui/kit.ts` provide:

- buttons, rows keyed and updated in place, tags, fields, a menu, a two-click confirm, date presets;
- a toolbar that folds into "More…" below 480 px;
- a `query` helper with fixed loading, empty, "feature off" and error-with-retry states;
- a write queue.

Views use the host's theme variables only. `bun run shots` takes headless screenshots in light and
dark at 375 and 760 px, and fails on overflow, console errors, accessibility and contrast problems.
`smoke.ts` calls declared reads and writes local to `PLUGIN_DATA`, and never calls external writes.
