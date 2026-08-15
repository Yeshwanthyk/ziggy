# Shared chat handle (Bot Mode substrate)

Hermes Bot Mode is a GUI plugin. A bot is a profile folder. The GUI lists folders, chats live, and shows cron from disk. Ziggy already has the folders. It does not yet have one chat API that Slack and a GUI can both call.

This plan does not build that GUI. It makes Slack, TUI, and a later GUI the same kind of face.

Research: `docs/research/ui-cli-filesystem-hooks.md`.

## Terms

| Word | Meaning |
| --- | --- |
| **Bot** | One Ziggy Profile folder. Not `agents/<id>.md` (those are specialists inside one bot). |
| **Face** | Slack, Telegram, Discord, TUI, CLI, or a future GUI. All call the same chat API. |
| **ChatHandle** | In-process API for one live session: prompt, abort, steer, events, dispose. |
| **Session folder** | Where Pi writes JSONL for that chat. Example: `sessions/slack/<chatKey>/`. |

## Orientation

Keep the assistant in visible files. Keep live turns in one `serve` process. Serialize **per chat**, not globally. Other chats run in parallel.

Do not copy Hermes’ split: desktop (`hermes serve`) and Slack (`hermes gateway`) are two processes and can race on one session. Ziggy already has Slack inside `serve`. Keep that.

Do not let the GUI or TUI drive a Slack session. Local chat is `sessions/local/main/`. Slack is `sessions/slack/…`. They share `SOUL.md` and memory. They do not share a live turn.

`node:fs` in `pi-agent.ts` stays. Wrap it with `Effect.tryPromise`. That is the adapter pattern.

## Settled decisions

- One bot = one Profile. List bots from `~/.ziggy/profiles.list` and each `SOUL.md`.
- Cron stays `automations/<id>.md` plus `wake` / `serve`. No new cron store.
- Agent-to-agent stays `ziggy run <other-profile> "…"` (or `agents run`). No inbox file.
- Avatars, BOTS rail, terminal pane stay in the GUI. Not core.
- Widen `ChatHandle` before any socket. Slack is the first consumer.
- Queue lives on that chat in `serve` memory. Disk is the transcript, not the wait line.
- Busy policy on one chat: stop = abort; a new message may steer or wait. Default for Slack: keep today’s wait (semaphore) until abort works, then add steer.
- A later protocol sits on `serve` and calls the same handle. Do not start a Pi RPC process per face. Pi RPC does not create extra sessions; a second process would.
- TUI attach to `local/main` while `serve` is up is out of this packet.
- `--json` CLI, resume-by-id, and bot icon files are out of this packet.

## Scope

In:

- `ChatHandle` + `openChat` / `promptForAssistantText`
- Slack (then Discord, Telegram) using abort; then steer
- Tests for abort during an in-flight prompt

Out:

- Bot Mode GUI / Electron
- HTTP/WS or Pi RPC server (next packet)
- TUI attaching to channel sessions
- Changing session folder layout
- Effect `FileSystem` rewrite of `pi-agent.ts`
- Hermes `state.db`

## Target flow

```text
Face (Slack | later GUI)
  → openChat(profile, sessionFolder)     # once per chat
  → handle.prompt(text)                  # one turn
  → handle.abort()                       # stop
  → handle.steer(text)                   # nudge current turn (after abort exists)
  → events: text, tools, thinking, settled
  → JSONL appends in that session folder only

serve
  → one process, one ChatHandle map
  → Semaphore (or Pi queue) per chat
  → many chats in parallel
```

## Implementation chunks

### Slice 1 — Complete ChatHandle

**Delivers:** Faces can abort, steer, follow up, and subscribe without Slack-only callbacks.

**Where:** `src/application/agent.ts` (`ChatHandle`, `ChatProgressEvent`); `src/adapters/pi/pi-agent.ts` (`openChat`, `promptForAssistantText`). Pass through Pi `session.abort`, `steer`, `followUp`, `subscribe`. Keep today’s `onProgress` until Slack moves.

**Depends on:** nothing.

**Proof:** Unit or adapter test: start a prompt, abort, Pi stops. Steer while idle fails closed or no-ops in a typed way.

**Risk:** Exposing raw Pi events is too wide. Keep a small Ziggy event union: text, tool, thinking, settled, error.

### Slice 2 — Slack uses abort

**Delivers:** Slack `/stop` calls `handle.abort()`. No more “interrupt Effect and hope cleanup aborts.”

**Where:** `src/application/slack-gateway.ts`. Keep `Semaphore(1)` per `chatKey`. Keep `sessions/slack/<chatKey>/`.

**Depends on:** slice 1.

**Proof:** Existing Slack stop tests; add one that abort runs on the handle.

**Risk:** Double-abort if Effect cancel still calls abort. Make abort idempotent.

### Slice 3 — Slack steer (optional after 2)

**Delivers:** A new Slack message during a turn can steer instead of only waiting on the semaphore.

**Where:** same Slack file. Match Hermes busy modes only if we pick one default: **wait** (today) or **steer**. Do not add interrupt-as-default for Slack until we try steer.

**Depends on:** slice 2.

**Proof:** Second inbound while running hits `steer`, not a second `openChat`.

### Slice 4 — Discord and Telegram

**Delivers:** Same abort (and steer if slice 3 shipped) on the other channels.

**Where:** `src/application/discord-gateway.ts`, `src/application/gateway.ts`.

**Depends on:** slice 2 (and 3 if steer exists).

**Proof:** Same stop path as Slack.

### Later packet — publish from serve

Same methods on a socket so an out-of-process GUI can connect. Dialect open (Pi NDJSON RPC vs small Ziggy server). Not this packet.

## Verification

| Claim | How |
| --- | --- |
| Abort stops Pi | Adapter test + Slack stop |
| One chat still serial | Semaphore tests unchanged |
| Other chats still parallel | No global lock added |
| Local and Slack folders stay distinct | No path changes |
| One serve | Owner lease unchanged |

## Rollout

Ship slice 1+2 together. Restart Squarey `serve`. Slice 3 only after stop feels right. No Profile file migration.

## Risks

- Slack progress cards still need a mapper until they subscribe to the new events.
- Steer during tool execution follows Pi’s “after this tool” rule. Say that in the UI/status text.
- A future GUI in another process without the later packet will race if it opens its own runtime on a channel folder. Do not do that.

## Open decisions (do not block slice 1–2)

- Slack busy default after abort works: keep wait, or steer.
- Socket dialect for the later GUI packet.
- Whether we ever build the Bot Mode GUI ourselves.
