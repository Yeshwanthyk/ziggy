# Tools

The Profile can use the device: read its sensors, draw on its screen, run its commands.

## Behaviors

- **K1** A connected device's commands appear in the model's tool list as `device__<id>__<cmd>`.
- **K2** A model tool call reaches the device and the device's result returns to the model.
- **K3** Device offline → the call fails at once with a clear error; the turn continues.
- **K4** A specialist or automation without the tool in its allowlist cannot call it.
- **K5** Command list change (`tools/list_changed`) is reflected in the next session.

## User entry points

- Model-initiated tool calls in any session the resident opens: the device's own chat, the web
  UI, Slack or Discord. A foreground `ziggy run` has no hub, so it has no device tools.

## Drive

After Launch and [pairing](pairing.md). Start the sandbox with a script so the model calls the
tool: `bun test/harness/sandbox.ts --script "$EVIDENCE/script.json"`.

```bash
cat > "$EVIDENCE/script.json" <<'J'
[{"tools":[{"name":"device__kitchen__echo","arguments":{"text":"hello device"}}]},{"text":"the device said hello back"}]
J
cat > "$EVIDENCE/commands.ts" <<'J'
import type { ZiggyDevice } from "<repo>/packages/device/src/index";
export default (device: ZiggyDevice) =>
  device.command(
    "echo",
    { description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    ({ text }) => { console.log(`echo called with ${String(text)}`); return `echo: ${String(text)}`; },
  );
J
# … launch, configure, serve, then pair as in chat.md …
bun $D run --state "$EVIDENCE/device.json" --commands "$EVIDENCE/commands.ts" < "$EVIDENCE/stdin" > "$EVIDENCE/run.out" 2>&1 & RUN=$!
exec 3> "$EVIDENCE/stdin"
until grep -q "] online" "$EVIDENCE/run.out"; do sleep 0.2; done
until grep -q '"echo"' "$PROFILE/devices/kitchen.json"; do sleep 0.2; done   # the hub listed it
echo "use your echo" >&3                                                       # K1, K2
until grep -q "chat t1 done" "$EVIDENCE/run.out"; do sleep 0.2; done
exec 3>&-; kill -INT $RUN; wait $RUN
```

K3–K5 need a second device and an agent file: `bun test test/e2e/device-tools.test.ts` covers
K1–K5 with a scripted model.

## Proof

- `run.out` shows `chat t1 tool device__kitchen__echo` *before* `echo called with hello device`,
  then `chat t1 done …`.
- `$PROFILE/devices/kitchen.json` holds `tools: [{name: "echo", …}]`.
- `$REQUESTS`: the first request lists `device__kitchen__echo` with the description, and the
  second carries the tool result `echo: hello device`. The session `.jsonl` under
  `sessions/device/kitchen/` holds that result too.
- K3: the tool result says "`kitchen` is offline" well under the 30 s call limit.

## Gotchas

- Proving K2 from a device's chat proves the resident path. `ziggy run` never has device tools,
  so do not expect them there.
- A session keeps the tools it opened with. A command added later shows up in sessions opened
  after the hub re-lists it.
- Over-long names (`device__<id>__<cmd>` > 64 chars) are skipped with a warning in `serve.log`.
- In zsh, `echo ==` is a filename expansion error; label output with something else.
