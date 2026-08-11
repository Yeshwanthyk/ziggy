# Pi package catalog

## What shipped

The repository-root `catalog.json` is Ziggy's sole approved extension catalogue. Bundled package
payloads live under `extensions/<id>/`; that folder is storage, not a second discovery or approval
mechanism. Profile-owned packages live under `<profile>/extensions/<id>/` and take precedence over
an approved bundled package with the same ID.

- A package has `package.json` with a `pi` manifest.
- It may expose `skills`, an executable `index.ts`, or both.
- Skill support files live under the owning skill directory so relative references and
  `ziggy skills add` whole-tree copies agree.
- Pi loads Profile skills first, sorted package skill roots next, and top-level `skills/` last.
- Pi loads skill metadata at startup and full bodies on demand.
- Executable package factories load at runtime startup.
- Pi's normal tools, `memory_write`, and package tools are active in TUI, print, gateway, and
  automation runtimes. Ziggy does not maintain a second tool allowlist.
- The current catalog is 33 packages, 34 progressively loaded skills, 10 executable packages, and
  25 registered tools. The self-improvement package owns bounded learning observations, native
  memory review, and Profile-local managed-skill writes; it replaces the retired standalone
  self-improving-agent, smart-memory, skill-curator, and skill-creator packages.
- `ziggy skills list <profile>` shows installed and available skills.
- `ziggy skills add <profile> <id|path> [--force]` copies one complete skill directory.

## Boundary we are keeping

Pi is the extension host. Ziggy has no second catalogue, package manifest, alias layer, or
enablement database. `catalog.json` approves distributable packages; the Profile's
`extensions.json` records which optional packages are active. A Profile-local package may also be
selected without becoming a public catalogue entry. Selected Profile-authored packages load from
the visible Profile folder before an approved bundled package with the same ID.

Packages are independent capability boundaries. Their own skills may name their own tools and
Ziggy core tools, but must not require tools or state owned by another optional package. Agents
compose available capabilities at runtime.

Ziggy passes extension entrypoints and skill roots separately to Pi so Profile skills retain first
collision precedence. Package manifests declare the same roots and are proven independently by
loading the complete catalog as package directories through Pi.

Extension code has full host permissions. Keep each package narrow, explicit, and reviewable.
Generated package code belongs under `<profile>/extensions/<id>/`; its runtime state belongs under
`<profile>/.runtime/<id>/`. Durable Profile files remain governed by their existing Ziggy boundaries.

## Proof

```sh
bun test src/application/profiles.test.ts
bun test src/adapters/pi/resources.test.ts
bun run check
bun test
```
