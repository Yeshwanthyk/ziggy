# Chat

The user types (or, later, says) something on the device and the Profile answers on the device,
in a conversation that belongs to that device.

## Behaviors

- **T1** `chat.send` → `chat.status` busy → `chat.delta`… → `chat.done` with the final text.
- **T2** The turn lands in `sessions/device/<id>/` and the next message continues it.
- **T3** Abort from the device stops the turn; the model request is cancelled.
- **T4** A second `chat.send` while busy gets a clear busy status, not a second turn.
- **T5** Model failure reaches the device as `chat.error`.

## User entry points

- Harness fake; Pi `ziggy-device chat`; ESP32 on-device input.

## Drive

Not built (S4). Planned: script `text("hello from ziggy")`, `device.chat("hi")`, then
`held(...)` + abort, then `fail(500, …)`.

## Proof

Frame transcript order; session `.jsonl`; `$REQUESTS` shows the user text exactly once per turn.

## Gotchas

- The web UI can watch the same live session; watching is not proof the device received frames.
