# Extension compatibility decision

This decision supersedes the pre-port compatibility notes that previously lived here.

## Current contract

- `extensions/<id>/` is the repository ownership boundary for one Pi package.
- A package may declare skills, executable Pi extension entrypoints, or both in `package.json`.
- Ziggy passes Profile skills first, sorted package skill roots next, and top-level skills last so
  Profile collisions win.
- Executable package factories load at runtime startup. Agent Skill metadata loads at startup and
  complete bodies load on demand.
- Pi's normal tools, Ziggy's `memory_write`, and executable package tools are available through the
  same runtime construction used by TUI, print runs, gateway chats, and automations.
- Profile folders may own skills but do not load Profile-authored executable code.

## State boundary

Pi owns providers, the agent loop, sessions, compaction, branching, skill parsing, tool execution,
and the TUI. A package may keep rebuildable or package-local state only under
`<profile>/.runtime/<id>/`.

Human-owned Profile files retain their existing mutation boundaries:

- retained memory changes only through `memory_write`;
- Profile skills change only through the explicit skill-curation tools;
- Pi session JSONL remains authoritative and read-only to recall projections.

## Rejected compatibility machinery

Ziggy does not translate foreign manifests or host APIs. It has no extension registry, alias
layer, marketplace, approval database, remote fetcher, or second tool allowlist. A capability is
adapted as a native Pi package or it is not loaded.

## Proof

`src/adapters/pi/resources.test.ts` loads the complete catalog through both Ziggy's production
resource paths and Pi package manifests. It asserts package inventory, skill diagnostics,
registered tools, and the active Pi tool surface.
