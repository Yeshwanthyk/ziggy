# Pi skills, extensions, and packages: semantics

Research basis: `/Users/yesh/Documents/personal/reference/pi-mono` at
`b6fb91e5b3a35a4361ae7d697d66eb7ed4dd9850` (verified 2026-07-28).

## Terms Pi actually uses

A **skill** is a self-contained Agent Skills-standard capability package: a
directory rooted by `SKILL.md`, with frontmatter, instructions, and arbitrary
helper scripts, references, and assets. Pi discovers its metadata at startup,
places only the name and description in the system prompt, and the agent reads
the full `SKILL.md` when the task calls for it. The source model is therefore
progressive disclosure, not a TypeScript module loaded into the process.

- Primary documentation: `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/docs/skills.md:3-7`,
  `:64-71`, `:92-105`.
- Implementation: `Skill` is a separate value with `filePath` and `baseDir` in
  `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/src/core/skills.ts:67-86`;
  `loadSkillsFromDir` detects a `SKILL.md` root and recursively discovers
  children in `:160-274`.

An **extension** is a TypeScript module whose default factory receives an
`ExtensionAPI`. Its factory registers event handlers, tools, commands,
shortcuts, flags, and/or renderers against Pi's live runtime. It is executable
program code with full host permissions, not a prompt/instruction resource.

- Primary documentation: `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/docs/extensions.md:3-17`,
  `:154-181`.
- Implementation: `ExtensionAPI` exposes lifecycle subscriptions at
  `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1185-1231`,
  tool and command registration at `:1237-1269`, and custom message/entry
  renderers at `:1271-1279`; the loader invokes `await factory(api)` at
  `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/src/core/extensions/loader.ts:469-473`.

A **Pi package** is a distribution and installation unit. It can bundle
extensions, skills, prompt templates, and themes together, declaring those
resource paths under `package.json`'s `pi` key or using conventional resource
directories. A package is thus neither synonymous with a skill nor with an
extension.

- Primary documentation: `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/docs/packages.md:3-6`,
  `:116-130`, `:156-165`.

## Load and execution timing

Pi scans skills at startup, extracts their metadata, and exposes the available
skills in the system prompt. It reads full skill instructions only when the
agent selects the skill (or the user invokes `/skill:name`). That is the sole
on-demand part of the skill mechanism; helper scripts are only run if the
loaded instructions direct the agent to run them.

Extensions are different: their TypeScript factories load and execute while Pi
builds the runtime. An async factory is awaited before startup proceeds, before
`session_start`, `resources_discover`, and queued provider registrations are
flushed. Factories should not start long-lived work; Pi directs extensions to
defer it to `session_start` or demand-driven handlers and clean it up in
`session_shutdown`.

- Skill timing: `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/docs/skills.md:64-71`.
- Extension factory and lifecycle timing:
  `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/docs/extensions.md:179-224`.
- Resource loader confirms that extensions are loaded first and skills are
  separately discovered from their paths:
  `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/src/core/resource-loader.ts:403-424`.

`/reload` (or `ctx.reload()`) tears down the current extension runtime, reloads
settings/resources, builds a new runtime, then emits `session_start` and
`resources_discover` with reason `"reload"`. It reloads extensions, skills,
prompts, themes, and context files; it does not change the fact that only the
full skill body is read on demand by the agent.

- Contract: `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/docs/extensions.md:1275-1299`.
- Runtime sequence: `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/src/core/agent-session.ts:2602-2624`.

Extensions may additionally contribute `skillPaths`, `promptPaths`, and
`themePaths` on `resources_discover`; this lets executable extension code
augment resource discovery, but does not turn the discovered skills into
extensions. `/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/docs/extensions.md:371-385`.

## Pi TypeScript extension APIs for TUI shaping

The public `ExtensionUIContext` supports the following TUI-facing surface:

- status/footer: `setStatus`, `setFooter`, and `setTitle`
  (`/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/src/core/extensions/types.ts:147-193`);
- header and widgets above/below the editor: `setHeader` and `setWidget`
  (`:169-190`);
- focused custom components and overlays: `custom(factory, { overlay,
overlayOptions, onHandle })` (`:195-210`);
- editor interaction and replacement: `pasteToEditor`, `setEditorText`,
  `getEditorText`, `editor`, autocomplete wrapping, and
  `setEditorComponent` (`:212-275`);
- visual state/theme: working-message/indicator controls, hidden-thinking
  label, read/set theme, and tool expansion (`:150-167`, `:265-281`);
- custom slash commands and keyboard shortcuts through `registerCommand` and
  `registerShortcut` (`:1243-1256`); and
- custom message and persisted-entry renderers through
  `registerMessageRenderer` and `registerEntryRenderer` (`:1271-1279`).

`ctx.ui.custom()` is the broad TUI component/keyboard-input escape hatch; Pi's
own extension guide explicitly describes it as the API for complex custom TUI
components (`/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/docs/extensions.md:9-16`).
Theme bundles themselves are a separate Pi resource type, as the package
convention list shows
(`/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/docs/packages.md:160-165`).

## Consequence for Ziggy vocabulary

A **Ziggy extension** is a Pi package. Approved bundled packages are declared by repository-root
`catalog.json`; Profile-owned packages live under `<profile>/extensions/<id>/` without becoming a
second public catalogue.
The package is the unifying capability boundary and may contain one or more
progressively loaded Agent Skills, executable Pi extension entrypoints, or both.

The two resource lifecycles remain distinct inside the package:

- skills contribute metadata at startup and bodies on demand;
- TypeScript factories execute at runtime startup and register tools, hooks,
  commands, providers, or UI behavior.

Ziggy should therefore not call a skill an extension or reserve Pi extensions
for the TUI. Pi is the executable extension host for every face. The hidden
TUI-shaping package is simply one internal extension whose handlers guard on
TUI mode.

This follows Pi's separate resource loader paths for extensions and skills
(`/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/src/core/resource-loader.ts:403-424`)
while using the Pi package manifest as their common ownership boundary.
