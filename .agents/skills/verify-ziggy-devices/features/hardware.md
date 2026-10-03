# Hardware

A real device on the desk — a Pi or an ESP32-S3-BOX-3 — pairs with the scratch Profile, chats,
and lends its commands.

## Behaviors

- **H1** Pi: `ziggy-device pair <code>` then `run` connects over the LAN (M1).
- **H2** BOX-3: flash, `devices pair --serial`, boots to "Connected to <Profile>" (S7).
- **H3** [Chat](chat.md) T1 and [tools](tools.md) K2 pass from the real device.
- **H4** Power-cycle the board: it reconnects without re-pairing.

## User entry points

- Pi over SSH; BOX-3 over USB serial and its own controls.

## Drive

Not built (S3 for Pi, S7 for BOX-3). The hub must listen on the LAN address for this run only;
reset `devices.json` to `127.0.0.1` afterwards.

## Proof

Serial monitor log or Pi stdout; a photo of the screen; resident `serve.log`; session `.jsonl`.

## Gotchas

- Only one person may drive a board at a time; it holds one connection.
- A board still paired to the real Profile will connect there, not to the scratch one. Check the
  host it prints at boot before driving.
