---
name: plugin-authoring
description: Write or change a Ziggy plugin at plugins/<id>/ (Agent Plugin folder - an MCP server over stdio, an optional interactive MCP Apps view, skills). Use when the person wants a new tool, connector, tracker or view built from a description, or an existing plugin changed.
---

# Ziggy plugin authoring

A plugin is an Agent Plugin folder: `plugin.json`, `mcp.json`, `skills/`, and here a Bun MCP
server with an optional view. It runs out of process, works in Codex, Claude and ChatGPT too, and
its view renders in Ziggy's web UI. Write an extension instead (`extension-authoring`) only when the
capability must hook Pi itself.

The Profile is your working directory. Plugins live at `plugins/<id>/`; their state lives in
`plugin-data/<id>/`, which Ziggy creates and passes as `PLUGIN_DATA`.

## Build one

1. Pick the id: lowercase kebab-case, not the id of a bundled extension or an `extensions/<id>/`
   folder (the extension wins and the plugin is ignored). If `plugins/<id>/` exists, you are
   editing it: read it first and skip to step 4. If `plugin-data/<id>/` exists without the
   plugin, it holds data from an earlier plugin with this id: say so, keep it, and either pick
   another id or write the server to read that data (migrate it, never recreate it).
2. Copy the template next to this file:
   `mkdir -p plugins && cp -R <this skill's folder>/template plugins/<id>`.
   Then replace `example` with the id in `plugin.json` `name`, `package.json` `name`, the
   `ui://example/view.html` uri in `server.ts`, and the skill: rename `skills/example/` to
   `skills/<id>/` and set its frontmatter `name: <id>`. Do this before step 3: `bun.lock`
   records the package name.
   `grep -rni example --exclude-dir=node_modules .` lists the remaining placeholder wording to rewrite in step 4.
3. `cd plugins/<id> && bun install`. Dependencies are pinned in `package.json` and installed
   once into the plugin's own `node_modules/` (with `bun.lock`), so the plugin runs from any
   Profile, outside Ziggy's checkout. Ziggy never installs anything when it loads a plugin, and
   `mcp.json` runs `bun --no-install` so a missing install fails fast instead of fetching.
4. Write the plugin: tools in `server.ts`, the view in `ui/view.ts` built from the kit
   (`ui/kit.ts`, `ui/kit.css`; see Views), the tool lists at the top of `smoke.ts`, and
   `skills/<id>/SKILL.md` telling a future you when and how to use the tools.
   Add npm dependencies with `bun add <name>@<exact version>`.
5. `bun run check` (Vite build, `smoke.ts`, then `shots.ts`). Smoke checks the files with
   Ziggy's own rules (`rules.ts`; do not edit it), starts each stdio server the way Ziggy does
   with a scratch `PLUGIN_DATA`, and calls the tools. Shots renders the view with the results
   smoke saw (see Views). Fix every failure before going on.
   Smoke calls only reads and local writes (effects stay in `PLUGIN_DATA`). A tool that writes
   anywhere else (an external API, a message, a file outside `PLUGIN_DATA`) goes in
   `EXTERNAL_WRITES`: smoke lists it with its visibility and never calls it. Never move one into
   the called lists to test it; try it with the person in the web UI instead. When
   `plugin-data/<id>/state.sqlite` exists, smoke also runs the reads once against a copy of it.
   A local write whose `{ "$id": … }` has no item (the read returned nothing, say an empty
   inbox) is skipped with a warning; say which writes went untested.
   A server whose `${NAME}` is unset is a warning, not a failure: smoke skips it, as Ziggy does.
   Give the person the `ziggy plugin secret set` command (see Secrets), and once they have run
   it, run `bun run check` again so smoke starts that server too.
   Debug inside the plugin folder and the Profile: `node_modules/`, `PLUGIN_DATA`, the tools'
   own output. Never read or search the person's home files, shell config, Keychain or other
   folders to explain a failure; ask the person instead.
6. Enable it with `profile_extensions` `{"action": "add", "id": "<id>"}`. Claim success only
   from `ok: true`. It reaches sessions opened afterwards; in this session, say so and stop.
   After an edit to an already enabled plugin, run `bun run check` again: view changes show on
   the next view load, server and skill changes in the next session.
7. Report the id, the tools (which are app-only), any secret the person must set, and what to
   try in the web UI.

## Rules Ziggy enforces

A server that breaks one of these is skipped with a warning in the session log, not an error the
person sees, so `smoke.ts` checks them.

- `plugin.json` and `mcp.json` keep the template's exact `$schema` values. `mcp.json` has only
  `$schema` and `mcpServers`; a stdio server only `type`, `command`, `args`, `env`, `cwd`; a
  remote one only `type`, `url`, `headers`. Any other key disables the server or the file.
- stdio `command` is a bare name on PATH (`bun`) or a `./` path inside the plugin. `cwd` is
  `./…`, `${PLUGIN_ROOT}[/…]` or `${PLUGIN_DATA}[/…]`. `env` may not set `PLUGIN_ROOT` or
  `PLUGIN_DATA`; Ziggy sets both.
- `${NAME}` secrets expand only in stdio `env` and in remote `headers` and `url`, never in
  `command`, `args` or `cwd`. An unset `${NAME}` skips the server and names the variable.
- Remote servers are `streamable-http` with an `https` url (`http` only on loopback). No SSE.
- One server is named `<id>`; several are `<id>_<key>`. Tools reach the model as
  `mcp__<server>__<tool>`, through `codemode` by default.
- The plugin folder is read-only at run time. Keep state in `PLUGIN_DATA`. Every session starts
  its own server process, so open SQLite with WAL and a busy timeout, as the template does.
- stdout is the MCP protocol: log with `console.error`.
- Skill frontmatter is YAML: always quote `description: "…"`. An unquoted value containing
  `: ` (as in `Use when: …`) does not parse, and the plugin fails to load. Keep `name` and
  `description` on one line each, with no comments or repeated keys, and close the block with a
  line that is exactly `---`.

## Secrets

Never ask for a secret in chat, never accept one pasted there, and never write one into a file,
`mcp.json` or a command. Reference it as `${NAME}` (for example
`"env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}"}`) and give the person the exact command to run in
their own terminal. The Profile argument is the Profile folder, your working directory: run
`pwd` and print, for example,

```sh
ziggy plugin secret set "/Users/ana/.ziggy/profiles/home" GITHUB_TOKEN
```

with the real path and name filled in. It prompts without echo and stores the value in the macOS
Keychain (service `ziggy-plugin`, account `<NAME>`). It is not per Profile: every Profile on the
machine that uses `${NAME}` gets the same value, so tell the person that, and pick a specific
name (`LINEAR_WORK_API_KEY`) when two Profiles need different keys. It applies to sessions
opened afterwards. Until it is set, the server is skipped; that is expected, not a bug.

## Tools and views

- Every tool result has useful `content` text: Slack, Telegram, the CLI, automations and
  specialists see only that text. Add `structuredContent` for the view.
- Writes that a click in the view stands for (check, move, snooze, approve, delete) are app-only:
  `_meta: {ui: {resourceUri, visibility: ["app"]}}`. The model never sees them; the click is the
  person's intent. Keep a model-visible write only when asking in chat is a natural way to do it,
  and never make a destructive bulk write model-visible.
- Calls to external APIs: ask for only the fields the view and text use, and keep GraphQL
  queries shallow (one connection per query; nested connections hit complexity limits). Note
  the page size you ask for and say in the text when a list was cut off (`first 50 of more`).
- When the source can switch a feature off (Linear Triage disabled for a team, an inbox not set
  up), detect it and return it as its own result (`structuredContent.off` and a plain sentence),
  not as an error or an empty list.
- A view reaches only its own server's tools, through the host. It has no network: Ziggy applies
  the CSP from the resource's `_meta.ui.csp`, which allows nothing remote unless you list origins
  in `connectDomains` or `resourceDomains`. Call external APIs from `server.ts` instead.
- The view frame is sandboxed with scripts only: no `<form>` submit (use button `click` and
  `Enter` `keydown`, as the template does), no `alert`/`confirm`/`prompt`, no popups, no storage
  you can count on. Keep state on the server.
- Build the view as one inline file (the template's Vite single-file build).
- `app.sendMessage` only drafts text into the composer for the person to send; never rely on it
  being sent. `app.openLink` opens http(s) links only.
- Views render only in live web UI conversations; everywhere else the text is all there is.

## Views

Build every view from the kit in `ui/kit.ts` and `ui/kit.css`, as `ui/view.ts` does. Never
hand-roll a control, a state or a refresh loop; if the kit lacks something, add it to the kit
in the same style. Smoke fails a view built without the kit.

- Controls: `button` (primary, secondary, danger), `tag` (tones), `field` (Enter submits, no
  `<form>`), `menu` (a select for "Move to…"), `confirmButton` for anything destructive or
  external (two clicks; the armed state survives refreshes), `datePresets` for dates.
- Layout: `stack`, `row` (wraps), `toolbar` (extra actions fold into "More…" below 480px).
  Style only with the kit classes and `--kit-*` tokens, which follow the host's theme variables
  and light and dark.
- Rows: `keyedList` keyed by id, updating rows in place. Never `replaceChildren` a list on
  refresh: the row under the pointer must stay the same node or the click is lost.
- States: `query` gives pending, data and error; show `skeleton` only once it is slow, keep the
  last data when a refresh fails (say so in the `status` line), and `notice` for each of empty,
  "off" (the feature is switched off at the source) and error (with a retry). Design the empty
  and "off" text: say what it means and what to do.
- Writes: through `writeQueue`, one at a time with a re-read after each. Don't disable the
  whole view while one runs.
- Refresh: `refreshOnReturn` re-reads on focus and visibility, at most every 2 s, never in the
  middle of a click. A view can open from history with an old result, so keep it.
- `bun run shots` renders each state (each distinct result smoke recorded, plus error and
  loading) in a stub host with Ziggy's light and dark theme, at 375 and 760px, into `shots/`,
  and fails on sideways scrolling, console errors and accessibility or contrast problems. It
  checks the HTML smoke loaded, so after a rebuild run `bun run check`, not `shots` alone. Look
  at the screenshots before you report. It uses a Chrome, Chromium, Edge or Brave already installed
  (`CHROME_PATH` to pick one); `bun run check` skips it with a warning when there is none.
  `shots/fixtures.json` holds results from smoke's scratch run, not from the Profile's data
  copy; a plugin that reads an external API still records real results there, so keep `shots/`
  out of anything shared.

## Changing a plugin

Read the whole plugin first. Keep stored data: add tables with `CREATE TABLE IF NOT EXISTS` and
columns with a guarded `ALTER TABLE … ADD COLUMN`, never drop or recreate. Put each new tool in
its `smoke.ts` list (reads, local writes or external writes), then `bun run check`.
