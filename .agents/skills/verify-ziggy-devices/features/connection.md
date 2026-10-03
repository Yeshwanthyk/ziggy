# Connection

A paired device connects and stays connected; anything else is refused before it can say a word.

## Behaviors

- **C1** Paired device: handshake succeeds, `device.hello` is accepted, the device shows online in
  `devices list`.
- **C2** Unknown static key: refused during the handshake; nothing is written.
- **C3** Revoked device: its next connect is refused; a live connection is closed.
- **C4** Hub restart: the device reconnects within the backoff (1 → 15 s) without re-pairing.
- **C5** Silence: a device that misses pings for 60 s is marked offline.

## User entry points

- Harness fake; Pi; ESP32.

## Drive

Not built (S2, S3). Planned: `startDevice` paired, then a second fake with a fresh key; `devices
revoke` while connected; SIGINT and restart the resident with the device running.

## Proof

Fake frame transcripts; `serve.log` refusal lines; `devices list` output before and after;
`treeHash($PROFILE)` unchanged across a refused connect.

## Gotchas

- Two residents on one Profile is prevented by the owner lock; don't "test" reconnect by starting
  a second one.
