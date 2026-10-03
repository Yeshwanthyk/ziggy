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

### Step 3 — Plugin authoring, developed in a lab (built; lab B1–B4 scored)

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

- [x] `extensions/plugin-authoring/`: optional bundled package (not in `REQUIRED_PACKAGE_IDS`), one
  skill `plugin-authoring` with `template/` beside its `SKILL.md`. Pi stops recursing at a folder
  with `SKILL.md`, so `template/skills/example` is never loaded as a skill. The template is excluded
  from the repo's tsconfig, oxlint and knip; it is embedded like any other package file.
- [x] Template: `plugin.json`, `mcp.json` (stdio `bun --no-install server.ts`, cwd `${PLUGIN_ROOT}`),
  `server.ts` (`McpServer` + `registerAppTool`/`registerAppResource`; `list_items`, `add_item`;
  app-only `set_done`, `remove_item`; every result has text + `structuredContent`; `bun:sqlite` in
  `$PLUGIN_DATA` with WAL + `busy_timeout`), `ui/` (Vite single file, host theme variables with
  `light-dark()` fallbacks, refetch on load/focus/visibility for G6, no `<form>`), `skills/example`,
  `rules.ts` (a dependency-free mirror of `src/extensions/plugin.ts`: exact `$schema`, strict
  keys, command/cwd/env/url/header rules, `${NAME}` lookup, skills; kept in agreement by
  `test/extensions/plugin-authoring.test.ts`), `smoke.ts` (applies `rules.ts`, spawns each stdio
  server as Ziggy would, lists tools with visibility, reads each view, calls only declared reads
  and `PLUGIN_DATA`-local writes, never external writes, and reruns the reads against a
  `VACUUM INTO` copy of an existing `plugin-data/<id>/state.sqlite`).
- [x] Dependencies: the template's `package.json` pins exact versions (ext-apps 2.0.3, MCP
  server/client 2.2.0, zod 4.6.5, vite 8.3.2, vite-plugin-singlefile 2.3.3). The skill runs
  `bun install` once in `plugins/<id>/`, so the plugin carries its own `node_modules` + `bun.lock`
  and runs from any Profile outside the checkout. `mcp.json` uses `bun --no-install`, so loading never
  fetches or writes (R4); a missing install fails fast.
- [x] Skill: copy, rename, install, write, `bun run check`, `profile_extensions add` (claim success
  only on `ok: true`), report. Rules lean on Steps 1/2/4 (command/cwd/env rules, `${NAME}` only in
  env/headers/url, https, server naming, CSP from `_meta.ui.csp`, `ui/message` drafts only) and on
  `smoke.ts` to check them. Secrets only through `ziggy plugin secret set`.
- [x] Lab B1 (reading list, iteration 1): first-try build, 1 turn, 1m31s; view passes dark, light
  and phone; app-only tools work from the view. Found: a new web UI chat does not serve views until
  the sidebar refreshes (fixed); the header shows `Chat <uuid>` after reload (fixed); a live theme
  switch seemed not to apply (not reproducible later). Scores in `lab.md`.
- [x] Review round 2: SKILL.md frontmatter parsed as YAML (as Pi does), unset `${NAME}` is a smoke
  warning that skips the server, no-stdio plugins get static checks only, parity tests for skills
  and `<id>_<key>` naming.
- [x] Review follow-ups (iteration 3): skill frontmatter must load in both Pi's and Ziggy's
  readers, duplicate keys rejected, parity test over 9 SKILL.md texts; smoke fails a tool listed
  twice and never calls EXTERNAL_WRITES.
- [x] Lab B2–B4 against iteration 3, each 1 user turn: B2 PR inbox 2m09s, first try (`gh`
  read-only, Approve app-only and never clicked); B3 Linear triage on a fake 5m33s (first check
  failed on a gap in the fake; the subject read the lab notes, so they moved out of ZIGGY_HOME to
  `/Users/yesh/code/personal/dump/plugin-lab-notes/lab.md`); B4 snooze 2m36s, first try, data kept.
  Views pass light/dark/phone (B4 partial: a button row clips at 375 px).
- [ ] B3 rerun read-only against the user's real Linear once their key is in the lab Profile's
  Keychain entry.
- [x] Browser check of web UI bugs 1 and 3 on a restarted resident (2026-10-03): a new chat
  renders the view without a sidebar refresh; after a reload a pinned chat's header shows its pin
  label.
- [ ] Known issues from the lab, not fixed in Step 3:
  - The first click into a view frame is often lost; a second click works (B3, B4). Host focus.
  - Dark mode: the selected sidebar item's title is unreadable (web UI host styling).
  - Phone width (375 px): chat markdown tables and wide button rows in views clip or scroll
    sideways.
- [x] Template-only lab iterations (scripted model, scratch ZIGGY_HOME): build + smoke first try;
  view in dark, light, phone inline and sheet; refetch from history; app-only tools absent from the
  model's tools and refused in codemode; text fallback. Found and fixed: the frame has no
  `allow-forms`, so `<form>` submit never fires (now click + Enter); empty status margin caused a
  phone scrollbar.

Limits. `bun` must be on the resident PATH (launchd plist PATH under `serve install`). The view is
237 kB (62 kB gzip), mostly ext-apps + zod. Errors inside the view frame do not show in the host
console. G9 (gallery preview of an unenabled plugin) stays open. The `ext-apps` reference host was
not run. App-kit candidates so far: a tiny view bridge, a theme-token CSS block, the refresh helper,
list-row rendering, an input + button add control.

### Step 5 — View quality (in progress)

Goal: views come out consistent and verified, without the author hand-rolling UI. Learned from
lab B1–B4, the real-Linear rerun, and Executor v2 (`executor@2.0.0-beta.6` hand-written React apps
on their own origin: no kit, no screenshot loop; borrow its fixed query states and write queue,
not its hosting or app-owned theming). Everything stays portable MCP Apps unless marked.

Tasks, in order:

- [x] T1 View kit in the template (`ui/kit.css`, `ui/kit.ts`, plain DOM, host variables only,
  inlined by the single-file build): buttons (primary, secondary, danger), list rows keyed by id
  and updated in place, tags, field, menu, one two-click confirm whose armed state survives
  re-render, date presets; layout: stack, wrapping row, toolbar that folds into "More…" below
  480 px; status line that collapses when empty; roles, labels, focus rings, touch-sized targets,
  `aria-live` status.
- [x] T2 Fixed states: a query helper returning data, pending and error; skeleton after ~300 ms;
  empty vs "feature off" vs error with retry; a failed refresh keeps the last data. Writes queue
  one at a time with a re-read between.
- [x] T3 Lost first click: refresh-on-focus no longer rebuilds rows mid-click (rows update in
  place; skip focus refresh while the pointer is down). Verify in the lab browser.
- [x] T4 Screenshot check `bun run shots`: headless browser loads `dist/view.html` in a stub host
  with fixtures; light, dark, 375 and 760 px; fails on horizontal overflow, console errors, axe
  violations and low contrast; part of the template's `bun run check`.
- [x] T5 Skill rules: use the kit, never hand-roll controls; design empty and "feature off"
  states; smoke skips local writes with a warning when reads return no items; keep GraphQL
  queries shallow and note page limits; secrets are shared by every Profile on the machine;
  debugging stays inside the plugin folder and Profile. Smoke checks the view imports the kit.
- [x] T6 Host fixes (`clients/web/src/apps/app-view.tsx`): pass `styles.css.fonts`, real
  `containerDimensions`, success and warning colour tokens.
- [x] T7 Web UI issues: pinned chats showing "Conversation" instead of "Pinned conversation"
  after new chats; dark-mode selected sidebar title unreadable; chat markdown tables clipping at
  phone width.
- [x] T8 `extension-authoring` skill: send requests for UI to `plugin-authoring`.
- [x] T9 Review, then commit Step 5 (approved; follow-ups applied).
- [x] T10 Lab proof: rerun one brief (B3 on fake Linear, plus B4) with the kit; score consistency,
  states, phone width, first click.
- [ ] T11 Squarey acceptance: Linear triage plugin in squarey (real key already in the shared
  Keychain item). Must handle Triage turned off for the team.

Later, not in Step 5: host-drawn confirm and form dialogs (Ziggy-only unless the spec adds
them); declarative JSON views (only if compiled to HTML); per-Profile secret scoping (secrets
stay shared and documented for now); G9 gallery preview.

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
- **State**: branch `plugins`; steps 1–4 committed (Step 3 `c7cf6115`) after reviewer approval;
  lab B1–B4 scored and B3 rerun read-only on real Linear (see `plugin-lab-notes/lab.md`).
- **First next action**: Step 5 tasks T1–T11 above, in order; check each off as it lands.
