# Pairing

The user gets a one-time code from Ziggy, enters it on the device, and the device belongs to that
Profile.

## Behaviors

- **P1** `ziggy devices pair <profile>` prints a `zdp://` URI (host, port, code, hub key) and an
  expiry ten minutes out.
- **P2** The device checks the handshake proved the URI's `key`, then redeems the code with
  `device.pair`; the hub records the device's static public key and answers its id.
- **P3** The same code cannot be redeemed twice or after expiry: with another code open the hub
  answers `-32002` and closes `4401`; with none open it closes `4401` right after the handshake.
- **P4** `ziggy devices list` shows the device; `rename` changes its name; `revoke` removes it.
- **P5** The registry file holds no private key or secret.

## User entry points

- CLI URI pairing with the harness device (`test/harness/device-cli.ts pair`), later
  `ziggy-device pair <uri>` on a Pi (S3).
- `ziggy devices pair --serial <port>` for an ESP32 (see [hardware](hardware.md)).
- Web Bluetooth (S11) — not planned here yet.

## Drive

After Launch (with `devices.json` on `127.0.0.1`, port `0`):

```bash
Z() { HOME=$SCRATCH_HOME bun src/main.ts "$@"; }
Z devices pair "$PROFILE" > "$EVIDENCE/pair.out"                                  # P1
URI=$(head -1 "$EVIDENCE/pair.out")
bun test/harness/device-cli.ts pair "$URI" "$EVIDENCE/kitchen.key" Kitchen \
  > "$EVIDENCE/device-pair.jsonl"                                                 # P2: pinned:true, ids
bun test/harness/device-cli.ts pair "$URI" "$EVIDENCE/hall.key" Hall \
  > "$EVIDENCE/device-replay.jsonl"                                               # P3: closed 4401
cat "$PROFILE/devices/kitchen.json"; Z devices list "$PROFILE"                    # P4
Z devices rename "$PROFILE" kitchen "Kitchen Box"; Z devices revoke "$PROFILE" kitchen
grep -riE "private|code" "$PROFILE/devices" || echo "no secrets in registry"     # P5
```

The key file is the device's private key; reuse it to connect as the same device.

## Proof

CLI stdout (code redacted); the device's `handshake` line with `"pinned":true` and its
`device.pair` result; the replay's `closed` 4401; `$PROFILE/devices/<id>.json` before and after;
`.gateway/device-pairing.json` holds only hashes and is empty once spent; `serve.log`
`[devices] paired …` and `unpaired key …` lines.

## Gotchas

- A pairing code is a secret for its lifetime: redact it in saved stdout.
- Export `ZIGGY_DEVICE_KEYSTORE=file` in the driving shell. A scratch `HOME` has no Keychain, so
  on macOS `devices pair` would fail to create the hub key; the e2e harness sets it already.
- With `"port": 0` the URI's port is read from `.runtime/device-hub.json`, so `pair` needs the
  resident running; with host `0.0.0.0` the URI uses the first LAN IPv4.
