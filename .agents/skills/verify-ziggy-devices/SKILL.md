---
name: verify-ziggy-devices
description: Launch, drive and prove Ziggy Devices — a `ziggy serve` resident's device hub driven by the `@ziggy/device` harness fake, a Pi, or an ESP32 board over ZDP/1 — against a scratch Profile and a scripted model. Use after changing device pairing, the hub, device chat, device tools, push or voice, or before claiming a device flow works.
---

# Verify Ziggy Devices

Devices are the third surface after the CLI and the resident's web/ACP clients. A device opens a
WebSocket to the resident's **device hub**, runs a Noise_XX handshake with keys pinned at pairing,
and speaks ZDP/1 (JSON-RPC). The plan and slice gates are in
[`docs/plans/devices/README.md`](../../../docs/plans/devices/README.md).

Everything runs against the **scratch Profile** and **scripted model** of
[`verify-ziggy`](../verify-ziggy/SKILL.md). Never pair a device to `~/.ziggy` or a real Profile.
A real board must be re-paired to the scratch Profile, never the other way round.

Build status is per feature in [`features/README.md`](features/README.md). A feature marked
**not built** has no driver yet: record it as unreachable, do not improvise one.

## Launch

1. Sandbox (scripted model, scratch home). From the repo root:

   ```bash
   EVIDENCE=/tmp/ziggy-devices-proof/$(date +%Y%m%d-%H%M%S); mkdir -p "$EVIDENCE"
   bun test/harness/sandbox.ts > "$EVIDENCE/sandbox.out" 2>&1 & SANDBOX=$!
   until grep -q '^ready$' "$EVIDENCE/sandbox.out"; do sleep 0.25; done
   eval "$(grep -E '^(export |[A-Z_]+=)' "$EVIDENCE/sandbox.out" | sed -E 's/^([A-Z])/export \1/; s/^export export/export/')"
   ```

   This exports `ZIGGY_HOME`, `SCRATCH_HOME`, `PROFILE`, `MODEL_URL` and `REQUESTS`.

2. Hub config (only for features past `devices-off`):

   ```bash
   export ZIGGY_DEVICE_KEYSTORE=file   # a scratch HOME has no Keychain; never use the real one
   HOME=$SCRATCH_HOME bun src/main.ts devices configure "$PROFILE" --host 127.0.0.1 --port 0
   ```

   Use `127.0.0.1` for the harness fake. Use the machine's LAN address only for the `hardware`
   feature, and only while you are driving it.

3. Resident:

   ```bash
   HOME=$SCRATCH_HOME bun src/main.ts serve "$PROFILE" > "$EVIDENCE/serve.log" 2>&1 & RESIDENT=$!
   until [ -f "$PROFILE/.runtime/ui-server.json" ]; do sleep 0.25; done
   ```

   Ready when `ui-server.json` exists, and with `devices.json` also `.runtime/device-hub.json`
   (`{"version":1,"port":…,"online":[…]}`); `serve.log` says `[gateway] devices listening on …`.

Automated: `bun test test/e2e/devices.test.ts` does all of this per test with `startResident`
and `test/harness/device.ts`, and cleans up.

## Doctor

Read-only, before driving:

```bash
HOME=$SCRATCH_HOME bun src/main.ts doctor "$PROFILE"
```

Every line `OK`; `model` says `harness/harness-model`; `$PROFILE` is under the printed tmp
`ZIGGY_HOME`. Then confirm what the hub exposes:

```bash
lsof -nP -a -p "$RESIDENT" -iTCP -sTCP:LISTEN
```

Without `devices.json` there must be exactly one listener, on `127.0.0.1`. With it, one more on
the configured host. Anything on `*` or a LAN address you did not configure: stop.

## Drive

- **Harness device (default):** from a shell, `bun test/harness/device-cli.ts pair '<uri>'
  <key-file> [name] [--hold ms]` or `connect <port> <key-file> [--hold ms]`; it prints one JSON
  line per event (`handshake` with `pinned`, each reply, `received`, `closed` with the code). In
  tests, `connectDevice({port, keyPair})` from `test/harness/device.ts` gives `request`,
  `received`, `mute` and `closed`. It answers the hub's pings unless muted. It never reconnects;
  use it for protocol violations and exact frames.
- **SDK device:** `packages/device` (`@ziggy/device`). From a shell,
  `bun packages/device/bin/ziggy-device.ts pair '<uri>' --state <file> [--name …] [--model …]`,
  then `run --state <file> [--commands <module>]`; `run` logs `[ziggy-device] <state> (<close>)`
  and reconnects with backoff until revoked (4401), replaced (4409) or refused (4426). In tests,
  `new ZiggyDevice({…, timing, trace})`; `trace` sees every decrypted frame both ways.
- **Model:** `test/harness/provider.ts` scripts replies; use `tools(...)` to make the model call
  a `device__<id>__<cmd>` tool and `held(...)` to hold a turn for abort.
- **CLI:** `HOME=$SCRATCH_HOME bun src/main.ts devices pair|list|revoke|rename "$PROFILE" …`.
- **Pi (M1):** on the Pi, `ziggy-device pair '<uri>' --state device.json` then
  `ziggy-device run --state device.json --commands commands.ts`; the resident must listen on the
  LAN address for this run only. One identity runs in one process: a second connect replaces the
  first (4409).
- **ESP32 board (S7):** flash `devices/esp32` with `idf.py -p <port> flash monitor`, provision
  with `ziggy devices pair --serial <port> "$PROFILE"`, drive from the board's controls. The
  serial monitor is the device-side transcript.

## Evidence

Write everything under `$EVIDENCE`. A proof names the action, the observed result and the side
effect:

- Listener set: the `lsof` output.
- Device side: the harness frame transcript, or the serial monitor log for a board.
- Ziggy side: `serve.log`; the session `.jsonl` under `$PROFILE/sessions/device/<id>/`.
- Model side: `$REQUESTS` (does the tool list contain `device__…`? what did the turn send?).
- Registry: `$PROFILE/devices/<id>.json` before and after (pair, revoke, rename), read with `cat`.
- Hardware: a photo or screenshot of the screen for `screen` and `voice`.

## Cleanup

Only what this run started:

```bash
stop() { kill -INT "$1" 2>/dev/null; for _ in $(seq 1 60); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.25; done; echo "LEFT $1"; }
stop "$RESIDENT"; wait "$RESIDENT" 2>/dev/null; echo "resident exit=$?"   # expect 0
test ! -e "$PROFILE/.runtime/gateway-owner.lock" && echo "lock gone"
stop "$SANDBOX"; echo checked   # no LEFT line means nothing this run started is still running
```

Stop processes by the PIDs captured at launch, not with `pkill -f`/`pgrep -f` patterns: any
shell whose command line contains the pattern text (an agent's own heredoc, an editor) matches
too. Run launch and cleanup in the same shell, not inside a pipe or `{ … } | tee`: only then does
`wait` report the resident's exit code (otherwise it prints 127; the `stop` poll still holds).

Unpair a real board from the scratch Profile (`ziggy devices revoke`) before deleting the scratch
home, or it will keep retrying a dead host. Keep `$EVIDENCE`; remove `$SCRATCH_HOME` only after
reading it.

## Features

[`features/README.md`](features/README.md) maps each device flow to its recipe, its plan slice and
its build status.
