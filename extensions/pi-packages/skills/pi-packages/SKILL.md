---
name: pi-packages
description: Inspect catalogue packages and select catalogue or Profile-owned Pi extensions.
---

# Pi packages in Ziggy

The repository-root `catalog.json` is Ziggy's sole approved extension catalogue. Approved packages
are compiled into the Ziggy executable as file trees. `ziggy extensions add` copies the selected
package onto disk at `<profile>/extensions/<id>/`, then records the ID in `extensions.json`.
Runtime loads only those Profile folders. Profile-specific packages live under the same shelf.
Each package may contain an Agent Skill, executable Pi extension code, or both. `pi-packages`,
`extension-authoring`, and `ziggy-operations` are required and also sit on disk in the Profile;
all other packages are optional. A Profile-owned package takes precedence over an approved
catalogue package with the same ID.

The lowercase kebab-case folder and `extensions.json` key are Ziggy's shelf identity;
`package.json.name` remains independent upstream package metadata. For example, shelf ID `computer-use` can retain the
package name `@injaneity/pi-computer-use`.

Inspect the approved catalogue without executing package code:

```bash
ziggy extensions list
ziggy extensions show <id>
```

Inside the Ziggy TUI, use `/extensions` to open the complete optional-package checklist. Space
toggles any number of packages, Enter atomically saves the full set, and Escape cancels.

Select or unselect one optional package from the CLI:

```bash
ziggy extensions add <name|path> <id>
ziggy extensions remove <name|path> <id>
```

The CLI and TUI use the same lifecycle. Adding copies the package into
`<profile>/extensions/<id>/`, validates it, provisions owned automations, then atomically records
the selection in `<profile>/extensions.json`. Removing first pauses extension-owned automation,
then removes the selection without deleting the copied folder. Reopen the Profile or restart its
resident Ziggy process after a real selection change. Required packages cannot be added or
removed.

To create or change a Profile-owned package, read the `extension-authoring` skill and edit
`<profile>/extensions/<id>/`. Do not edit the Ziggy catalogue.

The retired `self-improving-agent`, `smart-memory`, `skill-curator`, and `skill-creator` packages
are replaced by the single optional `self-improvement` package.
