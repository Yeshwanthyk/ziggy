# Pi package catalog

## What shipped

Ziggy carries its capabilities as repository-owned Pi packages under `extensions/<id>/`.

- A package has `package.json` with a `pi` manifest.
- It may expose `skills`, an executable `index.ts`, or both.
- Skill support files live under the owning skill directory so relative references and
  `ziggy skills add` whole-tree copies agree.
- Pi loads Profile skills first, sorted package skill roots next, and top-level `skills/` last.
- Pi loads skill metadata at startup and full bodies on demand.
- Executable package factories load at runtime startup.
- Pi's normal tools, `memory_write`, and package tools are active in TUI, print, gateway, and
  automation runtimes. Ziggy does not maintain a second tool allowlist.
- The current catalog is 47 packages, 57 progressively loaded skills, 10 executable packages, and
  19 registered tools.
- `ziggy skills list <profile>` shows installed and available skills.
- `ziggy skills add <profile> <id|path> [--force]` copies one complete skill directory.

## Boundary we are keeping

Pi is the extension host. Ziggy has no second manifest, registry, alias layer, marketplace,
remote fetcher, or enablement database. Profile folders may override skills but do not load
Profile-authored executable code.

Packages are independent capability boundaries. Their own skills may name their own tools and
Ziggy core tools, but must not require tools or state owned by another optional package. Agents
compose available capabilities at runtime.

Ziggy passes extension entrypoints and skill roots separately to Pi so Profile skills retain first
collision precedence. Package manifests declare the same roots and are proven independently by
loading the complete catalog as package directories through Pi.

Repository extension code has full host permissions. Keep each package narrow, explicit, and
reviewed. Generated package state belongs under `<profile>/.runtime/<id>/`; durable Profile files
remain governed by their existing Ziggy boundaries.

## Proof

```sh
bun test src/application/profiles.test.ts
bun test src/adapters/pi/resources.test.ts
bun run check
bun test
```
