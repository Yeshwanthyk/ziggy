# S4 — Molding (Extensions)

Stage owner: extension system. Depends on S2 (Daemon) for the tool-call boundary and S1 (Waist) for the session/turn loop that invokes tools. Feeds S6 (Reach) an extension slot for the first gateway/executor integrations.

## Goal

Let a profile be extended without recompiling the ziggy binary or trusting arbitrary code by default. Two tiers, sharply separated: (1) a manifest+markdown tier that needs no code execution to install skills, pin defaults, and shell out to setup/doctor commands; (2) a single narrow in-process TypeScript tool-definition ABI, loaded via Bun dynamic `import()`, gated by explicit install-time user approval. Nothing else is extensible in v1 — no loop hooks, no provider registries, no gateway adapters from third-party code.

## Deliverables

- `<profile>/extensions/<id>/` directory convention and `extension.json` manifest schema (Zod/Effect Schema validator in `packages/core`).
- `SKILL.md` loader — Anthropic Agent Skills format, discovered from each installed extension's `skills/` subdirectory and exposed as ordinary skills to the agent loop.
- `defineTool` ABI: a minimal TS interface (name, description, input schema, `execute(input, ctx)`) that an extension's `tools/<id>/tool.ts` exports; loaded via `await import(absolutePath)` at daemon startup for approved extensions only.
- `ziggy extension install|enable|disable|list|doctor` CLI subcommands. These are attach-protocol Clients of daemon-mediated Extension commands; the CLI never writes Extension files or state directly.
- Trust-tier model: `builtin` (shipped in repo `extensions/`), `verified` (signed/known-provenance), `community` (unsigned, full approval friction) — manifest-parse-without-execute at install time, execution gated behind explicit approval.
- First real extension: **executor** (skill-runner CLI) implemented against this system, proving the manifest+CLI-setup tier end-to-end.
- `blueprints/` directory convention: markdown implementation guides an agent applies as an edit script against a profile or extension — not a maintained runtime adapter — for long-tail integrations.
- The skill-writing skill: a baked-in core skill that teaches the agent (and the user) how to author a conformant `SKILL.md`.
- Curated extension placeholders in repo `extensions/`: `smart-memory/`, `smart-extensions/` (scaffolding only in this stage; full behavior is out of scope, see Non-goals).

## Design (locked decisions)

**Why tiered, not one mechanism.** Research across five systems (`docs/research/extension-mechanisms.md`) showed every all-code system accumulates registry sprawl (hermes has three overlapping mechanisms) or heavy trust/scanning machinery (openclaw) to compensate for a wide default API surface. flue's insight — most "extensions" are content (skills) or build-time wiring (tools as plain objects), not runtime code — is adopted directly: default to zero code execution, and treat the one case that genuinely needs in-process code (custom tool logic beyond what a subprocess/CLI can express cleanly) as a narrow, explicitly-approved escape hatch rather than the default authoring path.

**Deliberate departure from the research recommendation.** Section C of `docs/research/extension-mechanisms.md` recommends subprocess-only executable tools. Ziggy deliberately permits the narrow in-process `defineTool` escape hatch because it has a single-user trust posture, requires install-time approval before loading code, has empirical proof that Bun dynamic imports work in compiled binaries (`docs/research/bun-compiled-plugin-loading.md`), and can point to pi's production use of in-process TypeScript Extension loading. This is an explicit trade-off, not an accidental drift from the report.

**Why the escape hatch is technically viable.** `docs/research/bun-compiled-plugin-loading.md` empirically confirms (Bun 1.3.13): absolute-path dynamic `import()` of a `.ts` file not present at compile time works inside a `bun build --compile` binary (including runtime TS transpilation), nested relative imports and `node:` builtins resolve, npm packages resolve from an adjacent `node_modules`, and `--bytecode` doesn't change any of this. So the compiled-binary constraint does not block loading trusted extension code from `<profile>/extensions/<id>/tools/`. This removed feasibility as a concern; the remaining design question was purely the trust boundary, resolved by requiring install-time approval before any `import()` of extension code runs.

**Manifest schema (`extension.json`)** — fields, per the research report's recommended layout:

```
schemaVersion, id, version, name, description,
ziggy: { requires: "<semver range>" },
defaults: { provider?, model?, thinkingLevel? },
skills: [{ id, path }],
tools: [{ id, path }],          // only present for tier-2 extensions
adapters: [],                    // reserved, core-only in v1 — see Non-goals
setup: { steps: [...], doctor: "<command>" },
requires: { env: [...], commands: [...], os: [...] },
permissions: { network: bool, filesystem: "none"|"profile"|"full", secrets: [...] },
distribution: { source, license },
provenance: { ... }               // signature/origin for verified tier
```

**Directory layout** (per extension):

```
extensions/<id>/
  extension.json
  skills/<id>/SKILL.md
  tools/<id>/tool.ts              # tier-2 only
  setup/{verify,doctor}
  state/                          # extension-private, still under profile — no second writer authority
  provenance.json
```

**Install flow.** `ziggy extension install <source>` copies/clones into `<profile>/extensions/<id>/`, parses (never executes) `extension.json`, runs `requires` checks, and if `tools[]` is non-empty, prompts for explicit approval before the daemon will ever `import()` that extension's tool file. Approval is recorded (so it isn't re-asked every daemon restart) but is per-extension-version — a version bump on a tier-2 extension re-triggers approval.

The install is a daemon-mediated explicit command: the CLI sends the request over the attach
protocol, and only the daemon writes the installed Extension files and daemon-owned Extension
state. `extension.json` and structured Extension state carry schema-version stamps; human-owned
`SKILL.md` and blueprint markdown do not.

**Doctor.** `setup.doctor` is a supervised subprocess (stdout/stderr captured into the install session log), run on `ziggy extension doctor <id>` and after install; non-zero exit surfaces as a failed install, not a silent partial state.

**Non-extensible in v1 (core-only):** loop hooks (`beforeToolCall`/`afterToolCall` equivalents), provider registration, gateway adapters. This is a deliberate scope cut — extend it only once a proven third-party need emerges, per the constitution's minimal-trusted-surface stance.

## Verification growth

Extend `tests/testkit` with isolated Extension fixtures, dynamic-import probes, approval records,
version controls, supervised-subprocess fakes, and filesystem fault injection. Register malformed
or incompatible manifests, path traversal, import-before-approval, version-bump reapproval,
failed/partial installs, doctor timeout/failure, blueprint postconditions, and concurrent install/
enable operations. Evidence includes parsed manifests, approval/import timelines, subprocess
results, Profile diffs, and compiled-binary loader smoke output. A separate Sol medium agent in an
independent run and context reviews trusted-code entry, daemon-only writes, schema stamps, path
confinement, and accidental new extensibility.

## Acceptance criteria

- A markdown-only extension (skill + setup steps, no `tools/`) installs, its `SKILL.md` is visible to the agent loop, and `ziggy extension doctor` runs its doctor command and reports pass/fail — with zero in-process code ever loaded.
- A tier-2 extension with a `tools/<id>/tool.ts` is refused execution until `ziggy extension install` records explicit approval; after approval, the daemon's dynamic `import()` loads it and the tool becomes callable in a turn.
- Re-running install on a version-bumped tier-2 extension re-prompts for approval; a same-version reinstall does not.
- `executor` extension installs and runs a skill-runner invocation end-to-end using only the manifest+CLI tier (no tier-2 code required for this one).
- A blueprint fixture Profile lives under the test fixtures. After an agent applies a `blueprints/` markdown guide to that fixture, a deterministic postcondition check proves the expected files and exact content changes, with no blueprint code executed directly.
- Manifest validation rejects an `extension.json` missing `ziggy.requires` or with an unsatisfiable range against the running daemon's version.
- The harness, S4 plan checklist, and scenario/stage manifests include every landed Extension behavior and negative/concurrency/fault scenario; `verify:s4` and `verify:all` pass with schema-valid redacted evidence and resolved findings from verification/review by a separate Sol medium agent in an independent run and context.

## References to consult

- `docs/research/extension-mechanisms.md` — full 5-system comparison (pi, openclaw, hermes, flue, eve); consult Section C for the subprocess-only recommendation that this plan deliberately departs from and for manifest concerns to evaluate independently.
- `docs/research/bun-compiled-plugin-loading.md` — empirical proof the dynamic-import escape hatch works in a compiled binary.
- pi-mono (local: `/Users/yesh/Documents/personal/reference/pi-mono`) — jiti-based TS extension loading (widest trusted surface; explicitly NOT the default here, but informs the tier-2 ABI shape).
- openclaw (opensrc: `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main`) — manifest/registry/security-scanning machinery and trust-tier precedent (builtin/verified/community adopted from here); also the separate markdown-skills mechanism this plan folds into tier 1.
- hermes-agent (opensrc: `/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main`) — cautionary example of registry sprawl from three overlapping mechanisms; also the trust-tier vocabulary.
- flue (opensrc: `/Users/yesh/.opensrc/repos/github.com/withastro/flue/main`) — blueprints-as-markdown pattern; tools-as-plain-objects (no general runtime loader) pattern behind the tier-1 default.
- Anthropic Agent Skills spec — for exact `SKILL.md` format compatibility (openclaw and hermes both read this format; ziggy should be byte-compatible).

## Suggested agent workflow

For each slice, follow the `docs/VERIFICATION.md` through-loop: dedicated Sol medium scouting/task-decomposition run and context → red scenario → separate Sol medium implementation run and context → independent Sol medium deterministic verification/evidence/review run and context. The implementing run must not be the verifying run.

1. Manifest schema + validator (`packages/core`), unit-tested against valid/invalid fixtures — implementation-shaped, delegate to codex sol/medium.
2. `SKILL.md` discovery/loader wired into the existing skill-injection point from S1 — small, mechanical.
3. `ziggy extension` CLI subcommands + daemon-side install/approval state persistence — implementation-shaped; test that the CLI performs no direct Profile writes.
4. Tier-2 `defineTool` ABI + dynamic-import loader with approval gate — higher-trust-boundary code; require a dedicated Sol medium scouting/task-decomposition run and context before implementation, then independent Sol medium verification/review in a third run and context, plus deterministic regressions for applicable findings, before merging.
5. Port `executor` as the first real extension; write its `SKILL.md` + `extension.json` by hand as the reference example other extension authors copy.
6. `smart-memory`/`smart-extensions` scaffolds — thin placeholders, defer real behavior.

## Non-goals

- Loop hooks, provider registration, or gateway adapters as third-party-extensible surfaces (core-only in v1).
- Extension marketplace/registry service — local filesystem + manual `install <source>` only.
- Sandboxing/process-isolation for tier-2 tool code beyond the approval gate (no seccomp/VM boundary in v1 — approval is the control, not runtime isolation; revisit if community-tier extensions become common).
- Full behavior for `smart-memory`/`smart-extensions` (scaffolding only; real logic is future work once there's a concrete driving use case).
