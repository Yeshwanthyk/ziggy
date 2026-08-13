---
name: pi-packages
description: Inspect catalogue packages and select catalogue or Profile-owned Pi extensions.
---

# Pi packages in Ziggy

The repository-root `catalog.json` is Ziggy's sole approved extension catalogue. Approved packages
are compiled into the Ziggy executable; `extensions.json` selects IDs already in that binary.
Profile-specific packages live under `<profile>/extensions/<id>/`. Each package may contain an
Agent Skill, executable Pi extension code, or both. `pi-packages`, `extension-authoring`, and
`ziggy-operations` are required; all other packages are optional per Profile. A Profile-owned
package takes precedence over an approved bundled package with the same ID.

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

The CLI and TUI use the same lifecycle. Adding selects an ID already compiled into Ziggy, validates
it, provisions owned automations from embedded files, then atomically records the selection in
`<profile>/extensions.json`. It does not copy a bundled package into the Profile. Removing first
pauses extension-owned automation, then removes the selection without deleting Profile data. Reopen
the Profile or restart its resident Ziggy process after a real selection change. Required
`pi-packages` cannot be added or removed.

Profile-local skills still take precedence over required and selected package skills with the same
declared name. To create or change a Profile-owned package, read the `extension-authoring` skill and
edit `<profile>/extensions/<id>/`. Do not edit the Ziggy catalogue.

The retired `self-improving-agent`, `smart-memory`, `skill-curator`, and `skill-creator` packages
are replaced by the single optional `self-improvement` package.
