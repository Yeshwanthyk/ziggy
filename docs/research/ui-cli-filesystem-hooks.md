# Can third-party UIs be built on Ziggy's CLI + filesystem?

Date: 2026-08-15

Question: Grok Bot and Hermes Agent bot mode show a multi-bot GUI (bot list, live chat, cronjobs, terminal, agent-to-agent messages). Ziggy's idea is that anyone can build any UI because the CLI exposes actions and the filesystem shows everything. Is that enough, or are core hooks missing?

Primary sources:

- Ziggy spec: `docs/research/minimal-ziggy-scout.md`
- Ziggy CLI: `src/faces/cli.ts`, `src/main.ts`
- Ziggy agent API: `src/application/agent.ts`, `src/adapters/pi/pi-agent.ts`
- Pi SDK: `docs/research/pi-sdk-surface.md`
- Prior client-protocol study: `docs/research/deepseek-harness-ziggy-pluggability.md`
- Hermes docs: [Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop), [Web dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard), [Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), [CLI](https://hermes-agent.nousresearch.com/docs/reference/cli-commands), [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [Programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration), [Desktop plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk)
- Hermes Bot Mode plugin: [NousResearch/Hermes-Bot-Mode](https://github.com/NousResearch/Hermes-Bot-Mode)
- Local Hermes checkout: `~/.hermes/hermes-agent` (`apps/desktop/electron/main.ts`, `hermes_cli/web_server.py`, `tui_gateway/ws.py`)
- Prior Hermes inventory: `docs/research/hermes-primary-surface.md`
- Grok Bot: [overview](https://docs.x.ai/grok-bot/overview), [product](https://x.ai/bot)
- Grok Build: [headless/ACP](https://docs.x.ai/build/cli/headless-scripting), [hooks](https://docs.x.ai/build/features/hooks), [agent mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md)
- Pi 0.84.1 in `node_modules/@earendil-works/pi-coding-agent` (`runRpcMode`, `rpc-types.d.ts`, experimental `PiClient`)

## Verdict

**CLI + filesystem is enough for management UIs and one-shot chat. It is not enough for a live Hermes-style GUI.**

Ziggy already has the *product* pieces that screenshot needs — Profiles, named agents, automations, sessions, serve, models, auth. Those are visible files plus CLI. What is missing is a **live session protocol**: stream tokens and tools, abort/steer, resume a specific transcript, and attach to the process that owns the runtime.

That is not a surprise. Hermes Desktop does not spawn `hermes chat` for every keystroke. Electron launches `hermes --profile <p> serve` and talks **TUI Gateway JSON-RPC over WebSocket** (`/api/ws`). REST covers profiles/cron/config. `/api/pty` is the **web dashboard Chat tab** only; the desktop terminal pane is **Electron `node-pty`**, not Hermes. Grok Build, the local CLI analog, exposes ACP JSON-RPC (`grok agent stdio`) and `--output-format streaming-json`. Grok Bot itself is a closed cloud product, not a local CLI-for-UIs model.

The screenshot's BOTS rail is the **[Hermes-Bot-Mode](https://github.com/NousResearch/Hermes-Bot-Mode) desktop plugin**, not core Hermes. Quote: *"A bot **is** a Hermes profile… This plugin is a UI over that primitive."* *"No core patches, no background daemons, no extra storage."* Avatars live in plugin storage. In Hermes core source, "bot mode" mostly means messaging-platform identity (WhatsApp bot number), not this desktop feature.

Ziggy's own spec already says faces talk to `ZiggyAgent`, not to the CLI. Telegram/Discord/Slack already use `openChat` in-process. The 2026-08-13 pluggability study selected the same shape: one typed core, then an app server for out-of-process UIs, with ACP as an optional conversation adapter. This note maps that decision onto Grok Bot / Hermes bot mode and ranks the concrete gaps.

## What those products actually are

| Product | What it is | How a UI talks to it | Filesystem as truth? |
| --- | --- | --- | --- |
| **Grok Bot** | Cloud teammates on a shared persistent VM. Desktop + iOS. Bots message each other and share `/workspace`. | Closed app. Not a local CLI. | Cloud computer filesystem, not a host profile folder. |
| **Grok Build (`grok`)** | Local coding agent: TUI, headless, ACP. | TUI in-process; scripts use `-p` + `plain`/`json`/`streaming-json`; IDEs/custom apps use `grok agent stdio` (ACP JSON-RPC). Lifecycle **hooks** are shell/HTTP callbacks (`PreToolUse`, `Stop`, …), not UI actions. | `~/.grok/` (config, sessions, hooks). Inspectable, not the GUI protocol. |
| **Hermes Agent** | Local agent with CLI, TUI, gateway, desktop, dashboard, ACP. A "bot" is a **profile** (`HERMES_HOME`). | Desktop: `hermes serve` + `/api/ws` JSON-RPC (`prompt.submit`, `session.interrupt`, `cron.manage`, …) and REST. Web dashboard Chat tab: `/api/pty` + sidecar events. Editors: ACP. HTTP API: `/v1/chat/completions` SSE. | Mixed. `SOUL.md` / memories / `cron/jobs.json` are files; **session authority is SQLite `state.db`**. Docs warn: never point two writers at one profile. |
| **Hermes-Bot-Mode** | Desktop plugin over profiles. Roster, avatars, Routines pane, `@mention` handoffs. | Same gateway RPCs (`profiles.list`, `cron.manage`, `host.openSession`). Bot-to-bot: `hermes -p <target> chat -c "Bot Chat" -Q -q "…"`. | Plugin-local avatar storage; profile dir stays export-clean. |

The screenshot (BOTS rail, chat, CRONJOBS, TERMINAL, `hermes -p mr-tester chat -q`) is Desktop + Bot Mode plugin. The CLI command in the thought trace is an **agent tool** for talking to another profile, not the transport the GUI uses to render the current chat. Bot Mode README: messages are **per-invocation**, not pushed into a running agent; the sender backgrounds the CLI and ends the turn.

Hermes architecture names five entry points into one `AIAgent` core: CLI, gateway, ACP, API server, Python library. Desktop is a face on `hermes serve` (same FastAPI as `hermes dashboard`, no browser). Ziggy's equivalent of that core is `ZiggyAgent` + application services, not `ziggy run`.

## Ziggy inventory (what a UI can use today)

### Filesystem — strongest of the three products

A Profile is a folder. Open it and the assistant is mostly grokkable, which Hermes is not (SQLite sessions).

| Path | Owner | UI-readable? | Notes |
| --- | --- | --- | --- |
| `SOUL.md` | Human | Yes | Identity. `init` never overwrites. |
| `MEMORY.md`, `memory/users/`, `memory/groups/` | Agent + human | Yes | Facts, not transcripts. |
| `agents/<id>.md` | Human | Yes | Named specialists. Closest to a Hermes profile *inside* one Ziggy Profile. |
| `automations/<id>.md` | Human | Yes | Cron-like policy + gate. |
| `sessions/**/*.jsonl` | Pi | Yes, if the UI parses JSONL | Transcript authority. CLI `sessions show` **deliberately hides content**. |
| `extensions.json`, `extensions/<id>/` | Operator / Ziggy | Yes | Selected packages. |
| `auth.json`, `models.json`, `settings.json` | Pi | Secrets — do not project | |
| `~/.ziggy/profiles.list` | Ziggy | Yes | Registry of Profile paths. |
| `.runtime/slack-health.json`, `discord-health.json` | Ziggy | Yes | Channel connection snapshots. No Telegram equivalent. |
| `.runtime/automation-scheduler.sqlite`, `serve-owner.sqlite` | Ziggy | Via CLI | Cron ledger and resident lease. Not a human-readable status file. |
| `USER.md` | Spec only | — | Named in the scout spec; **not implemented**. |

Watchability: JSONL appends on **`message_end`**, not per token. Memory files change on tool write. Slack/Discord health JSON updates under `serve`. `SOUL.md`, `agents/*.md`, channel configs, and `extensions.json` stay stale until runtime reopen. JSONL is not a streaming protocol: Pi creates the file lazily on the first assistant message, appends without a cross-process lock, and a GUI tailing the file will lag (`docs/research/stateful-audit.md`).

Do not project: `auth.json`, `telegram.json`, `slack.json`, `discord.json`, raw JSONL (may contain pasted secrets).

Hermes "bot" = one profile directory. Ziggy can map that two ways:

1. **One Ziggy Profile per bot** (`ziggy init developer`, `ziggy init mr-tester`) — matches Hermes isolation and the screenshot's BOTS list.
2. **Named agents inside one Profile** (`agents/developer.md`) — cheaper, shared memory, not a separate process/gateway.

A GUI can list bots by reading `profiles.list` + each `SOUL.md`, and specialists by reading `agents/*.md`. No icon/avatar/theme files exist (OpenClaw stores those on agent identity; Hermes desktop stores rail color in export overlay).

### CLI — management-complete, live-chat-poor

From `src/faces/cli.ts`. Output is human TSV/text. There is no `--json`, no NDJSON event stream, no RPC subcommand.

| Need | Command | Machine-friendly? |
| --- | --- | --- |
| List bots | `ziggy profiles` | Parseable lines, not JSON |
| Create bot | `ziggy init <name>` | Yes enough |
| Send one-shot | `ziggy run [-c] <profile> "…"` | Blocking. Pi print **text** mode streams unframed assistant tokens to stdout; no tool/thinking events, no JSON. Pi also supports `mode: "json"` NDJSON; Ziggy hardcodes `"text"`. |
| Continue latest local chat | `ziggy run -c` | Latest under `sessions/local/main/` only |
| Resume by session id | **Missing** | |
| Stream framed events | **Missing** | Text tokens only on `run`; TUI and `openChat.onProgress` are in-process |
| Abort / steer | **Missing** | Kill the process. No CLI. |
| Automations source edit | TUI `/automations` only | Application `AutomationDefinitions.save` exists; CLI has create/list/pause/resume, not show/save |
| List session metadata | `ziggy sessions list/show` | Yes; **no transcript** |
| Named specialists | `ziggy agents create/list/show/validate/run` | Yes |
| Cron CRUD + wake + status + runs | `ziggy automations …`, `ziggy wake` | Yes; files remain authoritative |
| Resident owner | `ziggy serve` + start/stop/status/logs `--follow` | Status/logs yes; no attach |
| Models / auth / extensions / doctor | present | Human text |

Inter-agent messaging already works the Hermes way: an agent (or a GUI) can spawn `ziggy run <other-profile> "…"` or `ziggy agents run <profile> <agent-id> "…"`. There is no inbox, unread, or presence file.

### Application API — richer than CLI, still incomplete for a GUI

`ZiggyAgent` (`src/application/agent.ts`):

- `runOnce` — print-mode one-shot (CLI `run`)
- `openTui` — Pi `InteractiveMode` (owns the terminal)
- `openChat` — persistent handle used by Telegram/Discord/Slack
- `runSpecialist` — named `agents/<id>.md` child

`ChatHandle` is only `prompt` + `dispose`. Progress is a narrowed callback: assistant **text** deltas and tool start/update/end. Thinking streams (`thinking_delta` inside `message_update`) are dropped. Pi's session already has `steer`, `followUp`, `abort`, and a full `subscribe` event union. Ziggy uses `abort` internally on Effect interruption; it does not expose it.

Non-chat application services are already GUI-shaped if the UI is in-process: Profiles, ProfileAgents, Models, Auth, Sessions (metadata), ExtensionCatalog, AutomationDefinitions (including optimistic `save`), Automations.run, AutomationScheduler.status/runs, ResidentGateway, ResidentService, Doctor. There is no Memory application service (read the markdown files). Auth login needs a terminal `AuthInteraction` today.

This matches Gap 1–2 in `docs/research/deepseek-harness-ziggy-pluggability.md`.

### Pi process modes Ziggy does not use

Pi 0.84.1 gives three out-of-process options Ziggy leaves on the table:

| Mode | Wire | Persistent? | Steer/abort | Ziggy |
| --- | --- | --- | --- | --- |
| `runPrintMode({ mode: "json" })` | stdout NDJSON events | No — disposes after the prompt | No | Unused (`askOnce` is text-only) |
| `runRpcMode` | stdin/stdout **NDJSON commands**, not JSON-RPC 2.0 | Until shutdown | Yes (`prompt`, `steer`, `follow_up`, `abort`, `switch_session`, …) | Unused |
| Experimental `PiClient` / `pi server` | Byte transport, multi-client attach | Yes | Yes | Unused |

Hermes Desktop's `/api/ws` is JSON-RPC. Pi RPC is a different dialect. Do not assume ACP or JSON-RPC 2.0 if wrapping Pi's `runRpcMode`. Grok Build ACP and Hermes TUI Gateway are the closer "custom GUI" contracts; Pi RPC is the closest *already in Ziggy's dependency*.

### Spec vs shipped attach

Spec: once a gateway exists, it owns live sessions and local faces attach.

Shipped: TUI and `run` still open **independent** runtimes while `serve` is resident. No attach, no RPC, no socket (`docs/research/stateful-audit.md`; LOG: attach/RPC deferred). Two writers on one JSONL file are unsafe.

Do not read that as “GUI must attach to Slack.” Session folders already isolate faces (`sessions/local/main/` vs `sessions/slack/<chat>/`). A local GUI and Slack are different conversations. They share Profile files, not a live turn. Attach is only needed if two **local** faces want the same `local/main` chat while `serve` is up.

### How Hermes queues turns (do not copy the process split)

Local Hermes source (`gateway/run.py`, `tui_gateway/methods_prompt.py`, `gateway/turn_lease.py`):

- **Messaging** is `hermes gateway`. **Desktop chat** is `hermes serve` + in-process `tui_gateway`. **CLI** is a third process. They share `state.db`. They do **not** share a live turn lock. Slack + desktop on the same session can race.
- Queue is **per session routing key**, in memory, in the process that owns that chat. Not one global line. Other sessions in the same profile run in parallel.
- Overlap on one session: `interrupt` (default), `queue`, or `steer`. Desktop `prompt.submit` does not reject; it queues or redirects.
- Gateway adds a `session_id` lease only when two routing keys map to one DB session.

Ziggy already matches the right grain: `Semaphore(1)` per Slack/Telegram `chatKey`, many chats in parallel, all inside **one** `serve` process. Keep that. Do not split gateway and GUI into two processes that both write one JSONL. A protocol later belongs on `serve` so a GUI calls the same in-process `ChatHandle`. Slack stays a face of that process, not a second owner.

## Capability matrix vs the screenshot

| GUI panel | Enough today? | How | Gap |
| --- | --- | --- | --- |
| BOTS list | **Yes** | `profiles.list` + `SOUL.md`; optional `agents/*.md` | No avatar/color/description at Profile level; `ziggy profiles` is not JSON |
| + New Agent | **Yes** | `ziggy init` or `ziggy agents create` | Need to pick Profile-bot vs specialist-bot |
| Chat history after the fact | **Partial** | Parse Profile JSONL (filesystem thesis). CLI will not help. | No official transcript projection; JSONL schema is Pi's |
| Live streaming chat | **No via CLI** | In-process: `openChat` + `onProgress` (already used by Slack cards) | No out-of-process stream; ChatHandle lacks steer/abort/full events |
| Interrupt | **No** from another process | Pi `session.abort()` exists | Not on CLI or ChatHandle |
| Model picker | **Partial** | `ziggy models list/set`; Profile `models.json` | Mid-chat switch is TUI/Pi only; GUI cannot set the live session model |
| CRONJOBS | **Yes** | `automations/*.md` + list/pause/resume/status/runs/wake | No `--json`; edit = write the markdown file (which is the point) |
| TERMINAL pane | **Not Ziggy's job** | Hermes Desktop owns a PTY | Do not add a terminal protocol unless the agent must stream PTYs into the GUI |
| Agent-to-agent | **Yes, crude** | Spawn `ziggy run` / `agents run` | No inbox, no live notify on the other bot's UI without a protocol |
| Voice / HUD / artifacts | Chrome | — | Skip |

A **static** Electron/web admin (list profiles, edit SOUL, list crons, show session metadata, serve status) can ship against CLI + files now.

A **live** chat GUI cannot, unless it either (a) embeds Ziggy in-process like the gateways, or (b) gets a new out-of-process protocol.

## What "hooks" means — three different things

Do not conflate them.

1. **UI actions / session controls** — prompt, steer, abort, subscribe, resume, fork. This is what a GUI needs. Pi has them; Ziggy's public handle and CLI do not pass them through.
2. **Pi extension hooks** — `before_agent_start`, `tool_call`, session switch, etc. Already how Ziggy injects memory and TUI chrome. Useful for policy, not for drawing a chat.
3. **Grok Build lifecycle hooks** — `~/.grok/hooks/*.json` shell/HTTP on `PreToolUse` / `Stop`. Audit and safety. Ziggy has no equivalent; not required to render a UI.

The missing layer for "anyone can make a UI" is (1), published out of process.

## Ranked gaps

Must-have for a third-party live GUI:

1. **Session protocol** — prompt, stream text+tools+thinking, abort, steer/follow-up, settle. Candidates already in-tree: wrap Pi `runRpcMode` (NDJSON), or a Ziggy app server (selected in the pluggability study). ACP remains a conversation-only adapter. CLI `run` staying text-only is fine if this exists.
2. **Complete ChatHandle** — even in-process GUIs/TUIs need steer, abort, full events, resume/fork. Gateways already feel this; Slack progress is a hand-narrowed subset.
3. **One writer per JSONL** — already true across faces via session folders, and one `serve` via the owner lease. Do not give the TUI Slack’s folder. Attach is optional later for two local UIs on `local/main` only.

Should-have so CLI+filesystem stay a real UI substrate:

4. **`--json` (and optionally NDJSON) on management commands** — profiles, agents, automations, sessions metadata, serve status. TSV works; it will break. Hermes dashboard is JSON because they learned this.
5. **Resume by session id** — `run -c` is only latest local main. A session list GUI cannot reopen a row.
6. **Official transcript read path** — either document "parse JSONL, here is the schema" or add a projection that *can* emit messages (CLI today is transcript-free on purpose). Filesystem-as-API already allows the first option.
7. **Machine-readable profile identity** — name, description, optional icon path in the Profile folder so a BOTS rail does not scrape `SOUL.md`.

Nice-to-have, not core:

8. Inter-agent inbox / unread / presence files.
9. ACP adapter over the conversation subset (Grok Build / Hermes already have this; editors expect it).
10. Print-mode `json` / `streaming-json` on `ziggy run` for scripts that are not a full GUI.

Not missing for this goal:

- Automations CRUD (exists).
- Multi-profile isolation (exists).
- Named specialists (exists; Hermes uses whole profiles instead).
- A Ziggy-owned terminal multiplexer.
- Copying Hermes `state.db` or Grok Bot's cloud VM.

## Implication for Ziggy's idea

The idea is right for **state**: keep the assistant in visible files so a UI, a human, and the CLI share one authority. Ziggy is ahead of Hermes there.

The idea is wrong if it means **CLI stdout is the GUI protocol**. Neither Grok Build nor Hermes shipped that way for live chat. They added a second, streaming, bidirectional channel (ACP or HTTP/WS) that still reads/writes the same files.

Ziggy already has that channel **inside one process** (`ZiggyAgent.openChat`). Hermes Desktop talks JSON-RPC to `hermes serve`; Hermes Slack talks to a **separate** gateway process and only shares the DB. Ziggy should not copy that split. Widen `ChatHandle`, keep per-session queues on `serve`, and only then publish those calls. A custom GUI can live in-process like Slack does today, or later as a client of `serve`.
