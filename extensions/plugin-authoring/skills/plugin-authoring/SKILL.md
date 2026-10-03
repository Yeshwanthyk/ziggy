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
4. Write the plugin: tools in `server.ts`, the view in `ui/view.html` + `ui/view.ts`, the tool
   lists at the top of `smoke.ts`, and `skills/<id>/SKILL.md` telling a future you when and how
   to use the tools.
   Add npm dependencies with `bun add <name>@<exact version>`.
5. `bun run check` (Vite build, then `smoke.ts`). It checks the files with Ziggy's own rules
   (`rules.ts`; do not edit it), starts each stdio server the way Ziggy does with a scratch
   `PLUGIN_DATA`, and calls the tools. Fix every failure before going on.
   Smoke calls only reads and local writes (effects stay in `PLUGIN_DATA`). A tool that writes
   anywhere else (an external API, a message, a file outside `PLUGIN_DATA`) goes in
   `EXTERNAL_WRITES`: smoke lists it with its visibility and never calls it. Never move one into
   the called lists to test it; try it with the person in the web UI instead. When
   `plugin-data/<id>/state.sqlite` exists, smoke also runs the reads once against a copy of it.
   A server whose `${NAME}` is unset is a warning, not a failure: smoke skips it, as Ziggy does.
   Give the person the `ziggy plugin secret set` command (see Secrets), and once they have run
   it, run `bun run check` again so smoke starts that server too.
   Debug inside the plugin folder and the Profile. Never read or search the person's home
   files, shell config or other folders to explain a failure; ask the person instead.
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
Keychain (service `ziggy-plugin`, account `<NAME>`), shared by every Profile that uses that name. It applies to sessions
opened afterwards. Until it is set, the server is skipped; that is expected, not a bug.

## Tools and views

- Every tool result has useful `content` text: Slack, Telegram, the CLI, automations and
  specialists see only that text. Add `structuredContent` for the view.
- Writes that a click in the view stands for (check, move, snooze, approve, delete) are app-only:
  `_meta: {ui: {resourceUri, visibility: ["app"]}}`. The model never sees them; the click is the
  person's intent. Keep a model-visible write only when asking in chat is a natural way to do it,
  and never make a destructive bulk write model-visible.
- A view reaches only its own server's tools, through the host. It has no network: Ziggy applies
  the CSP from the resource's `_meta.ui.csp`, which allows nothing remote unless you list origins
  in `connectDomains` or `resourceDomains`. Call external APIs from `server.ts` instead.
- The view frame is sandboxed with scripts only: no `<form>` submit (use button `click` and
  `Enter` `keydown`, as the template does), no `alert`/`confirm`/`prompt`, no popups, no storage
  you can count on. Keep state on the server.
- Build the view as one inline file (the template's Vite single-file build). Style it only with
  the host theme variables (`--color-background-primary`, `--color-text-primary`,
  `--color-border-primary`, `--font-sans`, `--border-radius-md`, …) with fallbacks, as
  `ui/view.html` does, so it follows light and dark. Keep it usable at phone width (about 360px).
- `app.sendMessage` only drafts text into the composer for the person to send; never rely on it
  being sent. `app.openLink` opens http(s) links only.
- A view can open from history with an old result, so it refetches on load, focus and
  visibility (template `refresh`). Keep that.
- Views render only in live web UI conversations; everywhere else the text is all there is.

## Changing a plugin

Read the whole plugin first. Keep stored data: add tables with `CREATE TABLE IF NOT EXISTS` and
columns with a guarded `ALTER TABLE … ADD COLUMN`, never drop or recreate. Put each new tool in
its `smoke.ts` list (reads, local writes or external writes), then `bun run check`.
