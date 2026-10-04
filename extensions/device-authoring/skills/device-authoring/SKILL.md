---
name: device-authoring
description: "Write or change the commands a Ziggy device lends this Profile (a Raspberry Pi or another computer running ziggy-device), kept at device-kits/<id>/. Use when the person describes a device and what it should do (read a sensor, switch a relay, run a script), or wants a paired device's commands changed."
---

# Ziggy device authoring

A device pairs with this Profile and lends it commands. Each command reaches the model as the
tool `device__<id>__<name>` while the device is online. The device runs
`ziggy-device run --state device.json --commands commands.ts`. Before it connects, that calls
the default export of `commands.ts` with the device, which adds its commands.

You write the commands module here, in the Profile, at `device-kits/<id>/`, and check it with
`smoke.ts`. The person copies the folder to the device. An ESP32 board's commands are built
into its firmware and are not written this way.

## Build one

1. Find the device id. For a paired device it is the `id` in `ziggy devices list "<profile>"`.
   For a new device, it is the name the person will pair it with, lowercased and joined with `-`
   (`Kitchen Pi` → `kitchen-pi`). `ziggy devices pair` gives the final id, so check it after
   pairing. If `device-kits/<id>/` exists, you are editing it: read it first and go to step 3.
2. Copy the template next to this file:
   `mkdir -p device-kits && cp -R <this skill's folder>/template device-kits/<id>`.
3. Write `commands.ts`. Ask about what you cannot know: pin numbers, wiring, which program or
   library drives the hardware, and what may change the world. Keep `device.ts` and `rules.ts` as
   they are.
4. In `smoke.ts`, list each command that is safe to run here in `CALLS` with real arguments. List
   in `ON_DEVICE` each command that needs the device's hardware or acts on the world: smoke never
   calls those.
5. `cd device-kits/<id> && bun smoke.ts <id>`. Fix every `problem` and `fail` before going on.
   Treat a `warning` as a command that went untested and say so.
6. Tell the person how to run it on the device: copy the folder
   (`scp -r device-kits/<id> <user>@<host>:`), pair once with
   `ziggy-device pair '<uri from ziggy devices pair>' --state device.json`, then run
   `ziggy-device run --state device.json --commands <id>/commands.ts`. `ziggy-device` is
   `packages/device` in Ziggy's source; it needs Bun on the device.
7. Report the tools the model will see (`device__<id>__<name>`), which ones smoke called, and
   which run only on the device. New or changed commands reach sessions opened after the device
   announces them. A running device announces them when it restarts with the new module.

## Commands

- Names match `[a-z0-9_]{1,48}`, and `device__<id>__<name>` must fit in 64 characters, or
  Ziggy skips the tool. Use a verb and a noun, `light_set` or `temperature_read`.
- The description is all the model knows. Say what the command does, its units, and what it
  changes.
- `inputSchema` is a JSON Schema object with `"type": "object"`. Mark the required properties.
  Check each argument's type in the handler anyway: the model can send anything.
- Return a short sentence of text. Return `{content: [...], isError: true}` or throw for a
  failure the model should see. Never return a secret.
- A command must answer within 30 seconds, or Ziggy fails the call. Start long work and return,
  and add a separate command that reports progress.
- Keep state in the module, or in files next to it on the device. The device restarts the module
  only when `ziggy-device run` restarts.
- For hardware, call the device's own tools with `Bun.spawn` (`gpioset`, `i2cget`,
  `libcamera-still`), or a library the person installs on the device. Never install anything on
  the device yourself; give the person the command.

## Safety

- A command that moves, heats, unlocks, buys or sends must say so in its description. Ask the
  person whether the model may call it unprompted. If not, leave it out and explain why.
- Never put a password, token or Wi-Fi key in `commands.ts`. Read it on the device from an
  environment variable the person sets there, and tell them the variable name.
