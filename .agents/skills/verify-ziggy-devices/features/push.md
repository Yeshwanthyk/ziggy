# Push

Ziggy reaches out: an automation result, a reminder or a picture appears on the device without
the user asking.

## Behaviors

- **U1** Automation with target `device:<id>` delivers once to a connected device as `notify`.
- **U2** Target device offline → recorded as a delivery failure, not retried forever.
- **U3** `display.show {text|image}` from a tool call reaches the screen.

## User entry points

- `ziggy automations` with a `device:` target; model tool calls.

## Drive

Not built (S6).

## Proof

Fake frame transcript; automation run record; `serve.log` delivery line.

## Gotchas

- Use the automation `run now` path; waiting for cron makes the run flaky and slow.
