# S4 — Molding (Extensions)

Stage owner: the Extension platform and builtin Extension catalog. Depends on S1 for the
Session/Turn loop and S2 for daemon-owned installation and execution. Feeds S5 installed Skills and
Extensions. Gateways remain S6/S7 work.

## Goal

Finish Ziggy's minimal Extension system, then rebuild the accepted Merlin outcomes as standalone
Ziggy Extensions without importing Merlin's architecture. Core owns only primitive contracts and
runtime enforcement: manifest validation, installation, approval, sealing, discovery, supervised
execution, and Tool registration. Capability-specific guidance and behavior live in Extensions.

The closed Merlin inventory has one settled distribution:

- 39 standalone S4 builtin Extensions, all disposition `port`, all `planned`;
- five leaf Gateways, all `planned`—Slack and Discord are non-blocking S6 candidates, while iMessage,
  telephony, and WhatsApp remain S7;
- three drops, all `not-applicable`.

There are no merge dispositions, candidate Automation targets, core-Skill targets, Blueprint
targets, or candidate dependencies. No candidate gates another.

## Current checkpoint and mandatory transition

The repository already contains useful S4 runtime enforcement: manifest/version checks,
daemon-owned install/remove/enable flows, approval and seal recovery, Skill and approved Tool
loading, compiled dynamic import, and a generic supervised Command boundary.

It also contains superseded production and verification work: the HyperFrames Blueprint,
baked-in core skill-writing, curated scaffold behavior, two old reviews, and scenarios/tooling that
encode Blueprint/core-Skill targets. This planning correction intentionally does not edit or delete
those implementation files.

The first S4 implementation slice must make the architecture executable before any candidate port:

1. Remove Blueprint production support and the HyperFrames artifact. Do not replace it with another
   mechanism.
2. Remove baked-in core skill-writing and any curated scaffold behavior that bypasses standalone
   Extension delivery.
3. Update the migration/review schemas and `extension-integrity` tooling to accept and enforce only
   the settled 39/5/3 distribution and landed S4 `port` reviews.
4. Delete the stale `hyperframes.json` and `skill-creator.json` reviews and remove their
   Blueprint/core-Skill/scaffold scenarios, fixtures, registry entries, and manifest declarations.
5. Add deterministic transition coverage and restore focused tests plus `verify:s4` before a new
   candidate review or implementation lands.

Until that slice lands, the planning authorities and ledger are intentionally ahead of executable
S4 verification. Do not weaken or suppress a gate to hide the mismatch.

## Extension platform contract

Ziggy has three Extension execution modes:

- `skill-only`: declarative `SKILL.md` content; no callable Extension code;
- `supervised-command`: a Skill plus manifest-declared Commands executed by the daemon with fixed
  argv, closed argument mode, explicit cwd, timeout, bounded output, and approval;
- `define-tool`: the narrow approved in-process TypeScript Tool escape hatch.

The Merlin ports use only the first two modes. No inventory row justifies a `define-tool`.

An Extension is `skill-only` only when its complete accepted outcome is achievable from current
model context plus daemon-owned primitive Session Tools. If an outcome must observe or mutate the
filesystem, network, a CLI, an external application, or prior Session transcripts, that Extension
must declare its own supervised Command. A candidate cannot borrow or depend on another candidate's
Command. Independent implementation and review derive the smallest command declaration supported by
the preserved evidence; the planning ledger does not invent exact argv.

Installed Extensions live under `<profile>/extensions/<id>/`. The daemon owns programmatic
installation, enablement, removal, approvals, private executable snapshots, and Extension state.
Manifest and machine-owned state are versioned. Skill support files remain confined to their
declared roots and are inert unless invoked through an approved runtime boundary.

Install and every later load/spawn/import validate compatibility, canonical paths, link policy,
tree seals, approval identity, and exact declared authority. Version, content, argv, permission, or
execution-boundary changes require reinstall and reapproval. Extensions get no loop hooks,
Provider registration, Gateway adapters, direct Profile writes, or ability to install other
Extensions.

### Daemon-owned Extension authoring Tool

S4 adds one daemon-owned Session Tool with `inspect`, `create`, `update`, and `delete` operations.
Its create/update input is a complete bounded proposed Extension package—manifest plus file map—
never an arbitrary path or general filesystem authority. Create and update pass through the existing
strict install/lifecycle validation and atomically publish through the existing staged transaction.
Update and delete require the expected current tree digest.

Authority changes remain disabled or approval-required and can never self-approve. The Tool adds no
draft database, shadow registry, or second writable authority. Because a Session's Tool snapshot is
frozen, newly installed or enabled Tools become callable only in a subsequent Session.
`skill-creator` and `skill-curator` remain Skill-only guidance over this primitive; neither mutates
the Extension tree directly or owns a private installer. S4's `automation-creator` is analogous
guidance over S5's daemon-owned Automation CRUD.

## Bundled catalog and defaults

The bundled catalog supports deterministic incremental entries: each candidate wave adds the entry
for the candidate it lands. Only final S4 closure asserts all 39 rebuilt Merlin ports—including
`skill-creator`—plus `automation-creator`, for 40 entries total. Catalog membership does not imply enablement. A new
Profile enables exactly:

- `skill-creator`, a Skill-only rebuilt Merlin port that teaches creation of conformant Ziggy
  Extensions and Skills;
- `automation-creator`, an additional Skill-only S4 Extension outside the 47-row inventory that
  teaches chat-first Automation creation and editing through S5 daemon-owned mutation Tools.

At final closure the other 38 rebuilt Merlin ports are installed/available through the bundled
catalog but disabled by default. This keeps prompt and Tool surfaces bounded.
`automation-creator` teaches the S5 contract; it does not own Automation parsing, files, scheduling,
Run state, or Broadcast.

## Closed Merlin ledger

`docs/plans/s4-merlin-migration.json` is the planning authority for the exact audited corpus:
47 candidate IDs, 175 regular files, 17,631,635 bytes, and inventory digest
`e629623273623eb3672adbe0523a33d2bab275dcdabf8abe75cdd38a9921b791`.
Each row preserves source-relative evidence paths, byte counts, and SHA-256 digests. Verification
must not read `../merlin`.

A port preserves only the row's evidenced user outcome. It does not preserve Merlin manifests,
package identity beyond the settled standalone target ID, layout, setup machinery, scripts, state
model, dependencies, runtime hooks, or source. Every retained support file must be justified by the
independent review and reachable within a declared Skill root.

### 39 S4 Extensions

The five `skill-only` ports are:

```text
humanizer, self-improving-agent, skill-creator, skill-curator, smart-memory
```

The 34 `supervised-command` ports are:

```text
acp-router, agent-browser, apple-notes, apple-reminders, architecture-diagram,
codex, coding-agent, diffs, executor, gh-issues, github, github-issues,
github-pr-triage, gog, goplaces, here-now, linear, lossless-claw, mcporter,
nano-pdf, notion, obsidian, onepassword, open-computer-use, openai-whisper,
peekaboo, qmd, session-logs, summarize, things-mac, tmux, weather, web-search,
xurl
```

Each row has disposition `port`, target mechanism `extension`, target ID equal to candidate ID,
owner stage `s4`, trust tier `builtin`, its listed execution mode, and delivery status `planned`.
Overlap remains evidence for keeping boundaries lean; it never authorizes a merge.

`gh-issues` and `lossless-claw` are supervised-Command Extensions. Neither is an Automation and
neither owns scheduling. `skill-creator` is Skill-only and no longer a core Skill.

The five Skill-only outcomes stay deliberately narrow:

- `humanizer` transforms text in the current chat; arbitrary file input/output is excluded.
- `self-improving-agent` proposes from current Session context only; it cannot mine prior Sessions
  or mutate owner files.
- `skill-creator` creates through the daemon-owned Extension authoring Tool.
- `skill-curator` proposes, inspects, and replaces through that same Tool; it has no direct tree
  mutation or private installer.
- `smart-memory` reasons over the current Session's frozen Memory snapshot and uses the existing
  memory Tool; it cannot scan prior Sessions or reread live Memory.

### Five Gateway candidates

`discord` and `slack` remain planned with target mechanism `gateway` and owner stage `s6`. They may
develop in parallel with Telegram but are not required to tag v1. `imsg`, `telephony`, and `wacli`
remain planned for S7. Every candidate must be a dependency-free leaf Gateway package;
documentation-only or Blueprint fallbacks are invalid.

### Three drops

`blogwatcher`, `clawhub`, and `hyperframes` have disposition `drop`, null targets, and status
`not-applicable`. `blogwatcher` is not reassigned to S5. HyperFrames has no Blueprint replacement.

## Review and delivery status

`planned` means the target is accepted but no implementation, capability scenario, or budget review
is claimed. `landed` requires:

- a standalone implementation under the candidate's own Extension ID;
- deterministic capability and negative-boundary scenarios;
- one fresh independent review tied to the exact workspace inputs;
- no open S4 finding and no unreviewed dependency, permission, subprocess, support file, or
  persisted state.

Exactly one review exists for each landed S4 `port`; planned and dropped rows have none. Reviews
record the evidenced user outcome, execution mode, file/line/support budgets, dependencies,
permissions, subprocess argv, state paths, scenario IDs, and assertions for lowest authority, no
compatibility shim, and no inactive vendored material.

Increasing a reviewed budget or changing a sealed behavior invalidates the review. A candidate
cannot reuse another candidate's review, files, target ID, or delivery status even when their source
outcomes overlap.

## Implementation chunks

The transition slice is chunk 0 and must land first. Chunk 1 then lands shared catalog/bootstrap and
authoring-Tool contracts. After those shared platform contracts land, chunks 2–6 with disjoint
Extension, catalog-entry, review, and scenario files may run in parallel. No candidate gates
another.

### Chunk 0 — remove superseded architecture and align verification

Own the legacy Blueprint/core-Skill/scaffold production files plus S4 schemas, review derivation,
stale reviews, scenarios, registry, and manifests. End with the settled ledger passing
`extension-integrity` with zero landed candidate reviews.

### Chunk 1 — catalog/bootstrap policy and Extension authoring Tool

Add the bundled catalog contract, deterministic catalog discovery, and new-Profile default policy.
Add the bounded daemon-owned Extension authoring Tool and prove its inspect/create/update/delete,
strict validation, staged atomic publication, expected-tree-digest, approval, no-second-authority,
and frozen-current-Session contracts. Bootstrap proof uses only entries that exist at this point; it
must not assert that all 40 final packages already exist. This chunk owns shared catalog/default and
authoring-Tool wiring, not candidate content.

### Chunk 2 — authoring Extensions

Implement `skill-creator` and `automation-creator` as separate Skill-only Extensions. Review and
land `skill-creator` through its ledger row. Review `automation-creator` as an S4 deliverable outside
the Merlin ledger. Add each package's own catalog entry. Prove `skill-creator` uses the Extension
authoring Tool, `automation-creator` teaches the analogous S5 Automation CRUD contract, and neither
has direct writes or hidden runtime authority.

### Chunk 3 — remaining Skill-only ports

Implement and review:

```text
humanizer, self-improving-agent, skill-curator, smart-memory
```

`skill-creator` landed in chunk 2, completing the five Skill-only ledger ports.

### Chunk 4 — supervised-Command ports A

Implement and review:

```text
acp-router, agent-browser, apple-notes, apple-reminders, architecture-diagram,
codex, coding-agent, diffs, executor, gh-issues, github, github-issues
```

### Chunk 5 — supervised-Command ports B

Implement and review:

```text
github-pr-triage, gog, goplaces, here-now, linear, lossless-claw, mcporter,
nano-pdf, notion, obsidian, onepassword
```

### Chunk 6 — supervised-Command ports C

Implement and review:

```text
open-computer-use, openai-whisper, peekaboo, qmd, session-logs, summarize,
things-mac, tmux, weather, web-search, xurl
```

Each candidate owns its own Extension directory, catalog entry, scenario files, and review. Within
or across waves, candidate work may proceed in parallel when those files are disjoint. Shared
tooling changes belong in chunk 0 or 1, not opportunistically in a candidate port.

## Local verification order

For every implementation chunk:

1. Format the touched files and parse every changed JSON document.
2. Run the narrow unit/contract tests for the touched manifest, catalog, Extension, scenario, or
   verification code.
3. Run each new candidate's deterministic capability and negative-boundary scenarios directly.
4. Run `extension-integrity` through the S4 runner with a current independent findings file.
5. Run the cumulative `verify:s4`, then `verify:all`, with replayable evidence.
6. Run `bun run check` last.

Chunk 0 additionally asserts the exact 39/5/3 distribution, the 5/34 execution-mode split, the two
S6 and three S7 Gateway IDs, the three null targets, and an empty landed-review set. Chunk 1 asserts the
incremental catalog/bootstrap policy and Extension authoring Tool contracts. Candidate chunks assert
target ID equals candidate ID, add only their own catalog entries, and prohibit cross-candidate
production-file ownership. Only final S4 closure asserts 40 bundled entries and exactly two
default-enabled IDs.

## S4 acceptance criteria

- No Blueprint target, schema branch, production surface, scenario, active review, or runtime
  behavior remains. Historical and rejection text may record its removal. HyperFrames has no replacement.
- Core injects no skill-writing content. `skill-creator` and `automation-creator` are ordinary
  default-enabled Skill-only Extensions.
- The daemon exposes one bounded Extension authoring Tool with inspect/create/update/delete,
  expected-tree-digest concurrency, strict lifecycle validation, staged atomic publication,
  approval enforcement, no draft authority, and next-Session Tool availability.
- The ledger contains the exact preserved 47 IDs and corpus evidence with exactly 39 Extension,
  five Gateway, and three null targets.
- All 39 rebuilt Merlin ports are standalone `port` rows and land under their own IDs with fresh
  reviews. The five Gateway rows retain their S6/S7 ownership. All three drops remain
  `not-applicable`.
- At final closure the catalog contains all 39 rebuilt Merlin ports plus `automation-creator`; a new
  Profile enables only the two authoring Extensions.
- No Extension gains loop, Provider, Gateway, scheduler, Automation-file, Session, or Memory
  authority beyond existing primitive-mediated Tools.
- Every candidate scenario, review, and budget passes independently; no candidate gates or proves
  another.
- `verify:s4`, `verify:all`, and `bun run check` pass with current independent findings before S4
  is marked implemented.

## References

- `docs/research/extension-mechanisms.md` for the trust-boundary comparison.
- `docs/research/bun-compiled-plugin-loading.md` for the compiled dynamic-import proof.
- `docs/CONSTITUTION.md` for state and loop authority.
- `../merlin/extensions` only as the already-captured source evidence corpus; never as a spec or
  source tree to copy.

## Non-goals

- Blueprints, core capability Skills, candidate Automations, merged candidate packages, or
  candidate-specific core changes.
- Gateway implementation in S4.
- An Extension marketplace or remote registry.
- New runtime hooks, Provider registration, direct Profile mutation, or a broader Tool ABI justified
  only by a port.
- Copying Merlin source, manifests, layouts, scripts, assets, state, or compatibility behavior.
