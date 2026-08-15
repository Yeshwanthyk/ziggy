# Pi coding-agent runtime requirements

Local-file inventory of the runtime requirements of `@earendil-works/pi-coding-agent`
(installed version **0.84.1**, `engines.node >= 22.19.0`) as observed from:

- the package README and `docs/*` shipped in `node_modules/@earendil-works/pi-coding-agent`
- the compiled `dist/` of the installed package (0.84.1) and its bundled `pi-tui`, `pi-ai`, `pi-client` packages
- `docs/research/pi-sdk-surface.md` (ziggy's authoritative Pi API facts, snapshot 0.82.0)
- `docs/research/minimal-ziggy-scout.md` (ziggy spec)

Every claim below is cited to a doc path/section or a `dist/` file+line. Where a line number
would be brittle, the doc path + section is cited instead.

---

## 1. TUI

**Requirement: an interactive raw-mode terminal app with a custom ANSI renderer. Not ink, not readline.**

- `InteractiveMode` is a terminal application, not a render-into-a-container component: it
  constructs `TUI(new ProcessTerminal(), ...)`, starts a TUI, **uses raw stdin**, writes
  stdout/stderr, installs signal and `uncaughtException` handlers, and can call
  `process.exit(...)` during shutdown. — `docs/research/pi-sdk-surface.md` §10 gotcha 1
  (`src/modes/interactive/interactive-mode.ts:443-467,3528-3573,3585-3661`)
- Rendering is a custom component renderer from `@earendil-works/pi-tui`: components implement
  `render(width): string[]` and `handleInput?(data)`. "The TUI appends a full SGR reset and OSC 8
  reset at the end of each rendered line." — `docs/tui.md` "Component Interface"
- Output is raw ANSI written to stdout: `PI_TUI_WRITE_LOG` "capture[s] the raw ANSI stream
  written to stdout" — `docs/tui.md` "Debug logging".
- Raw-mode stdin is implemented directly on the TTY, not via `readline`:
  - `process.stdin.setRawMode(true)` (saving `this.wasRaw = process.stdin.isRaw` and restoring
    it on teardown), `process.stdin.setEncoding("utf8")`, `process.stdin.resume()` —
    `node_modules/@earendil-works/pi-tui/dist/terminal.js:82-83,361-362` (also in the installed
    tree as `pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/terminal.js`)
  - Bracketed paste mode (`\x1b[?2004h`), resize handling via `process.stdout.on("resize")` and a
    SIGWINCH self-signal, Kitty keyboard protocol negotiation with modifyOtherKeys fallback,
    Windows `ENABLE_VIRTUAL_TERMINAL_INPUT` — same file, `start()`.
- Interactive input: components receive keyboard input as escape-sequence strings; key detection
  via `matchesKey(data, Key.*)`; `wantsKeyRelease` for Kitty key-release events; IME support via a
  zero-width APC `CURSOR_MARKER` escape that positions the hardware terminal cursor
  (hidden by default; `showHardwareCursor` / `PI_HARDWARE_CURSOR=1`). — `docs/tui.md`
  "Focusable Interface (IME Support)", "Keyboard Input"
- Two TUI modes: `regular` and experimental `fullscreen` (`--tui-mode`, setting `tuiMode`).
  Fullscreen uses an alternate-screen transcript with mouse-wheel scroll, OSC 8 hyperlink clicks,
  drag-select, and `tui.altScreen.*` keybindings. — `docs/keybindings.md` "TUI Fullscreen Viewport";
  `docs/settings.md` "UI & Display"
- The interactive entry guards on TTY: `if (!process.stdout.isTTY) ...` —
  `dist/modes/interactive/interactive-mode.js:115`; CLI mode selection checks
  `process.stdin.isTTY && process.stdout.isTTY` — `dist/package-manager-cli.js:473`, `dist/main.js:503`.
- `node:readline` is used only *outside* the TUI: CLI yes/no prompts
  (`dist/main.js:217` `promptConfirm`), JSONL line parsing in session listing
  (`dist/core/session-manager.js:449`), and streaming grep/find child output
  (`dist/core/tools/grep.js:2,149`, `dist/core/tools/find.js:1,204`). The TUI itself never uses it.
- Terminal requirements: reliable modifier keys need the Kitty keyboard protocol; Apple Terminal,
  WezTerm, Alacritty, Windows Terminal, VS Code integrated terminal have documented setup —
  `docs/terminal-setup.md`.
- Startup/global state: `initTheme()` is mandatory before constructing interactive UI (the
  exported `theme` proxy reads a `globalThis` slot and throws if uninitialized);
  `setKeybindings(...)` is also global state. — `docs/research/pi-sdk-surface.md` §10 gotcha 2
  (`src/modes/interactive/theme/theme.ts:799-815`, `interactive-mode.ts:463-464`)

## 2. Sessions

**Requirement: stateful filesystem persistence of append-only, tree-structured JSONL per working directory.**

- Sessions are stored as JSONL files with a tree structure (`id`/`parentId` entries), enabling
  in-place branching without new files. — `README.md` "Sessions"; `docs/session-format.md`
- Default location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`, organized by
  working directory — `docs/session-format.md` "File Location"; auto-save to
  `~/.pi/agent/sessions/` — `README.md` "Sessions".
- `SessionManager.create(cwd, sessionDir?)` persists JSONL in the explicit `sessionDir`; when
  omitted, default is `~/.pi/agent/sessions/<encoded-cwd>/`; `getDefaultSessionDir` builds
  `join(agentDir, "sessions", safePath)`. — `docs/research/pi-sdk-surface.md` §3
  (`src/core/session-manager.ts:1514-1522,472-488`)
- `SessionManager.inMemory(cwd)` — non-persistent mode (empty session dir, `persist = false`) —
  `docs/research/pi-sdk-surface.md` §3 (`session-manager.ts:1567-1570`)
- Persistence is **lazy**: `_persist` defers the header and pre-assistant entries until the first
  assistant message; a run cancelled before that leaves a session ID/path but no JSONL —
  `docs/research/pi-sdk-surface.md` §3 (`session-manager.ts:991-1048`); confirmed as the spec for
  ziggy in `docs/research/minimal-ziggy-scout.md` "Ownership".
- Resume/serialization: `SessionManager.open(path, sessionDir?)`, `continueRecent(cwd, ...)`,
  `forkFrom(sourcePath, targetCwd, ...)`, `list`, `listAll` — `docs/session-format.md`
  "SessionManager API". CLI: `pi -c`, `pi -r`, `--session <path|id>`, `--fork <path|id>`,
  `--session-dir <dir>`, `--no-session` — `README.md` "CLI Reference".
- Session directory precedence: `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir`
  setting — `docs/settings.md` "Sessions".
- Format is versioned (v1→v3); existing sessions are auto-migrated on load —
  `docs/session-format.md` "Session Version". Entry types include messages, model/thinking
  changes, compaction entries (with `retainedTail` checkpoint), branch summaries, labels,
  extension `custom` state, `session_info` names. — `docs/session-format.md` "Entry Types"
- Deletion of sessions uses the `trash` CLI when available — `docs/sessions.md`,
  `docs/session-format.md` "Deleting Sessions".
- `PI_SESSION_FILE` / `PI_SESSION_ID` are exported to bash-tool commands as the absolute JSONL
  path / session ID — `docs/environment-variables.md` "Bash Tool Session Environment".

## 3. Skills

**Requirement: filesystem directory scan at startup (no glob library; plain traversal), with on-demand file reads at runtime.**

- Locations scanned: `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`,
  `.agents/skills/` in `cwd` and ancestor dirs up to git repo root, package `skills/` dirs,
  `settings.skills` array, CLI `--skill <path>`. — `docs/skills.md` "Locations"
- Discovery rules: in `~/.pi/agent/skills/` and `.pi/skills/`, direct root `.md` files are
  individual skills; in all locations, directories containing `SKILL.md` are discovered
  recursively; in `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored —
  `docs/skills.md` "Discovery rules".
- Exact traversal semantics: "Directory traversal treats a directory containing `SKILL.md` as a
  skill root and does not recurse below it; otherwise it loads direct `.md` files and recurses
  into subdirectories." — `docs/research/pi-sdk-surface.md` §8 (`src/core/skills.ts:160-170`)
- No globbing is used for skill discovery (plain traversal); the `glob` dependency appears in
  package management (`dist/core/package-manager.js:24` `globSync`). Settings resource arrays
  (including `skills`) support glob patterns and `!`/`+`/`-` exclusions — `docs/settings.md`
  "Resources"; `docs/packages.md` "Package Filtering".
- Startup behavior: pi scans skill locations and extracts names/descriptions into the system
  prompt; full `SKILL.md` loads on demand via the `read` tool (progressive disclosure) —
  `docs/skills.md` "How Skills Work".
- Frontmatter parsing/validation: required `description` (missing → skill rejected), `name`
  rules (warnings only), `disable-model-invocation` — `docs/skills.md` "Frontmatter",
  "Validation"; `docs/research/pi-sdk-surface.md` §8 (`src/core/skills.ts:67-81,88-112,277-324`).
- Relative references inside a skill resolve against the directory containing `SKILL.md` —
  `docs/research/pi-sdk-surface.md` §8 (`skills.ts:342-355`).
- Skills can instruct the model to run executables; the model executes them through the bash
  tool. — `docs/skills.md` "Locations" security note.

## 4. Process spawning

**Requirement: arbitrary local process execution via `node:child_process` (with `cross-spawn`), used by the bash tool, package manager, and credential resolution.**

- Bash tool spawns commands: `import { spawn } from "child_process"` — `dist/core/tools/bash.js:5`;
  shell resolution (`getShellConfig`), process-tree termination (`killProcessTree`), detached
  child tracking (`trackDetachedChildPid`) — imports in `dist/core/tools/bash.js`.
- Core spawn utilities use `node:child_process` `spawn`/`spawnSync` **and** `cross-spawn` —
  `dist/utils/child-process.js:1-2`.
- Bash tool session env injection and `spawnHook` to rewrite command/cwd/env before execution —
  `docs/extensions.md` "Bash tool" section; `docs/environment-variables.md` "Custom Bash Tools".
  `createLocalBashOperations()` reuses pi's local shell backend (spawning, shell resolution,
  process-tree termination) — `docs/extensions.md` (same section).
- User `!command` / `!!command` run commands from the editor (`!!` excludes output from model
  context) — `README.md` "Editor"; `docs/quickstart.md`.
- Package manager spawns `git` and `npm`: `pi install npm:...` runs `npm install` (production
  `--omit=dev` by default); `pi install git:...` clones to `~/.pi/agent/git/<host>/<path>` and
  reconciles with reset/clean; `npmCommand` setting overrides the npm argv — `README.md`
  "Pi Packages"; `docs/packages.md` "Package Sources", "Dependencies"; `docs/settings.md` "Shell".
- Credential config executes shell commands: `"!command"` apiKey/header values run as commands
  (cached for process lifetime in `auth.json`; resolved per-request in `models.json`) —
  `docs/providers.md` "Key Resolution"; `docs/models.md` "Value Resolution".
- Session deletion shells out to the `trash` CLI — `docs/sessions.md`.
- External editor (Ctrl+G) launches `externalEditor`, `$VISUAL`, `$EDITOR` — `README.md` "Editor";
  `docs/settings.md` "UI & Display". Clipboard via optional `@mariozechner/clipboard`;
  `dist/utils/open-browser.js` opens URLs.
- No `Bun.spawn` anywhere in pi; it is a Node package. Ziggy (Bun) wraps it — pi still spawns
  via `node:child_process` + `cross-spawn`.
- Container guidance confirms the whole process (including tool execution) can run inside Docker /
  OpenShell / Gondolin VM — `docs/containerization.md`.

## 5. Providers

**Requirement: outbound network to model APIs over HTTP(S), SSE streaming, and (for Codex) WebSocket; arbitrary OpenAI/Anthropic/Google-compatible endpoints configurable without code.**

- Model calls are HTTP-based. Anthropic uses the `@anthropic-ai/sdk` client
  (`import Anthropic from "@anthropic-ai/sdk"` — `pi-ai/dist/api/anthropic-messages.js:1`),
  OpenAI-compatible APIs use the `openai` SDK (`import OpenAI from "openai"` —
  `pi-ai/dist/api/openai-completions.js:1`). Both accept an injected `fetch` (wired to pi's
  undici dispatcher — see below).
- Streaming: SSE parsed from the HTTP response body — `for await (const sse of
  iterateSseMessages(response.body, signal))` — `pi-ai/dist/api/anthropic-messages.js:293`.
- WebSocket transport exists for OpenAI Codex: `processWebSocketStream(resolveCodexWebSocketUrl(...))`
  — `pi-ai/dist/api/openai-codex-responses.js:202`. The `transport` setting selects
  `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` — `docs/settings.md` "Message Delivery".
- HTTP layer uses `undici` `Client`/`Pool`/`EnvHttpProxyAgent` and installs a global dispatcher
  (`undici.setGlobalDispatcher`), keeping `fetch` on the same undici implementation —
  `dist/core/http-dispatcher.js:2,56,63,73,83-93`. `HTTP_PROXY`/`HTTPS_PROXY` honored —
  `docs/environment-variables.md`.
- **Custom OpenAI-compatible endpoints via `~/.pi/agent/models.json`** (this is the exact
  mechanism from `docs/models.md` "Minimal Example"):
  ```json
  {
    "providers": {
      "ollama": {
        "baseUrl": "http://localhost:11434/v1",
        "api": "openai-completions",
        "apiKey": "ollama",
        "models": [ { "id": "llama3.1:8b" } ]
      }
    }
  }
  ```
  Supported `api` values: `openai-completions`, `openai-responses`, `anthropic-messages`,
  `google-generative-ai` — `docs/models.md` "Supported APIs". README states: "Add providers via
  `~/.pi/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom
  APIs or OAuth, use extensions." — `README.md` "Providers & Models".
- Extensions register providers programmatically: `pi.registerProvider({ id, baseUrl, auth,
  models, api: openAICompletionsApi() })`, or the legacy provider-config form with `baseUrl`,
  `apiKey`, `api`, `models`, `streamSimple` for fully custom streaming APIs —
  `docs/custom-provider.md` "Quick Reference", "Custom Streaming API". OAuth providers integrate
  with `/login`; credentials persist in `~/.pi/agent/auth.json` —
  `docs/custom-provider.md` "OAuth Support".
- Credential resolution order: CLI `--api-key` → `auth.json` (created `0600`) → environment
  variable → `models.json` provider keys — `docs/providers.md` "Resolution Order"; `docs/sdk.md`
  "API Keys and OAuth". Env-var table for ~35 providers in `docs/providers.md` "API Keys".
- Model catalogs ship built-in and refresh from remote, cached to `~/.pi/agent/models-store.json`
  for offline use — `docs/providers.md` intro.
- Startup network operations: version check to `https://pi.dev/api/latest-version` and
  install/update telemetry to `https://pi.dev/api/report-install`; disabled by `--offline` /
  `PI_OFFLINE=1` / `PI_SKIP_VERSION_CHECK=1` / `enableInstallTelemetry:false` —
  `README.md` "Telemetry and update checks"; `docs/environment-variables.md`.

## 6. Config / environment

**Requirement: a writable config directory (`~/.pi/agent` by default) plus project `.pi/` overlay; many env vars; both overridable for embedding.**

Config files (paths relative to `agentDir`, default `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides):

| File | Purpose | Source |
|------|---------|--------|
| `~/.pi/agent/settings.json` | global settings | `docs/settings.md` |
| `.pi/settings.json` | project settings (overrides global) | `docs/settings.md`; `docs/research/pi-sdk-surface.md` §7 (`settings-manager.ts:188-197`) |
| `~/.pi/agent/auth.json` | API keys + OAuth tokens (0600) | `docs/providers.md` "Auth File" |
| `~/.pi/agent/models.json` | custom providers/models | `docs/models.md` |
| `~/.pi/agent/models-store.json` | cached provider catalogs | `docs/providers.md` |
| `~/.pi/agent/trust.json` | project trust decisions | `docs/settings.md` "Project Trust" |
| `~/.pi/agent/keybindings.json` | keybindings | `docs/keybindings.md` |
| `~/.pi/agent/AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`; `.pi/SYSTEM.md` | prompt context | `README.md` "Context Files" |
| `~/.pi/agent/prompts/`, `themes/`, `extensions/`, `skills/` | resources | `README.md` "Customization" |

Environment variables (from `docs/environment-variables.md` "Pi Process Configuration" and
`README.md` "Environment Variables"):
`AI_AGENT`, `PI_CODING_AGENT`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
`PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`,
`PI_SHARE_VIEWER_URL`, `PI_HARDWARE_CURSOR`, `VISUAL`, `EDITOR`, `HTTP_PROXY`, `HTTPS_PROXY`.
Bash-tool session env (set per command): `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`,
`PI_MODEL`, `PI_REASONING_LEVEL`. Provider API-key vars (e.g. `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, …) — table in `docs/providers.md` "API Keys".
`settings.json` "Shell": `shellPath`, `shellCommandPrefix`, `npmCommand`. Session dir precedence:
`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` — `docs/settings.md` "Sessions".
SDK: `agentDir`/`cwd` are first-class options; ziggy sets both to the Profile path —
`docs/sdk.md` "Directories"; `docs/research/minimal-ziggy-scout.md` "Adapter recipe".

## 7. Extensions

**Requirement: load TypeScript/JS modules from the local filesystem (via jiti), plus npm/git package installation that spawns processes.**

- Discovered from `~/.pi/agent/extensions/` (global) and `.pi/extensions/` (project, after trust);
  direct `*.ts`/`*.js` files load, one-level subdirectories load `index.ts`/`index.js`, or a
  subdirectory `package.json` may declare `pi.extensions: string[]`. No recursion beyond one level
  unless the manifest declares entry points — `docs/extensions.md` "Extension Locations";
  `docs/research/pi-sdk-surface.md` §8 (`src/core/extensions/loader.ts:626-668,561-579`).
- Loaded via **jiti**, so TypeScript works without compilation — `docs/extensions.md` "Writing an
  Extension"; `dist/core/extensions/loader.js:14` (`createJiti` from `jiti/static`).
- Extension factories may be async; pi awaits them before startup continues — `docs/extensions.md`
  "Async factory functions".
- CLI `-e/--extension <path|npm|git>` loads from path, npm, or git; `--no-extensions` disables
  discovery; `settings.extensions` array supports paths and glob patterns —
  `README.md` "CLI Reference"; `docs/settings.md` "Resources".
- Pi packages (`pi install npm:@foo/pi-tools`, `pi install git:github.com/user/repo@v1`, https,
  ssh URLs) install into `~/.pi/agent/npm/` or `~/.pi/agent/git/<host>/<path>` (project-local:
  `.pi/npm/`, `.pi/git/` with `-l`); npm/git installs run `npm install` —
  `README.md` "Pi Packages"; `docs/packages.md`.
- Extensions execute arbitrary code with full system permissions (explicit security warning) —
  `README.md` "Pi Packages" security note; `docs/extensions.md` "Extension Locations".
- Extension `pi` manifest fields: `extensions`, `skills`, `prompts`, `themes`; conventional
  directories auto-discovered; manifest arrays support glob patterns and `!` exclusions —
  `docs/packages.md` "Creating a Pi Package", "Package Filtering".
- Runtime deps must be in `dependencies` (production installs); core packages
  (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) are bundled
  by pi and go in `peerDependencies` — `docs/packages.md` "Dependencies".
- Node built-ins (`node:fs`, `node:path`, …) are available to extensions — `docs/extensions.md`
  "Available Imports".

## 8. Node vs Bun specifics

**Requirement: Node.js >= 22.19.0; no Bun-specific APIs in pi itself.**

- `engines`: `"node": ">=22.19.0"` — installed `package.json` (0.84.1).
- Runtime deps include `cross-spawn`, `glob`, `jiti`, `minimatch`, `proper-lockfile`, `semver`,
  `typebox`, `undici`, `yaml`, `chalk`, `diff`, `highlight.js`, `hosted-git-info`, `ignore`,
  `@silvia-odwyer/photon-node` (image resizing), optional `@mariozechner/clipboard` —
  installed `package.json`; same list at `docs/research/pi-sdk-surface.md` §9 (0.82.0 snapshot).
- Node built-ins used: `node:fs`/`node:fs/promises` (tools, sessions), `node:path`,
  `node:child_process` (`spawn`, `spawnSync`), `node:events` (`http-dispatcher.js:1`),
  `node:readline` (CLI prompts + JSONL/stream parsing, not the TUI), `node:tty`-adjacent raw mode
  via `process.stdin.setRawMode`.
- Node-version-dependent behavior is acknowledged in code: "Node 26.0's bundled fetch can
  otherwise consume compressed responses through npm undici's…" — `dist/core/http-dispatcher.js:84-85`.
- Bundled `dist/bun/` entrypoints exist (cli, register-bedrock, restore-sandbox-env) — these are
  Bun-compatible CLI entry shims in the published package, not Bun-specific APIs.
- No `Bun.*` globals are used by pi; `bun uninstall -g` only appears in uninstall docs —
  `docs/quickstart.md`; `docs/index.md:27`. Ziggy runs the package under Bun 1.3.13 as a wrapper —
  `docs/research/minimal-ziggy-scout.md` "Baseline".
- The Gondolin sandbox example extension requires Node >= 23.6.0 — that is the example's own
  requirement, not pi core — `docs/containerization.md` "Gondolin".

---

## Summary table

| Requirement | Filesystem? | Spawns processes? | Needs raw TTY? | Long-running? | Could run under a stateless/serverless runtime? |
|---|---|---|---|---|---|
| Agent loop (prompt/steer/abort, events, tool loop) | no | via its tools | no | yes (streaming turns) | Yes, if tool set is network-only and no bash; the loop itself is HTTP-in/out |
| Session persistence (JSONL tree, resume, compaction) | **yes** (`~/.pi/agent/sessions/...`, lazy first-assistant write) | no | no | per-session | No — stateful FS, per-cwd organization, lazy writes, resume by path |
| Interactive TUI (`InteractiveMode`) | some (keybindings/themes/trust) | no | **yes** (raw stdin, `setRawMode`, SIGWINCH, Kitty protocol) | yes (resident until quit) | No — needs a real terminal with escape-sequence input |
| Print mode (`-p`) / JSON mode | session FS if persisted | tools may | no | no (one-shot) | Mostly yes (stateless with `--no-session` + in-memory) |
| RPC mode (`--mode rpc`) | session FS if persisted | tools may | no (stdin/stdout pipes; LF JSONL framing) | yes (server until closed) | No — long-lived process owning stdin/stdout |
| Skills loading | **yes** (dir scan: `SKILL.md` traversal, `.md` roots) | no (content may instruct bash) | no | startup-time | Yes with FS; skill bodies may require local executables |
| Extensions loading | **yes** (`~/.pi/agent/extensions`, `.pi/extensions`, package dirs via jiti) | installs do (npm/git) | no | startup-time; extension code may be long-lived | No — arbitrary local code execution, npm/git installs |
| Bash tool + `!`/`!!` commands | cwd access | **yes** (`node:child_process` + `cross-spawn`, `spawnHook`, process-tree kill) | no | per-command | No — arbitrary local execution is the point |
| Package install/update (`pi install/update`) | **yes** (`~/.pi/agent/npm|git`) | **yes** (git clone, `npm install`, `npmCommand`) | no | transient | No |
| Provider model calls | no (caches catalogs to `models-store.json`) | no | no | yes (SSE/WebSocket streaming, retries, backoff) | Yes — outbound HTTPS/SSE/WebSocket; endpoints configurable via `models.json` (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`); undici dispatcher + proxy env vars |
| Auth resolution | **yes** (`auth.json` 0600, `trust.json`) | `!command` apiKeys do | no | cached per process | Partly — env vars work; `!command` and file auth don't |
| Update check + telemetry | no | no | no | startup | Optional — disable with `PI_OFFLINE`/`PI_SKIP_VERSION_CHECK`; needs `pi.dev` reachability otherwise |
| Config/settings | **yes** (`agentDir/settings.json`, `.pi/settings.json`, keybindings/models) | no | no | read at startup | No — config is file-based (ziggy points it at the Profile dir) |
