---
name: verify-ziggy
description: Launch, drive and prove Ziggy end to end — the `ziggy` CLI and a `ziggy serve` resident driven through the ui-sdk client or its web UI — against a scratch Profile and a scripted model. Use after changing Ziggy behaviour, before claiming a flow works, or when a proof in test/e2e fails.
---

# Verify Ziggy

Ziggy has two surfaces a user touches: the `ziggy` CLI (one process per command) and the
resident (`ziggy serve`), which web, ACP and chat clients talk to. Both run here against a
**scratch Profile** in a tmp `ZIGGY_HOME` whose model is a **scripted local server**
(`test/harness/provider.ts`). No real provider, key or Profile is ever touched.

Never point anything at `~/.ziggy` or a real Profile (e.g. `~/.ziggy/profiles/squarey`).
Never edit a Profile's `SOUL.md` except in a scratch home.

## Launch

Automated: `bun run test:e2e` launches everything itself (one model server, Profile and
resident per test) and cleans up.

By hand:

```bash
bun test/harness/sandbox.ts
```

Ready when it prints `ready`. It prints `export ZIGGY_HOME=…`, `SCRATCH_HOME=…`, `PROFILE=…`,
`MODEL_URL=…` and `REQUESTS=…`; set each in your shell. `SCRATCH_HOME` is the child `HOME`, so
nothing a command writes under `~` escapes the scratch dir. Every model call replies `ok` and is appended to `REQUESTS`. Stop with SIGINT.

For a resident, in another shell with `ZIGGY_HOME` exported:

```bash
HOME=$SCRATCH_HOME bun src/main.ts serve "$PROFILE"
```

Ready when `$PROFILE/.runtime/ui-server.json` exists; it holds `{version, port, token}`. The web
UI binds an ephemeral port unless `ziggy web configure` set one. Teardown: SIGINT; exit code 0
and `.runtime/gateway-owner.lock` gone.

## Doctor

Read-only, run before driving:

```bash
HOME=$SCRATCH_HOME bun src/main.ts doctor "$PROFILE"
```

Every line must be `OK`, `model` must say `harness/harness-model`, and `$PROFILE` must be under
the printed tmp `ZIGGY_HOME`. If any of those fail, stop: you are not driving a scratch Profile.

## Drive

- **CLI:** `test/harness/cli.ts` `ziggy(profile, ...args)` runs the real `bun src/main.ts` with
  `HOME` set to the scratch root and `ZIGGY_HOME` to the scratch home inside it, and returns `{exitCode, stdout, stderr}`.
- **Resident:** `test/harness/resident.ts` `startResident(profile)` spawns `serve`, reads the
  projection and returns `connect()`, which gives a `packages/ui-sdk` client (the web UI's own
  client) plus every event it saw. `stop()` sends SIGINT and returns the exit code.
- **Model:** `test/harness/provider.ts` scripts replies in order: `text(...)`, `tools(...)` for
  tool calls, `fail(status, message)`, and `held(first, rest, gate())` to hold a turn open
  mid-stream until `gate.release()`. `requests` and `rawRequests` record what the model was sent.
- **Web UI in a browser:** with a resident up, `bun src/main.ts web pair "$PROFILE"` prints a
  one-time URL; open it in the built-in browser. Treat the page as the user's surface.

## Evidence

A proof names the action, the observed result and the side effect:

- CLI: exit code, exact stdout/stderr.
- Model: `server.requests` (model id, messages, tool list) or `REQUESTS` by hand.
- Files: session `.jsonl` via `test/harness/transcript.ts`; `treeHash(home)` before/after
  proves a command changed nothing.
- Resident: ui-sdk events (`assistant-text`, `settled`, `session-state`, `automation-result`).

## Cleanup

Tests remove their tmp home in `afterEach`, and `stopResidents()` ends any resident a failed
proof left running. By hand: SIGINT the resident, then the sandbox; the
home is kept as evidence at the printed path. Remove it with `rm -rf "$SCRATCH_HOME"` only after
reading it. `pgrep -f "src/main.ts serve"` must print nothing you started.

## Features

[`features/README.md`](features/README.md) maps every user-facing flow to its recipe and to the
proof in `test/e2e/` that drives it.
