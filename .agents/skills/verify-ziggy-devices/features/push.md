# Push

Ziggy reaches out: an automation result, a reminder or a picture appears on the device without
the user asking.

## Behaviors

- **U1** Automation with target `device:<id>` delivers once to a connected device as `notify`.
- **U2** Target device offline → recorded as a delivery failure, not retried forever.
- **U3** `display.show {text}` from the `device_show` tool reaches the screen; a device without a
  screen fails the call. Images wait for S10.
- **U4** A device that chats is offered as a `device:<id>` destination in the web picker.

## User entry points

- An automation whose `broadcast:` lists `device:<id>`, run with `ziggy wake` or the web UI's
  Run button.
- The model's `device_show` tool, `{device, text}`, offered while the hub runs and a device is
  paired.
- The web automation editor's destination picker, **Devices** filter.

## Drive

Launch the sandbox with `--script replies.json` and the hub as in [SKILL.md](../SKILL.md):

```json
[{"text":"Coffee time."},
 {"tools":[{"name":"device_show","arguments":{"device":"box","text":"Timer: 5 min"}}]},
 {"tools":[{"name":"device_show","arguments":{"device":"speaker","text":"hello"}}]},
 {"text":"shown"}]
```

Pair two SDK devices, `box` and `speaker`, then run them; only `box` has a screen:

```bash
for d in box speaker; do
  URI=$(HOME=$SCRATCH_HOME bun src/main.ts devices pair "$PROFILE" | head -1)
  bun packages/device/bin/ziggy-device.ts pair "$URI" --state "$EVIDENCE/$d.json" --name "${(C)d}" --model test
done
mkfifo "$EVIDENCE/box.in"; (sleep 60 > "$EVIDENCE/box.in" &)
bun packages/device/bin/ziggy-device.ts run --state "$EVIDENCE/box.json" --screen 320x240 < "$EVIDENCE/box.in" > "$EVIDENCE/box.log" 2>&1 & BOX=$!
bun packages/device/bin/ziggy-device.ts run --state "$EVIDENCE/speaker.json" < /dev/null > "$EVIDENCE/speaker.log" 2>&1 & SPEAKER=$!
```

- **U1, U2:** write `$PROFILE/automations/coffee.md` with `broadcast: device:box,device:speaker,device:attic`
  and run `HOME=$SCRATCH_HOME bun src/main.ts wake "$PROFILE" coffee`. With the resident up, the
  wake runs in the resident, which holds the links.
- **U3:** `exec 3>"$EVIDENCE/box.in"; echo "show my timer" >&3`.
- **U4:** `bun src/main.ts web pair "$PROFILE"`, open the URL, open the automation, open the
  destination picker.

## Proof

- U1: `wake.out` says `wake delivered: device:box` and `device:speaker`; each log has
  `notify Harness Coffee time.`
- U2: `wake delivery failed: device:attic (destination-missing, not retriable)`, exit 1. Stop a
  device first for `(transport, retriable)`.
- U3: `box.log` has `display Timer: 5 min`; `$REQUESTS` holds `shown on box` and
  `speaker has no screen` as tool results.
- U4: a screenshot with the **Devices** filter, and the saved `device:box` target labelled
  `Device · Box`.

## Gotchas

- `ziggy wake` without a resident runs in the CLI process, which has no hub: every device target
  fails as offline (`transport`). Start the resident first.
- The web UI is embedded at build time. After changing the UI SDK or web client, run
  `bun run generate:web-assets` (builds `clients/web` first) and restart the resident; a stale
  bundle rejects a new destination kind and the sidebar says "Some sidebar data could not be
  refreshed".
- With `--port 0` a restarted resident gets a new hub port, and paired devices keep dialing the old
  one. Keep one resident for the whole drive, or configure a fixed port.
- Destinations are remembered per resident run: after a restart, a device appears in the picker
  only once it has chatted again.
