# Connection

A paired device connects and stays connected; anything else is refused before it can say a word.

## Behaviors

- **C1** Paired device: handshake succeeds, `device.hello` is accepted, the device shows online in
  `devices list`.
- **C2** Unknown static key with no code open: closed `4401` right after the handshake; nothing is
  written.
- **C3** Revoked device: its next connect is refused; a live connection is closed.
- **C4** Hub restart: the device reconnects within the backoff (1 → 15 s) without re-pairing.
- **C5** Silence: the hub pings after 20 s idle; a device silent for 60 s is closed `4408` and
  marked offline.
- **C6** The same device connecting again closes the older link with `4409`; a hello with another
  `zdp` version gets `-32003` and close `4426`.

## User entry points

- Harness fake; Pi; ESP32.

## Drive

After [pairing](pairing.md) left `$EVIDENCE/kitchen.key` paired:

```bash
PORT=$(python3 -c "import json;print(json.load(open('$PROFILE/.runtime/device-hub.json'))['port'])")
bun test/harness/device-cli.ts connect "$PORT" "$EVIDENCE/kitchen.key" --hold 3000 \
  > "$EVIDENCE/device-reconnect.jsonl" & DEV=$!                        # C1
sleep 1.5; Z devices list "$PROFILE"                                   # C1: online since …
Z devices revoke "$PROFILE" kitchen; wait $DEV                         # C3: closed 4401 "revoked"
bun test/harness/device-cli.ts connect "$PORT" "$EVIDENCE/kitchen.key" # C3: closed 4401
bun test/harness/device-cli.ts connect "$PORT" "$EVIDENCE/fresh.key"   # C2: closed 4401
```

C4 needs a fixed port (configure `--port` with a free one, not `0`) and the SDK device, which
reconnects; the raw harness device does not:

```bash
D=packages/device/bin/ziggy-device.ts
bun $D pair "$URI" --state "$EVIDENCE/device.json" --name Kitchen --model pi-zero-2w
bun $D run --state "$EVIDENCE/device.json" > "$EVIDENCE/run.out" 2>&1 & RUN=$!
kill -INT $RESIDENT; wait $RESIDENT                                    # run.out: offline (1000 done)
# start the resident again as in Launch                                # run.out: connecting … online
Z devices revoke "$PROFILE" kitchen; wait $RUN                         # run.out: stopped (4401 revoked), exit 1
```

C5 and C6 run in `bun test test/e2e/devices.test.ts`: C5 against an in-process hub with
millisecond timings, since the real ones take a minute. `test/e2e/device-conformance.test.ts`
runs C1, C3, C4 and C6 through the SDK.

## Proof

The `*.jsonl` transcripts (`handshake`, replies, `closed` with code and reason); `serve.log`
`[devices] … online|offline|unpaired key|was revoked` lines; `devices list` before and after;
`.runtime/device-hub.json` gone after the resident stops.

## Gotchas

- Two residents on one Profile is prevented by the owner lock; don't "test" reconnect by starting
  a second one.
