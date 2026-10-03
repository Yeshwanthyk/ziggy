# Ziggy Devices features

The verification index for device flows. Launch, doctor, drive, evidence and cleanup are in
[`../SKILL.md`](../SKILL.md); every recipe assumes a scratch Profile from the sandbox.

Status: **green** = proven end to end by the recipe; **not built** = the slice has not landed, so
the recipe is the slice's gate and the path is recorded as unreachable.

| Feature | Outcome the user sees | Slice | Status |
| --- | --- | --- | --- |
| [Devices off](devices-off.md) | With no `devices.json`, the resident opens nothing beyond loopback | R0 | green — 2026-10-03, `/tmp/ziggy-devices-proof/20261003-130607` |
| [Pairing](pairing.md) | `ziggy devices pair` gives a one-time code; the device redeems it once | S2 | green — 2026-10-03, `/tmp/ziggy-devices-proof/s2-20261003-134705` |
| [Connection](connection.md) | A paired device connects; an unknown or revoked one is refused | S2 | green — 2026-10-03, C1–C3, C5: `/tmp/ziggy-devices-proof/s2-20261003-134705`; C4: `/tmp/ziggy-devices-proof/s3-20261003-135654` |
| [Chat](chat.md) | A message from the device gets a streamed reply in that device's session | S4 | green — 2026-10-03, T1, T2: `/tmp/ziggy-devices-proof/s4-20261003-140448`; T1–T5: `bun test test/e2e/device-chat.test.ts` |
| [Tools](tools.md) | The Profile calls the device's commands; offline fails fast | S5 | green — 2026-10-03, K1, K2: `/tmp/ziggy-devices-proof/s5-20261003-141513`; K1–K5: `bun test test/e2e/device-tools.test.ts` |
| [Push](push.md) | An automation or tool shows something on the device unprompted | S6 | green — 2026-10-03, U1–U3: `/tmp/ziggy-devices-proof/s6-20261003-142144`; U1–U3: `bun test test/e2e/device-push.test.ts`; images wait for S10 |
| [Hardware](hardware.md) | A real BOX-3 or Pi pairs, chats and runs commands | S7 / M1 | not built |
| [Voice](voice.md) | Push-to-talk gets a transcript and a reply; later a spoken one | S8, S9 | not built |
| [Screen](screen.md) | A reply or view renders legibly on a small screen | S10 | not built |

Uncovered and not yet planned as features: BLE pairing and OTA (S11), `device-authoring` (S12),
mDNS discovery, remote access through a tunnel.

When a slice lands: write its harness driver, run the recipe, attach the evidence path in the
Status column, and add the automated proof to `test/e2e/devices.test.ts`.
