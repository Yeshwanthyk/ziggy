---
name: hyperframes
kind: tooling
version: 1
description: Configure an owner-selected project for deterministic HTML-to-video work with HyperFrames.
---

# HyperFrames Blueprint

Apply this guide as an inspectable edit to the owner's project. Don't execute this Markdown, add a
Ziggy runtime adapter, or retain a second copy of project state.

## Preconditions

1. Read the project's `AGENTS.md` and existing package scripts.
2. Confirm the owner-selected project root and output location.
3. Check that Node.js 22 or newer, FFmpeg, and a supported Chrome installation are available. Ask
   before installing or upgrading anything.

## Edit script

1. Merge these stable scripts into the project's `package.json`, preserving unrelated fields:

   ```json
   {
     "hyperframes:doctor": "npx --yes hyperframes doctor",
     "hyperframes:init": "npx --yes hyperframes init video --non-interactive",
     "hyperframes:lint": "npx --yes hyperframes lint",
     "hyperframes:preview": "npx --yes hyperframes preview",
     "hyperframes:render": "npx --yes hyperframes render --strict"
   }
   ```

2. Create or update `HYPERFRAMES.md`. Its first line must be the stable marker
   `<!-- ziggy-blueprint: hyperframes@1 -->`. Record the owner-selected composition directory,
   render output, and this workflow: doctor, init, author HTML, lint, preview, render.
3. Reapplying version 1 must update the marked section in place. Never duplicate the marker or
   overwrite owner content outside that section.

## Postconditions

- `package.json` remains valid JSON and contains the five exact scripts above.
- `HYPERFRAMES.md` contains exactly one `<!-- ziggy-blueprint: hyperframes@1 -->` marker.
- No process was launched merely by applying the Blueprint.
- No file outside the owner-approved project root changed.
- `npm run hyperframes:doctor` and later render commands run only after separate owner approval.
