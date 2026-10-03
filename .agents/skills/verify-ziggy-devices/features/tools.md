# Tools

The Profile can use the device: read its sensors, draw on its screen, run its commands.

## Behaviors

- **K1** A connected device's commands appear in the model's tool list as `device__<id>__<cmd>`.
- **K2** A model tool call reaches the device and the device's result returns to the model.
- **K3** Device offline → the call fails at once with a clear error; the turn continues.
- **K4** A specialist or automation without the tool in its allowlist cannot call it.
- **K5** Command list change (`tools/list_changed`) is reflected in the next session.

## User entry points

- Model-initiated tool calls from any face (web, Slack, CLI `run`, the device itself).

## Drive

Not built (S5). Planned: fake device with `echo` and `sensors.read`; script
`tools(device__<id>__echo {...})`; repeat with the device stopped; repeat from a specialist.

## Proof

`$REQUESTS` tool list; the device's received `tools/call` frame and its reply; the tool result in
the session `.jsonl`; K3's elapsed time well under the turn timeout.

## Gotchas

- Proving K2 from the web face does not prove it from CLI `run`, which has no resident hub; record
  which face you used.
