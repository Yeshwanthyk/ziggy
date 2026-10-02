# Plugins

Ziggy hosts open-protocol plugins (Agent Plugins format + MCP + MCP Apps UIs) and writes new ones
for the user, the way it already writes extensions.

- **Extension**: a Pi package, in-process TypeScript, Ziggy-only, may hook Pi internals.
- **Plugin**: an Agent Plugin folder (`plugin.json`, `mcp.json`, `skills/`), out-of-process MCP
  servers, portable to Codex/ChatGPT/Claude, may ship an MCP Apps UI.

Worked example throughout: a read-only **Linear** connector plugin plus the user's own **triage**
plugin (own `server.ts`, rules as code, board UI). See "Example" at the end.

## Requirements

| Id | Requirement |
|---|---|
| R0 | A drop-in Agent Plugin works in every face (web, Slack/Telegram/Discord, ACP, CLI); faces without a UI get text. |
| R1 | Ziggy writes plugins from a description (step 3). |
| R2 | Plugins load only when selected in `<profile>/extensions.json`. |
| R3 | Plugin tools obey specialist/automation tool allowlists and Pi tool hooks. |
| R4 | Ziggy never modifies a plugin folder while loading it. |
| R5 | One registry: `extensions.json` through the `profile_extensions` tool. |
| R6 | Enable, disable, remove are one `profile_extensions` operation each. |
| R7 | Large plugins stay out of the model context (codemode exposure by default). |
| R8 | No plaintext tokens in the Profile. Secrets live in the macOS Keychain. |
| R9 | MCP Apps UIs render in the web UI (step 4). |

## Decisions

- Use Pi 0.99.1's built-in `createMcpExtension`, `createCodemodeExtension`,
  `createToolSearchExtension` (exported from `@earendil-works/pi-coding-agent`). No Ziggy MCP client.
- Remove `extensions/codemode` (Ziggy's own interpreter) in favour of Pi's codemode.
- **A5 gating**: Pi auto-activates `codemode` when MCP tools exist (`pi.setActiveTools([...active, "codemode"])`).
  Main sessions keep that. Specialist and automation sessions reach plugin tools only when their
  allowlist names `codemode` and each `mcp__<server>__<tool>` it calls (Pi's default exposure is
  codemode, so an `mcp__` name without `codemode` loads the server but cannot be called);
  auto-activation must not widen an allowlist.
- **Config and secrets do not live in plaintext in the Profile.** Ziggy supplies `loadConfig`,
  `credentials` and `logPath` itself instead of Pi's defaults (`<agentDir>/mcp.json`,
  `<agentDir>/mcp-auth.json` plaintext, `<agentDir>/mcp.log`; `agentDir` is the Profile path).
  The credential store refuses every write (OAuth off until G3); the log goes to the user cache,
  outside the Profile.
- `startupWaitMs` is 3000 ms for headless faces. This bounds Pi's discovery timer, not wall-clock
  startup.
- **Plugin secrets (G1)**: `${NAME}` in `mcp.json` `env`/`headers`/`url` resolves from
  Keychain service `ziggy-plugin`, account `<NAME>` (then process env). Unresolved → server skipped
  with a diagnostic naming the variable; never a crash. Values never pass through chat or logs.
- `${PLUGIN_ROOT}` = plugin folder, `${PLUGIN_DATA}` = `<profile>/plugin-data/<id>/` (created on load).
- UI iframes: `srcdoc`, `sandbox="allow-scripts"` (no same-origin), CSP from `_meta.ui.csp` as a meta
  tag. `ui/message` lands in the composer and never auto-sends. Only http(s) links open.
- UI `tools/call` goes through the session's Pi tool pipeline as `mcp__<server>__<tool>`, restricted to
  the server that owns the UI and tools whose `visibility` includes `"app"`. Tools with visibility
  `["app"]` only are hidden from the model.
- No Pi patch. Step 1 runs on stock Pi 0.99.1; step 4 must find a way to keep `_meta.ui`, advertise
  `extensions["io.modelcontextprotocol/ui"]` and hide app-only tools without one, or bring a patch
  back to the user as a decision.
- `@ziggy/app-kit` is harvested from the step-3 lab, not designed up front. Step 4 ships only the
  host theme variables (MCP Apps host style variables).

## Order

Each step works without the next.

### Step 1 — Pi MCP + codemode (done)

- [x] `src/extensions/mcp.ts` [Pi] builds the three Pi factories with Ziggy's `loadConfig` (servers handed in by
  the caller only), a `credentials` store that refuses to persist (OAuth off until G3), `logPath` in the user
  cache outside the Profile, and `startupWaitMs` 3000, plus an inline `tool_result` redactor.
- [x] A5 by not loading the MCP stack: `loader.ts` adds it when `LoadRequest.mcp` is set; `session/runtime.ts`
  sets it for main sessions, and for persona sessions only when the allowlist names `codemode` or an `mcp__`
  tool. Untagged automations never load it.
- [x] Remove `extensions/codemode`; update `catalog.json`, `knip.json`, regenerate the builtin catalog
  and embeds; `check:catalog`, `check:web-assets`.
- [x] Profile `mcp.json` is not read in step 1 (config source arrives in step 2); a test-only config
  proves wiring.
- [x] **Demo**: a test MCP server handed to Ziggy's `loadConfig` is reachable from codemode in a
  main session and not from a specialist or automation without `codemode` or `mcp__` tools.

No Pi patch. A session without the MCP extension cannot gain MCP, codemode or tool-search tools:
`registerMcpServer` only fills a registry that the extension alone connects, and those tools exist only
when their extensions are loaded. Specialists also keep Pi's registry allowlist, so a script needs `codemode`
and each MCP tool it calls named. `mcp__*` names are not refused before their server connects; one that
never appears fails as an unknown tool. Known secrets (configured header, env and client-secret values,
except `!command` values, whose resolved output Pi does not expose) are redacted from MCP and codemode results through Pi's `tool_result` hook, including nested codemode calls.
The redactor is registered last, so an earlier extension's `tool_result` handler sees unredacted MCP output.
Accepted risks: Pi's `mcp.log` is plaintext (user cache, outside the Profile), and results over 20 KB are
spilled to temp files by Pi before the hook runs, so those files may hold unredacted text. Standalone builds
embed QuickJS wasm and the separately addressed Pi worker; the checkout-denied binary smoke executes an MCP
call through codemode. G7 is verified: app-only tools are listed by Pi codemode; the fix stays in step 4.
Source evidence is in `LOG.md`.

### Step 2 — Plugin folders + secrets

- `src/extensions/plugin.ts`: decode `plugin.json` and `mcp.json` (Effect Schema, agent-plugins 1.0.0:
  stdio / streamable-http / sse; `cwd` limited to `./`, `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`; `env` may not
  define PLUGIN_ROOT/PLUGIN_DATA), expand variables, resolve secrets.
- `resources.ts` resolves `<profile>/plugins/<id>/` when it contains `plugin.json`; its `skills/`
  join the skill paths. Selection stays in `extensions.json`; `profile_extensions` accepts plugin ids.
- Server names are `<plugin-id>` for a single server, `<plugin-id>_<name>` otherwise; collisions are
  diagnostics.
- A `ziggy plugin secret set <profile> <NAME>` CLI (reads value from stdin) and a resident method the
  web UI calls; neither echoes values.
- **Demo**: `plugins/linear` (streamable-http `https://mcp.linear.app/mcp/readonly`, bearer
  `${LINEAR_API_KEY}`) enabled via `profile_extensions`; "what's assigned to me" works in web and Slack.

### Step 4 — UI host

- `session/events.ts`: tool events gain `app?: {server, resourceUri, input, result}` (result capped);
  history stores the same. `session/handle.ts` [Pi] gains `callAppTool` and `readAppResource`.
- `packages/ui-sdk/src/protocol/apps.ts`: `app.callTool`, `app.readResource`, `prompt.submit` gains
  optional model-context items.
- `resident/` relays with the server/visibility checks above.
- `clients/web/src/apps/`: app frame (AppBridge + PostMessageTransport from
  `@modelcontextprotocol/ext-apps/app-bridge`), inline card with auto-size + cap, expanded view
  (overlay / side panel / phone sheet) reusing the same iframe, context chips, host theme variables.
- Faces without UI: tool `content` text plus "open in web UI" link.
- `Bun.serve` Host-header check.
- Developed against the official `ext-apps` example servers and one small hand-written fixture,
  not a Ziggy template.
- **Demo**: an `ext-apps` example plugin renders, calls its own tools, and posts to the composer.

### Step 3 — Plugin authoring, developed in a lab

- Bundled `extensions/plugin-authoring/`: skill + template (`plugin.json`, `mcp.json`, `server.ts`
  with the MCP SDK + `registerAppTool`/`registerAppResource`, `ui/` Vite single-file build, `skills/`,
  `smoke.ts`, SQLite WAL + busy timeout for `PLUGIN_DATA`, refetch-on-focus).
- Lab: `ZIGGY_HOME=/Users/yesh/code/personal/dump/plugin-lab`, a fresh Profile. Fixed briefs B1–B4
  run against each skill version, scored in `lab.md`:
  - B1 reading list (local SQLite, list UI)
  - B2 PR inbox from `gh` (CLI wrapper, app-only write tools)
  - B3 Linear triage board with rules (secret, external API, writes)
  - B4 add snooze to the triage board (edit an existing plugin)
  - Score: build + smoke first try, turns/time; UI renders light/dark/phone, uses theme vars, no CSP
    failures; text fallback useful; runs in the `ext-apps` reference host; app-only tools hidden;
    repeated hand-rolled UI → app-kit candidates.
- Then squarey acceptance: the Linear triage plugin.

## Gaps tracked

G1 secrets (step 2) · G2 a plugin UI reaches only its own server, so plugin servers call external
APIs themselves · G3 OAuth sign-in with no TUI (deferred; API keys first) · G4 UI host (step 4) ·
G5 specialist gating (step 1) · G6 stale UI → refetch on focus · G7 app-only tools visible to the
model (verify in step 1, fix in step 4) · G8 one server process per session → WAL · G9 gallery
preview of an unenabled plugin (step 3).

## Example

```text
<profile>/
├── extensions.json            { "extensions": [ …, "linear", "triage" ] }
├── plugins/
│   ├── linear/                plugin.json, mcp.json (readonly endpoint), skills/linear/SKILL.md
│   └── triage/                plugin.json, mcp.json, server.ts, rules.ts, linear.ts, ui/, skills/
├── plugin-data/triage/state.sqlite
└── automations/morning-triage.md
```

The model sees Linear read-only; every write goes through the triage tools, which apply the user's
rules. A click in the plugin UI counts as user intent.

## Resume

- **Objective**: build steps 2, 4, then 3 (lab). Builder and read-only reviewer are Claude Opus 5.5
  subagents (Codex rejects `gpt-6.1-sol` on the ChatGPT account). Commit each step only after the
  reviewer approves.
- **State**: branch `plugins`; Step 1 committed after review round 3 approved (history in
  `step1-review.md`).
- **First next action**: build Step 2.
