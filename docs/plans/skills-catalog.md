# Pi package catalog

## What shipped

The repository-root `catalog.json` is Ziggy's sole approved extension catalogue. Bundled package
payloads live under `extensions/<id>/`; that folder is storage, not a second discovery or approval
mechanism. Profile-owned packages live under `<profile>/extensions/<id>/` and take precedence over
an approved bundled package with the same ID.

- A package has `package.json` with a `pi` manifest.
- It may expose `skills`, an executable `index.ts`, or both.
- Skill support files live under the owning skill directory so relative references stay valid after
  `ziggy extensions add` copies the whole package onto the Profile.
- Runtime loads only `<profile>/extensions/<id>/` folders. Required `pi-packages`,
  `extension-authoring`, and `ziggy-operations` are copied there too. There is no repository-root
  `skills/` directory.
- Pi loads skill metadata at startup and full bodies on demand.
- Executable package entrypoints load from the copied Profile folders, not from compiled factories.
- Pi's normal tools, `memory_write`, and package tools are active in TUI, print, gateway, and
  automation runtimes. Ziggy does not maintain a second tool allowlist.
- The current catalog is 35 packages (3 required), 35 bundled skills, 10 executable packages, and
  25 registered tools. The self-improvement package owns bounded
  learning observations, native memory review, and Profile-local managed-skill writes; it replaces
  the retired standalone self-improving-agent, smart-memory, skill-curator, and skill-creator
  packages.
- There is no `ziggy skills add` or `ziggy skills list`. Extensions can be skill-only.

## Boundary we are keeping

Pi is the extension host. Ziggy has no second catalogue, package manifest, alias layer, or
enablement database. `catalog.json` approves distributable packages; the Profile's
`extensions.json` records which optional packages are active. A Profile-local package may also be
selected without becoming a public catalogue entry. Selected Profile-authored packages load from
the visible Profile folder before an approved bundled package with the same ID.

Packages are independent capability boundaries. Their own skills may name their own tools and
Ziggy core tools, but must not require tools or state owned by another optional package. Agents
compose available capabilities at runtime.

Ziggy passes extension entrypoints and skill roots separately to Pi. Package manifests declare the
same roots and are proven independently by copying the complete catalog onto a Profile and loading
those folders through Pi.

Extension code has full host permissions. Keep each package narrow, explicit, and reviewable.
Generated package code belongs under `<profile>/extensions/<id>/`; its runtime state belongs under
`<profile>/.runtime/<id>/`. Durable Profile files remain governed by their existing Ziggy boundaries.

## Proof

```sh
bun test test/application/profiles.test.ts
bun test test/adapters/pi/resources.test.ts
bun run check
bun test
```
