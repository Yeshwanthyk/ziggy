# Ziggy Profile resources

Pi's general extension and skill discovery rules are not Ziggy's resource policy. Ziggy
constructs the Pi runtime from a specific Profile and disables Pi's ambient discovery.

- `<profile>/extensions.json` is the active selection record for optional packages. Missing
  selection means no optional packages. Its IDs are shelf directory names, not necessarily the
  `name` fields in package manifests.
- `catalog.json` is Ziggy's approved bundled catalogue. An approved optional package must be
  selected to load; an unapproved ID is accepted only when it is installed as a Profile-owned
  package under `<profile>/extensions/<id>/`. A Profile-owned package with the same ID takes
  precedence. Ziggy copies bundled packages to the Profile shelf; it does not execute the
  repository source package or automatically load `~/.pi` or `.pi/extensions`.
- A selected package's manifest declares `pi.extensions` (executable Pi extension entrypoints)
  and/or `pi.skills` (skill files or directories). Selected skills load first. Required bundled
  packages `extension-authoring`, `pi-packages`, and `ziggy-operations` also contribute skills
  even without optional selection; they load from Ziggy's cache under `ZIGGY_HOME`, not the Profile. Skills are progressively loaded from their `SKILL.md`
  metadata; selection admits a skill, not an instruction to invoke it on every turn.
- Use the `profile_extensions` tool or `ziggy extensions add <profile> <id>` and
  `ziggy extensions remove <profile> <id>` to change selection. Use `ziggy extensions list` and
  `ziggy extensions show <id>` to inspect the approved catalogue. Reopen the Profile runtime or
  restart its resident (`ziggy serve restart <profile>`) for changed selection to take effect;
  an existing session does not hot-load new resources.

For Pi's package format and API see `docs/extensions.md` and `docs/skills.md` in this tool.
