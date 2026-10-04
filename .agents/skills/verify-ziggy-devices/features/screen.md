# Screen

What Ziggy shows on a small screen is readable: text wraps, images fit, views render at the
device's resolution.

## Behaviors

- **S1** A long reply wraps and pages on a 320×240 screen. The device lays text out itself, so
  this is proven on the board (S7).
- **S2** An MCP Apps view renders to an image at the reported resolution and is legible. Not
  built: it needs a headless browser hosting the view's bridge.
- **S3** An image larger than the screen is scaled, never cropped silently. A smaller one is
  centred, not enlarged.
- **S4** The image arrives in a format the device listed: `rgb565` if listed, else `jpeg`. A file
  that is not a PNG or JPEG, or lies outside the Profile, fails the tool call.

## User entry points

- The model's `device_show` tool with `image: "<path in the Profile>"`, from any session the
  resident opens.

## Drive

After Launch with `--script`, and [pairing](pairing.md) a device named Box:

```bash
cat > "$EVIDENCE/script.json" <<'J'
[{"tools":[{"name":"device_show","arguments":{"device":"box","image":"pictures/timer.png"}}]},{"tools":[{"name":"device_show","arguments":{"device":"box","image":"notes.txt"}}]},{"text":"on your screen"}]
J
# launch the sandbox with --script "$EVIDENCE/script.json", then:
mkdir -p "$PROFILE/pictures"
magick -size 640x360 gradient:'#1e3a8a-#0f766e' -gravity center -fill white -pointsize 96 \
  -annotate +0-20 'Timer 5:00' "$PROFILE/pictures/timer.png"                       # larger than 320×240
echo "not a picture" > "$PROFILE/notes.txt"
# configure, serve and pair as in chat.md with --name Box, then:
bun $D run --state "$EVIDENCE/device.json" --screen 320x240 --display-dir "$EVIDENCE/shown" \
  < "$EVIDENCE/stdin" > "$EVIDENCE/run.out" 2>&1 & RUN=$!
exec 3> "$EVIDENCE/stdin"
until grep -q "] online" "$EVIDENCE/run.out"; do sleep 0.2; done
echo "show my timer" >&3                                                            # S3, S4
until grep -q "saved" "$EVIDENCE/run.out"; do sleep 0.2; done
exec 3>&-; kill -INT $RUN; wait $RUN
```

Add `--formats jpeg` to drive the JPEG path; the saved file is then `display-1.jpg`.

## Proof

- `run.out`: `display image 320x240 rgb565 153600 bytes saved …/shown/display-1.png`.
- Open `shown/display-1.png`: the whole picture, black bands above and below, the text readable.
- `$REQUESTS`: the first tool result is `shown on box`, the second says
  `only PNG and JPEG images can be shown`.
- `bun test test/e2e/device-push.test.ts` (U5) covers rgb565 and jpeg devices and both refusals;
  `bun test test/devices/image.test.ts` checks decoding against Pillow, fitting and byte order.

## Gotchas

- The fake device proves bytes and dimensions. Legibility on glass needs the board (S7).
- `ziggy-device` converts rgb565 back to PNG only for looking at it; what the board receives is
  the raw frame.
