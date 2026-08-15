# Squarey Slack extension authoring (2026-08-14)

Primary sources: Squarey Slack JSONL, Ziggy resource loader, Pi 0.84.1
`system-prompt.js` / `skills.js` / `docs/extensions.md`, and the live compiled
`apple_reminders_*` failure.

The Slack thread is today's Apple Reminders thread
(`sessions/slack/group-slC0BP3A6SV89-thread-1786743438.848429`), not a Daily-app
authoring thread. Daily appears only as a globally installed Pi extension under
`~/.pi/agent/extensions/daily-note`, which Ziggy does not admit.

## What Squarey's core prompt actually is

Ziggy does **not** send Pi's default coding-assistant prompt. The Profile runtime
sets `resourceLoaderOptions.systemPrompt` to `SOUL.md`
(`src/adapters/pi/pi-agent.ts`). Pi treats an existing path as custom prompt text
and skips the default block that begins "You are an expert coding assistant
operating inside pi" and advertises `docs/extensions.md`
(`pi-coding-agent/dist/core/system-prompt.js`).

Squarey's prompt is therefore:

1. `SOUL.md` (identity).
2. Turn-only memory / Slack context appended by Ziggy extensions.
3. Tool snippets and `promptGuidelines` from registered tools, including `pi_docs`.
4. `<available_skills>` metadata only: name, description, location. Pi's skill
   formatter tells the model to `read` the skill file when the task matches
   (`pi-coding-agent/dist/core/skills.js`).
5. Current working directory = the Profile.

`extension-authoring` is a required core skill. It is **not** inlined into the
core prompt body. At the time of the thread its prompt metadata was only:

> Create or change a Profile-owned Pi extension package for Ziggy.

## Why the package was not created with extension-authoring

The selected catalogue package *was* loaded. Squarey called
`apple_reminders_create` 22 times. Every call failed with:

```text
osascript: /$bunfs/root/extensions/apple-reminders/scripts/reminders.applescript: No such file or directory
```

The factory imports the AppleScript with `{ type: "file" }`. In the compiled
`/Users/yesh/commands/ziggy` binary that path lives on Bun's virtual `$bunfs`.
The Ziggy process can `read` it; `/usr/bin/osascript` cannot. This is the same
compiled-embed rule already used for TUI themes (`src/adapters/pi/tui-themes.ts`).

After that failure, "Add that extension" / "make a new extension" did **not**
read `extension-authoring`. The transcript order is:

1. `pi_docs` × 12, including `docs/extensions.md` (placement for `/reload`:
   `~/.pi/agent/extensions/` or `.pi/extensions/`).
2. Writes to `.pi/extensions/` and `.pi/skills/`.
3. User: "why was it not added… you didn’t [use] extensions-authoring".
4. First successful `read` of `skills/extension-authoring/SKILL.md`.
5. Move to `extensions/apple-reminders/`.

Ziggy already disables ambient discovery (`noExtensions` / `noSkills`, admit
only selected Profile and bundled packages). `pi_docs` still served Pi's ambient
authoring docs, which describe paths this Profile cannot load.

`pi: command not found` in that same turn is Pi's bash tool (`bash -c`), which
does not source `~/.zshrc`. NVM/`pi` aliases (`pis`, `pideep`) exist only in the
interactive zshrc. Squarey did not need the `pi` CLI; it followed Pi docs anyway.

## Why it said Squarey had to reload

Pi `docs/extensions.md` says auto-discovered `.pi/extensions/` can be
hot-reloaded with `/reload`. Squarey copied that after writing `.pi/`.

For Ziggy that is false:

- `/reload` reuses the already-captured `additionalSkillPaths` /
  `extensionFactories` from Profile runtime construction
  (`discoverPiResources` runs once in `createProfileRuntime`).
- Ziggy TUI selection already says "Reopen this Profile to apply the change."
- `extension-authoring` already says reopen or restart the resident.
- A skill-only package's files can be followed immediately (Squarey did try the
  AppleScript without restart; Shared-list `osascript` then timed out on
  Automation permission). New *tools* and skill metadata in the prompt still
  need a new runtime.

The Profile-owned `extensions/apple-reminders/` package is skill-only. It
**shadows** the bundled factory: a Profile-owned ID is not in
`selectedBundledIds`, so `apple_reminders_*` tools stay unloaded until that
override is removed.

## Fixes in this block

- Materialize the compiled AppleScript to a host temp path before `osascript`.
- Tell `pi_docs` prompt guidelines that Ziggy does not load `~/.pi` / `.pi` and
  that `/reload` does not admit a new Ziggy package.
- Strengthen the `extension-authoring` skill description so it matches "add an
  extension" without waiting for the full skill body.

Not done here: rebuild/install `/Users/yesh/commands/ziggy`, remove Squarey's
Profile override, or restart the resident. Those are required before the
bundled tools work again in Slack.
