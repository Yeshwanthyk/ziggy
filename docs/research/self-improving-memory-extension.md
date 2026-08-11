# Self-improvement extension

## Decision

Ziggy has one optional self-improvement package:

```text
extensions/self-improvement/
├── package.json
├── index.ts
├── automations/
│   └── curator.md
├── src/
│   └── manager.ts
└── skills/
    └── curator/
        └── SKILL.md
```

It replaces and removes these overlapping repository packages:

- `extensions/self-improving-agent`
- `extensions/smart-memory`
- `extensions/skill-curator`
- `extensions/skill-creator`

`extensions/lossless-claw` remains independent and optional. The repository-owned
`skills/extension-authoring/SKILL.md` remains the foreground authoring workflow.

The package improves only two Profile-local surfaces:

1. bounded entries in Ziggy's native scoped memory;
2. Profile-local Agent Skill packages created or explicitly managed by the package.

It must not generate or rewrite executable TypeScript extensions automatically. Executable code
changes remain an explicit foreground task using `extension-authoring`.

## Host boundary

Pi remains the extension host. Ziggy owns Profile selection, package precedence, automation
scheduling, native memory authority, and session lifecycle. The Profile's explicit
`extensions.json` selection admits the package; a Profile-owned package under
`<profile>/extensions/<id>/` takes precedence over a repository package with the same ID.

The package exposes three narrow operator tools:

- `self_improvement_status` — inspect bounded observation and review state;
- `self_improvement_log` — append a bounded, non-sensitive observation with a stable dedupe key;
- `self_improvement_extension_write` — create or atomically update a package owned by the
  self-improvement extension after the safety checks below.

The package does not create a second memory authority, package registry, or transcript store.

## Evidence and cadence

Pi session JSONL remains the authoritative evidence. The extension records only bounded,
non-sensitive observations and source pointers under:

```text
<profile>/.runtime/self-improvement/
├── state.json
├── curator-ready
└── logs/
    └── YYYY-MM-DD.md
```

Observation is cheap and local. It skips failed or interrupted work, automation sessions, specialist
children, empty sessions, and already-observed turns. Stable exact-dedupe keys prevent repeated
entries, and recurrence must be visible across distinct sessions before a pattern is promoted.
Raw transcripts, secrets, and complete tool output do not enter the log.

The Curator automation is installed from the package template at:

```text
<profile>/automations/self-improvement-curator.md
```

Its gate is a cheap file/state check. A scheduler scan without sufficient new evidence must not
call a model. The gate is armed only after enough new completed foreground evidence or an explicit
manual request. Automation runs are independent of foreground responses and never recursively
observe themselves.

## Review decisions

The bounded Curator review may:

- record a no-op when evidence is transient or insufficient;
- add a durable `[learned]` entry through Ziggy's existing native memory operation;
- improve a package previously created or explicitly adopted by this extension;
- create a focused skill-only package under `<profile>/extensions/<id>/` after recurrence and
  duplicate checks.

Memory replacement/removal and changes to human-owned skills remain staged or rejected. The
automatic path never writes `SOUL.md`, `AGENTS.md`, repository packages, bundled packages, or
arbitrary executable extension code.

Every managed package write must:

1. verify ownership and path containment;
2. read the current target and compare the expected previous content;
3. reject symlinks, traversal, collisions, and stale revisions;
4. write new packages in a temporary sibling and publish them atomically;
5. replace only the managed `SKILL.md` behind an expected-old SHA-256 fence.

A late review result is stale if newer Profile state exists and must not overwrite it.

## Extension lifecycle

`ziggy extensions add <profile> self-improvement` validates and selects the package. If the package
comes from an approved catalogue entry, Ziggy stages and validates it under the Profile before
changing `extensions.json`; installation must not mutate the Ziggy repository.

Adding the package provisions `self-improvement-curator.md` only when that file does not already exist. Existing
Profile automation definitions are never overwritten. `ziggy extensions remove` deselects the
package and pauses automation owned by it, while preserving the package, logs, memory, and other
Profile data.

Reopen the Profile or restart its resident process after changing selection. A fresh process is the
authoritative proof that the Profile package and its three tools load through Pi.

## Verification contract

The focused proof must show:

- the complete repository catalog contains `self-improvement` and none of the four retired IDs;
- the three self-improvement tools load without Pi diagnostics;
- a disposable Profile can select and load a Profile-owned package;
- an approved package install changes only the target Profile and selection;
- existing Profile automation and memory files remain byte-identical;
- `self-improvement-curator.md` validates and does not run when its gate is absent;
- removal pauses owned automation without deleting Profile data;
- `bun run check` and the focused resource/catalog tests pass.

Historical upstream comparisons informed the evidence, recurrence, ownership, and bounded-write
rules, but they are not runtime dependencies. This document describes Ziggy's selected local
mechanism, not a separate daemon, SQLite proposal ledger, web service, or catalogue service.
