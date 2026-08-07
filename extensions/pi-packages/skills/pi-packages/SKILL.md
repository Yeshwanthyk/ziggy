---
name: pi-packages
description: Inspect and select Ziggy's repository-owned Pi extension packages for a Profile.
---

# Pi packages in Ziggy

Repository capabilities live under `extensions/<id>/`. Each folder is a Pi package containing an
Agent Skill, executable Pi extension code, or both. `pi-packages` itself and the top-level
`extension-authoring` skill are required; all other packages are optional per Profile.

Inspect the offline shelf without executing package code:

```bash
ziggy extensions list
ziggy extensions show <id>
```

Select or unselect an optional package as one unit:

```bash
ziggy extensions add <name|path> <id>
ziggy extensions remove <name|path> <id>
```

These commands change only `<profile>/extensions.json`; they do not copy, install, delete, or load
package code. Reopen the Profile or restart its resident Ziggy process after a real selection
change. Required `pi-packages` cannot be added or removed.

Profile-local skills still take precedence over required and selected package skills with the same
declared name. To create or change a package, read the `extension-authoring` skill and edit its
folder under `extensions/`.
