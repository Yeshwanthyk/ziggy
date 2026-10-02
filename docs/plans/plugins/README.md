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

### Step 2 — Plugin folders + secrets (done)

- [x] `src/extensions/plugin.ts`: decode `plugin.json` and `mcp.json` (Effect Schema, agent-plugins 1.0.0:
  stdio / streamable-http / sse; `cwd` limited to `./`, `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`; `env` may not
  define PLUGIN_ROOT/PLUGIN_DATA), expand variables, resolve secrets (Keychain service `ziggy-plugin`,
  then process env). An unresolved `${NAME}` skips that server with a diagnostic naming the variable.
- [x] `resources.ts` resolves `<profile>/plugins/<id>/` when it contains `plugin.json`; its `skills/`
  join the skill paths. Selection stays in `extensions.json`; `profile_extensions` accepts plugin ids.
  An extension owns its id: `plugins/<id>` is ignored (with a warning) when `extensions/<id>` exists or
  `<id>` is bundled, in session open, listing and `show` alike, and `add` refuses to select it (an id already selected keeps the extension, so other changes still apply). An
  unselected plugin that cannot be read is left out of listings with a warning; selected ones stay strict.
- [x] Server names are `<plugin-id>` for a single server, `<plugin-id>_<name>` otherwise; collisions are
  diagnostics.
- [x] `ziggy plugin secret set <profile> <NAME>` (masked prompt on a TTY, otherwise stdin) and the resident
  method `plugin.secret.set` (UI SDK `setPluginSecret`); neither echoes values.
- [x] **Demo**: `examples/linear` (streamable-http `https://mcp.linear.app/mcp/readonly`, bearer
  `${LINEAR_API_KEY}`) as the shape to copy into `<profile>/plugins/linear/`. `test/extensions/plugin.test.ts`
  proves the path with a local stdio fixture plugin, a fake Keychain and a scratch Profile. The live
  web/Slack "what's assigned to me" run is left to the user (no real Linear in tests).

Notes. Resolved servers feed Step 1's `loadConfig`. The redactor covers plugin header values (and their
Bearer/Basic tokens), env values whose name matches TOKEN, KEY, SECRET, PASS, AUTH or CREDENTIAL (unless
built from PLUGIN_ROOT/PLUGIN_DATA), and every substituted `${NAME}` value. Secrets never go into argv: `${NAME}` expands only in `env`,
`headers` and `url` (a deviation from the spec, which expands only paths; G1 needs it), `${PLUGIN_*}`
stays literal there, and values substituted into a url are URI-encoded, so they cannot supply a scheme,
host or port. Resolved values are escaped for Pi's own `$`/`!` resolution. A stdio `command` is a bare
name looked up on PATH or a `./` path inside the plugin; `cwd` is `./…`, `${PLUGIN_ROOT}[/…]` or
`${PLUGIN_DATA}[/…]`. `${PLUGIN_DATA}` is `<profile>/plugin-data/<id>/`, created when a session that loads
MCP opens and the plugin's `mcp.json` lists at least one server (even if every server is then skipped);
the plugin folder is never written (R4). A plugin skill that fails Pi's name or description rules is
skipped on its own with a warning. A5 is unchanged: plugin servers ride the Step 1 MCP stack, so only main
sessions and allowlisted personas resolve them. Limits: SSE is skipped (Pi has no SSE transport); http
needs https except on loopback; secrets are user-global in the Keychain (the CLI Profile argument only
validates the target) and apply to new sessions; the items are created by `/usr/bin/security`, whose
access list lets any process running as the user read them with `security find-generic-password -s
ziggy-plugin -a NAME -w` without a prompt (accepted; the access list is not changed); off macOS the
Keychain reads nothing and writes fail; MCP diagnostics are session warnings, not doctor output; no web
UI form yet.

### Step 4 — UI host (done)

Gate: `step4-gate.md`. No Pi patch: one transport tap through `createMcpExtension({ createTransport })`.

- [x] `src/extensions/mcp-apps.ts` [Pi]: the tap. It adds the `io.modelcontextprotocol/ui` capability
  to `initialize`, records `_meta.ui` (resourceUri, visibility) per server, removes tools whose
  visibility lacks `"model"` from `tools/list` (G7: hidden from direct, tool-search and codemode
  exposure), and sends Ziggy's own `tools/call` / `resources/read` on the live transport.
- [x] Tool events and history gain `app?: {server, tool, resourceUri, input, result, truncated?}`
  (result capped). A `tool_result` hook writes it to `details.app`, which Pi persists, so live events
  and history match. A codemode script carries the view of the last MCP call it made that has one,
  because only the script's own result is kept and codemode is the default plugin exposure.
- [x] `session/handle.ts` [Pi]: `callAppTool(server, resourceUri, tool, args)` and
  `readAppResource(server, uri)`, refused (typed `McpAppRefused`) unless the resource belongs to that
  server and the tool belongs to that resource's server and includes `"app"`. App results get the
  same secret redaction as `mcp-redact`.
- [x] `packages/ui-sdk/src/protocol/apps.ts`: `app.callTool`, `app.readResource`; `prompt.submit`
  gains optional `context` items (view model context), joined to that prompt only as ephemeral
  context marked as coming from a view, not the user. Steer and follow-up refuse `context`.
- [x] Resident relay (`application/ui-gateway/apps.ts`): live web-UI (`ui`) sessions only; stored
  sessions and Telegram, Discord and Slack live sessions are `watch_only`. The web client binds each
  view to the conversation it mounted in and refuses its calls and context once another is selected.
  Large results go through an owner-scoped, single-use, 60 s content store
  (`GET /app-content/<id>`, bearer or cookie) instead of the socket frame.
- [x] `clients/web/src/apps/`: AppBridge + PostMessageTransport, `srcdoc` iframe with
  `sandbox="allow-scripts"` and a CSP meta tag built from the resource's `_meta.ui.csp`, inline card
  with auto-size and cap, expanded overlay / side panel / phone sheet reusing the same iframe, context
  chips, host theme variables. `ui/message` drafts into the composer and never sends; `ui/open-link`
  opens http(s) only, after a recent user gesture or a confirm. Every postMessage payload is decoded
  by the ext-apps schemas. The view code loads lazily.
- [x] Faces without UI: the model sees the tool's text result, and Telegram, Discord, Slack, ACP, the
  TUI, automations and specialists show only that (R0). No face adds a link to the web UI: those
  sessions are watch-only there, so their views could never load. The web UI mounts a view only in a
  live web UI conversation (a live session `session.list` reports as kind `ui`); every other session,
  including ended web conversations, shows the note "Interactive view available only in live web UI
  conversations".
- [x] `Bun.serve` Host-header check: 421 unless the Host is `127.0.0.1:<port>`, `localhost:<port>` or
  the public URL host.
- [x] **Demo**: `test/extensions/mcp-apps.test.ts` uses the hand-written fixture
  (`test/extensions/fixtures/mcp-server.ts`): the model is offered `view` and `model_only` but not
  `app_only`; the view calls its own app-only tool through the handle; `model_only`, another server's
  view, an undeclared resource and an unknown server are refused; codemode carries the view.
  `test/application/ui-gateway.test.ts` covers the relay (owner, `ownership`, `watch_only`, single-use
  content) and view context. Browser check in a temp ZIGGY_HOME with both servers as plugins
  (codemode exposure): the fixture view rendered, called `app_only`, was refused `model_only`, and its
  `ui/message` landed in the composer unsent; the official `ext-apps` `server-basic-vanillajs` view
  rendered the time, and its Get Server Time, Send Message, Send Log and Open Link buttons worked;
  expand/collapse kept the same iframe; phone width and sheet fit; the card came back from history
  after reload; a foreign Host got 421.

Deviations. App calls do not run through Pi's `tool_call`/`tool_result` hooks (stock Pi cannot put an
app-only tool in the pipeline without the model reaching it); the tap enforces the same server and
visibility rules and Ziggy redacts results itself. Large results go through the content store rather
than the socket. Codemode carries a nested view (not in the original plan).

Limits. Only the last view per codemode script is shown. A truncated or pre-Step-4 history entry has no
input/result to replay, so its view shows a placeholder. Views of stored (not live) sessions are
refused. The live card remounts once when the turn settles. The CSP meta tag is always the first
element of the `srcdoc`. A meta CSP cannot stop the frame navigating itself: to a real origin, the
bridge's origin guard closes it; a `data:` or `blob:` page keeps origin `"null"`, still sandboxed
without same-origin, and its messages still reach the bridge (scoped to the view's own server). A
tool whose `_meta.ui` does not decode is hidden from the model and logged. App calls fail while
Pi's connection is down. `app.js` stays at 653 kB (198 kB gzip); the ext-apps and MCP core code
loads on first view as `assets/app-view.js` (241 kB, 62 kB gzip).

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
  `step1-review.md`); Step 2 committed after review round 2 approved (minor fixes applied); Step 4 committed after review round 3 approved (follow-ups applied).
- **First next action**: build Step 3 (plugin-authoring skill + template), then run the lab.
