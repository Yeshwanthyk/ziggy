---
name: extension-authoring
description: Create or change a Profile-owned Pi extension package at extensions/<id>/. Read this before adding an extension. Ziggy does not load ~/.pi or .pi/extensions; new packages are admitted through profile_extensions.
---

# Ziggy extension authoring

Profile-owned extension packages live at `<profile>/extensions/<id>/` and use Pi's package contract
directly. The lowercase kebab-case folder name and matching `extensions.json` entry are Ziggy's
local shelf identity; `package.json.name` is independent upstream package metadata and may be scoped or unscoped. For
example, `<profile>/extensions/computer-use/` is selected as `"computer-use"` while its manifest
can retain `"name": "@injaneity/pi-computer-use"`.

A Ziggy Profile agent runs with the Profile as its working directory, so create the package at
`extensions/<id>/`. Never write generated or Profile-specific packages into Ziggy's repository
extension catalogue.
Keep each package self-contained and give it only the resources it needs.
Do not require tools owned by another package. Agents may compose capabilities that are present,
but each package must remain useful when every other optional package is absent.

## Package shape

```text
extensions/computer-use/
├── package.json
├── index.ts                 # only when the package registers executable Pi behavior
└── skills/
    └── computer-use/
        ├── SKILL.md
        └── scripts/         # optional skill-relative support files
```

Use this manifest for a skill-only package:

```json
{
  "name": "@injaneity/pi-computer-use",
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
only paths declared by `pi.extensions` and `pi.skills`. After writing an agent-authored package,
call the in-process `profile_extensions` tool with `action: "add"` for its shelf ID. Do not shell
into `ziggy`, invoke a Ziggy CLI command, or edit `extensions.json` directly. Claim
admission only from that tool's structured success result; preserve and report its operation,
stage, code, and message fields on failure. Profile-owned packages take precedence over approved
catalogue packages with the same ID. Reopening that Profile or restarting its resident Ziggy
process applies the change. All registered tools must be usable from TUI, print runs, gateway
chats, and automations when the package is selected.

## Third-party packages

To adopt a package from upstream, clone or download its source into an OS temporary directory
(never into the repository or Profile) and inspect `package.json` and its declared `pi` paths
there. Never run install or lifecycle scripts. Choose a lowercase kebab-case shelf ID
independent of `package.json.name`, then copy only the package source into
`<profile>/extensions/<id>/`, excluding `.git/`, `node_modules/`, and temp artifacts. The copy
alone leaves the package inactive: call the in-process `profile_extensions` tool with
`action: "add"` and the shelf ID, and report admission or failure from that tool's structured
result.

## Skills

Agent Skills remain progressive: frontmatter metadata is loaded at startup and the body is read
only when needed. Put scripts, references, templates, and assets inside the owning skill folder,
and reference them relative to `SKILL.md`. The package remains the unit passed to
`profile_extensions`, so those relative files stay next to the skill.

## Proof

For each change:

1. Verify the package manifest points only to files that exist.
2. Load the package from the Profile through Ziggy's Pi resource loader.
3. Exercise each registered tool against a disposable Profile.
4. Run focused tests, then `bun run check` and `bun test`.

Keep the implementation as one narrow end-to-end capability. Do not add speculative guards or
shared infrastructure for hypothetical packages.
