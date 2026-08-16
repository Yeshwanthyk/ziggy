---
name: pi-packages
description: Inspect catalogue packages and select catalogue or Profile-owned Pi extensions.
---

# Pi packages in Ziggy

The repository-root `catalog.json` is Ziggy's sole approved extension catalogue. Approved packages
are compiled into the Ziggy executable as file trees. The in-process `profile_extensions` tool
selects a package and records its ID in `extensions.json`; runtime loads only those Profile
folders. Profile-specific packages live under the same shelf.
Each package may contain an Agent Skill, executable Pi extension code, or both. `pi-packages`,
`extension-authoring`, and `ziggy-operations` are required and also sit on disk in the Profile;
all other packages are optional. A Profile-owned package takes precedence over an approved
catalogue package with the same ID.

The lowercase kebab-case folder and `extensions.json` key are Ziggy's shelf identity;
`package.json.name` remains independent upstream package metadata. For example, shelf ID `computer-use` can retain the
package name `@injaneity/pi-computer-use`.

Use the in-process `profile_extensions` tool for `list`, `add`, `remove`, and `validate` in the
owning Profile runtime. Never shell into `ziggy`, invoke a Ziggy CLI command, or edit
`extensions.json` directly. After authoring a Profile package, call `profile_extensions` with
`action: "add"` and its shelf ID. Claim success only from the tool's structured result; surface
operation, stage, code, and message when it fails. Adding validates the package, provisions owned
automations, and atomically records the selection. Removing pauses extension-owned automation,
then removes the selection without deleting the copied folder. Reopen the Profile or restart its
resident Ziggy process after a real selection change. Required packages cannot be added or
removed.

To create or change a Profile-owned package, read the `extension-authoring` skill and edit
`<profile>/extensions/<id>/`. Do not edit the Ziggy catalogue.

The retired `self-improving-agent`, `smart-memory`, `skill-curator`, and `skill-creator` packages
are replaced by the single optional `self-improvement` package.
