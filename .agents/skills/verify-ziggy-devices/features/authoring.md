# Authoring

The Profile writes a device's commands: the `device-authoring` skill copies a template into
`device-kits/<id>/`, checks it with `smoke.ts`, and the device runs it with
`ziggy-device run --commands`.

## Behaviors

- **A1** The template copied into a Profile passes `bun smoke.ts <id>`: every command in `CALLS`
  prints `ok`, and the exit code is 0.
- **A2** `smoke.ts` prints `problem` and exits 1 for a command Ziggy would refuse: a bad name, a
  tool name over 64 characters, a duplicate, a missing description or a non-object schema.
- **A3** The same `commands.ts`, run by `ziggy-device run --commands`, lends its commands to the
  Profile, and the model calls them on the device.

## User entry points

- A session with the bundled `device-authoring` skill: "write commands for my kitchen Pi".
- By hand: `cp -R extensions/device-authoring/skills/device-authoring/template device-kits/<id>`.

## Drive

After Launch, with `--script` so the model calls the template's tools:

```bash
cat > "$EVIDENCE/script.json" <<'J'
[{"tools":[{"name":"device__demo__counter_add","arguments":{"amount":5}}]},{"tools":[{"name":"device__demo__counter_read","arguments":{}}]},{"text":"the counter is at 5"}]
J
# launch the sandbox with --script "$EVIDENCE/script.json", then:
mkdir -p "$PROFILE/device-kits"
cp -R extensions/device-authoring/skills/device-authoring/template "$PROFILE/device-kits/demo"
(cd "$PROFILE/device-kits/demo" && bun smoke.ts demo) > "$EVIDENCE/smoke.out" 2>&1   # A1
# configure, serve and pair as in chat.md with --name Demo, then:
bun $D run --state "$EVIDENCE/device.json" --commands "$PROFILE/device-kits/demo/commands.ts" \
  < "$EVIDENCE/stdin" > "$EVIDENCE/run.out" 2>&1 & RUN=$!
exec 3> "$EVIDENCE/stdin"
until grep -q '"counter_read"' "$PROFILE/devices/demo.json"; do sleep 0.2; done
echo "add five to the counter" >&3                                                  # A3
until grep -q "chat t1 done" "$EVIDENCE/run.out"; do sleep 0.2; done
exec 3>&-; kill -INT $RUN; wait $RUN
```

For A2, copy the template to a temporary folder and replace its `commands.ts` with bad commands:
a name `Light-Set`, a name defined twice, `inputSchema: {type: "array"}`, a 30-character name
under a 32-character id. Run `bun smoke.ts <id>` and save the output as `smoke-a2.out`.
`bun test test/extensions/device-authoring.test.ts` keeps the template's `rules.ts` in agreement
with `ZiggyDevice.command` and with the tools the Profile offers.

## Proof

- `smoke.out`: `ok device__demo__counter_add: the counter is 2`, `ok …counter_read…` and exit 0.
- `smoke-a2.out`: one `problem` line for each bad command (including `defined twice`), and exit 1.
- `run.out`: `chat t1 tool device__demo__counter_add`, then `…counter_read`, then `chat t1 done`.
- `$REQUESTS`: both tools are listed, and the tool results say `the counter is 5`. That is the
  device process's own count; smoke ran in a separate process.

## Gotchas

- `ZiggyDevice.command` replaces a command registered twice, so on the device a duplicate silently
  drops the first one. Only smoke reports it.
- The template imports only its own `device.ts` types, so it runs from a Profile with no
  `node_modules`. Keep `rules.ts` a copy, not an import of `@ziggy/device`.
- The device id in the tool name is the id that `ziggy devices pair` gave. A kit folder named
  differently still works, but its smoke reports the wrong tool names.
