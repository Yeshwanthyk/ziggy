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

- SDK: `device.send(text)`, `device.abort()`, `device.on("chat", …)`.
- Pi shell: lines on `ziggy-device run`'s stdin; `/abort` stops the turn.
- ESP32 on-device input (S7).

## Drive

After Launch and [pairing](pairing.md) with the SDK CLI (`--port 0` is fine here):

```bash
D=packages/device/bin/ziggy-device.ts
URI=$(HOME=$SCRATCH_HOME bun src/main.ts devices pair "$PROFILE" | head -1)
bun $D pair "$URI" --state "$EVIDENCE/device.json" --name Kitchen --model pi-zero-2w
mkfifo "$EVIDENCE/stdin"
bun $D run --state "$EVIDENCE/device.json" < "$EVIDENCE/stdin" > "$EVIDENCE/run.out" 2>&1 & RUN=$!
exec 3> "$EVIDENCE/stdin"
until grep -q "] online" "$EVIDENCE/run.out"; do sleep 0.2; done
echo "hi from the shell" >&3                                            # T1
until grep -q "chat t1 done" "$EVIDENCE/run.out"; do sleep 0.2; done
echo "second message" >&3                                               # T2
until grep -q "chat t2 done" "$EVIDENCE/run.out"; do sleep 0.2; done
exec 3>&-; kill -INT $RUN; wait $RUN                                    # exit 0, stopped (1000)
ls "$PROFILE/sessions/device/kitchen/"                                  # T2: one .jsonl
```

The sandbox model answers `ok` to everything, so `held` and `fail` replies need the automated
run: `bun test test/e2e/device-chat.test.ts` covers T1–T5 with a scripted model.

## Proof

- `run.out`: `chat t1 thinking`, `chat t1 delta …`, `chat t1 done …`, then the same for `t2`.
- One `.jsonl` under `sessions/device/kitchen/`, holding both turns.
- `$REQUESTS`: two requests; the second carries both user messages, so the session continued.
- T3: the turn ends with `chat.error` "the turn was aborted" and never `chat.done`.
- T4: the busy send is refused `-32001` and its text never reaches the model.
- T5: `chat.error` "provider request failed"; provider detail stays in the resident's log.

## Gotchas

- The web UI can watch the same live session (`device/<id>`); watching is not proof the device
  received frames.
- A device that did not declare `chat` in hello gets `-32002` for `chat.send`.
- A refused send does not use up a turn id: the next accepted turn is still `t2`.
- `rm` may be aliased to `rm -I` in an interactive shell; clean the scratch home with
  `command rm -rf`.
