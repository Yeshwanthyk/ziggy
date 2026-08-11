---
name: extension-authoring
description: Create or change a Profile-owned Pi extension package for Ziggy.
---

# Ziggy extension authoring

Profile-owned extension packages live at `<profile>/extensions/<id>/` and use Pi's package contract
directly. A Ziggy Profile agent runs with the Profile as its working directory, so create the package
at `extensions/<id>/`. Never write generated or Profile-specific packages into Ziggy's repository
extension catalogue.
Keep each package self-contained and give it only the resources it needs.
Do not require tools owned by another package. Agents may compose capabilities that are present,
but each package must remain useful when every other optional package is absent.

## Package shape

```text
extensions/example/
├── package.json
├── index.ts                 # only when the package registers executable Pi behavior
└── skills/
    └── example/
        ├── SKILL.md
        └── scripts/         # optional skill-relative support files
```

Use this manifest for a skill-only package:

```json
{
  "name": "@ziggy/example",
  "private": true,
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./skills"]
  }
}
```

When `index.ts` exists, add `"extensions": ["./index.ts"]` and these peer dependencies:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

## Executable extension

Export one Pi `ExtensionFactory` from `index.ts`. Register tools with `pi.registerTool`; use
TypeBox parameters and bounded text results. Resolve package files from `import.meta.url`, while
tool subprocesses run in the Profile cwd supplied by Pi.

Do not create a second manifest, registry, alias layer, installer, or tool allowlist. Ziggy admits
only paths declared by `pi.extensions` and `pi.skills`. From the Profile working directory, select
the package with `ziggy extensions add . example`; Profile-owned packages take precedence over
approved catalogue packages with the same ID. Reopening that Profile or restarting its resident
Ziggy process activates the change. All registered tools must be usable from TUI, print runs,
gateway chats, and automations when the package is selected.

## Skills

Agent Skills remain progressive: frontmatter metadata is loaded at startup and the body is read
only when needed. Put scripts, references, templates, and assets inside the owning skill folder,
and reference them relative to `SKILL.md`. This also keeps `ziggy skills add` copies complete.

## Proof

For each change:

1. Verify the package manifest points only to files that exist.
2. Load the package from the Profile through Ziggy's Pi resource loader.
3. Exercise each registered tool against a disposable Profile.
4. Run focused tests, then `bun run check` and `bun test`.

Keep the implementation as one narrow end-to-end capability. Do not add speculative guards or
shared infrastructure for hypothetical packages.
