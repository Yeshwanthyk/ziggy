# S4 — Molding (Extensions)

Stage owner: Extension system. Depends on S2 (Daemon) for the tool-call boundary and S1 (Waist) for the Session/Turn loop that invokes Tools. Feeds S5 installed Skills and Extensions. No Merlin candidate is preselected for delivery; the closed migration ledger determines each disposition. Gateway implementations remain owned by S6/S7.

## Goal

Let a profile be extended without recompiling the ziggy binary or trusting arbitrary code by default. Three capability tiers are sharply separated: (1) declarative Skills, with no execution; (2) declarative Commands, exposed as Session Tools through an explicitly approved daemon-supervised subprocess boundary; (3) a narrow in-process TypeScript Tool-definition ABI, loaded via Bun dynamic `import()` behind explicit install-time approval. Nothing else is extensible in v1 — no loop hooks, no Provider registries, no Gateway adapters from third-party code.

Migrate useful capabilities from `../merlin/extensions` without migrating Merlin's architecture. Every Merlin Extension is reviewed; accepted behavior is rebuilt from scratch against Ziggy's Extension contract and the smallest applicable trust tier. The migration queue never changes Ziggy's manifest, ABI, state ownership, vocabulary, or stage boundaries to accommodate how Merlin happened to implement a capability.

## Deliverables

- `<profile>/extensions/<id>/` directory convention and `extension.json` manifest schema (Zod/Effect Schema validator in `packages/core`).
- `SKILL.md` loader — Anthropic Agent Skills format, discovered from each installed extension's `skills/` subdirectory and exposed as ordinary skills to the agent loop.
- Manifest-v2 `commands[]` boundary — fixed argv prefix, `none | append` argument mode,
  `extension | profile` cwd policy, bounded total argv and timeout, declared-only environment,
  bounded output, approved-byte execution snapshots, and daemon-owned process-tree cancellation
  with no shell, stdin, interpolation, or runtime PATH lookup.
- `defineTool` ABI: a minimal TS interface (name, description, input schema, `execute(input, ctx)`) that an extension's `tools/<id>/tool.ts` exports; loaded via `await import(absolutePath)` at daemon startup for approved extensions only.
- `ziggy extension install|enable|disable|list|doctor` CLI subcommands. These are attach-protocol Clients of daemon-mediated Extension commands; the CLI never writes Extension files or state directly.
- Trust-tier model: `builtin` (shipped in repo `extensions/`), `verified` (signed/known-provenance), `community` (unsigned, full approval friction) — manifest-parse-without-execute at install time, execution gated behind explicit approval.
- A checked-in, schema-v1, closed-world migration ledger at `docs/plans/s4-merlin-migration.json` for all 47 packages under `../merlin/extensions`: each receives an explicit `port`, `merge`, `blueprint`, `defer-to-S5`, `defer-to-S6/S7`, or `drop` disposition with capability, overlap, dependency, permission, state-authority, target mechanism, and leanness evidence. An Extension target additionally names its trust tier. No candidate remains silently unreviewed, and no candidate—including `executor`—has a privileged proof role or predetermined disposition.
- Accepted Merlin capabilities reimplemented against Ziggy's directory layout and manifest from scratch, in reviewable waves. Merlin source, manifests, bundled assets, CLI wrapper conventions, and runtime abstractions are evidence only and are never copied as the target structure.
- `blueprints/` directory convention: markdown implementation guides an agent applies as an edit script against a profile or extension — not a maintained runtime adapter — for long-tail integrations.
- The skill-writing skill: a baked-in core skill that teaches the agent (and the user) how to author a conformant `SKILL.md`.
- Curated extension placeholders in repo `extensions/`: `smart-memory/`, `smart-extensions/` (scaffolding only in this stage; full behavior is out of scope, see Non-goals).

## Current implementation checkpoint

- [x] Strict manifest/version contracts, root Ziggy version authority, sealed Skill loading, and
      the closed 47-row migration ledger with deterministic integrity gates.
- [x] Daemon-owned install, enable, disable, list, and doctor lifecycle with exact approvals,
      invalidation/recovery, attach-protocol Clients, and concurrency/fault scenarios.
- [x] Approved `defineTool` loading through private sealed snapshots with ABI, path, package-entry,
      mutation, TOCTOU, computed-import, and compiled post-build TypeScript regressions.
- [x] Generic supervised Command loading through explicit manifest-v2 declarations, exact approval,
      Session Tool/provider composition, no-shell execution, bounded input/output, PATH pinning,
      per-invocation seal/authority checks, private approved-byte snapshots, timeout, and
      process-tree cancellation.
- [x] HyperFrames Blueprint, baked-in skill-writing Skill, inert `smart-memory` and
      `smart-extensions` scaffolds, and independent landed reviews for `hyperframes` and
      `skill-creator`.
- [ ] Implement the remaining accepted S4-owned candidates in independently reviewed waves, then
      run integrated S4 closure. Of 33 currently planned S4 rows, 14 are `skill-only` and 19 are
      `supervised-command`.

The generic daemon-owned supervised Command boundary now exists. `executor` remains an ordinary
planned candidate and becomes the first command-based canary only after this boundary's independent
verification; it isn't disguised as `defineTool` and receives no candidate-specific privilege. The
other 18 command-based rows may follow in reviewed waves after the canary. The stage manifest stays
`pending` until every accepted S4-owned candidate and integrated closure gate lands.

## Design (locked decisions)

**Why tiered, not one mechanism.** Research across five systems (`docs/research/extension-mechanisms.md`) showed every all-code system accumulates registry sprawl (hermes has three overlapping mechanisms) or heavy trust/scanning machinery (openclaw) to compensate for a wide default API surface. flue's insight — most "extensions" are content (skills) or build-time wiring (tools as plain objects), not runtime code — is adopted directly: default to zero code execution, and treat the one case that genuinely needs in-process code (custom tool logic beyond what a subprocess/CLI can express cleanly) as a narrow, explicitly-approved escape hatch rather than the default authoring path.

**Deliberate departure from the research recommendation.** Section C of `docs/research/extension-mechanisms.md` recommends subprocess-only executable tools. Ziggy deliberately permits the narrow in-process `defineTool` escape hatch because it has a single-user trust posture, requires install-time approval before loading code, has empirical proof that Bun dynamic imports work in compiled binaries (`docs/research/bun-compiled-plugin-loading.md`), and can point to pi's production use of in-process TypeScript Extension loading. This is an explicit trade-off, not an accidental drift from the report.

**Why the escape hatch is technically viable.** `docs/research/bun-compiled-plugin-loading.md` empirically confirms (Bun 1.3.13): absolute-path dynamic `import()` of a `.ts` file not present at compile time works inside a `bun build --compile` binary (including runtime TS transpilation), nested relative imports and `node:` builtins resolve, npm packages resolve from an adjacent `node_modules`, and `--bytecode` doesn't change any of this. So the compiled-binary constraint does not block loading trusted extension code from `<profile>/extensions/<id>/tools/`. This removed feasibility as a concern; the remaining design question was purely the trust boundary, resolved by requiring install-time approval before any `import()` of extension code runs.

**Manifest schema (`extension.json`).** Schema v1 remains byte-contract compatible and cannot
declare Commands. Schema v2 is the strict union arm that adds a required `commands` array, which may
be empty. Neither version migrates automatically. Both contain only Extension-authored capability
declarations:

```
schemaVersion, id, version, name, description,
ziggy: { requires: "<strict semver range>" },
defaults?: { provider?, model?, thinkingLevel? },
skills: [{ id, path }],
commands: [{ id, description, argv, argumentMode: "none"|"append",
             cwd: "extension"|"profile", timeoutMs }], # v2 only, required
tools?: [{ id, path }],
adapters: [],
setup?: { steps: [{ argv: [...] }], doctor?: { argv: [...] } },
requires: { env: [...], commands: [...], os: [...] },
permissions: { network: bool, filesystem: "none"|"profile"|"full", secrets: [...] },
distribution: { source, license }
```

Unknown fields, duplicate JSON keys, unsupported schema versions, and any package provenance or
trust claim are invalid. `distribution.source` is informational and cannot establish trust.
Required arrays with set semantics are unique and canonically sorted. At least one Skill, Command,
or Tool is required; `tools`, when present, is non-empty. Skill IDs are unique; Command and Tool IDs
are disjoint because both enter the Session Tool namespace; `memory` is reserved. Skill and Tool
paths are exactly `skills/<id>` and `tools/<id>`. A Command executable is either a confined package
path or a bare name declared in `requires.commands`; `cwd: "profile"` requires Profile or full
filesystem permission. `defaults.model` requires `defaults.provider`; every
`permissions.secrets` entry appears in `requires.env`; and every external setup/doctor executable
appears in `requires.commands`. `adapters` is the required literal empty array. These are manifest
semantic rules; filesystem identity and executable resolution are checked again at installation and
every invocation boundary.

Command fixed and appended argv are bounded together at 64 entries and 16 KiB of aggregate UTF-8.
The manifest rejects a fixed prefix that already exceeds either limit; the generated Session Tool
advertises only the remaining append capacity and validates the combined argv again before spawn.

**SemVer and product-version contract.** Extension versions use canonical SemVer 2
`major.minor.patch[-prerelease][+build]`: ASCII identifiers only, no leading zero in a numeric core
or prerelease identifier, and build metadata ignored for precedence and equality. Ranges use only:

```
range      := clause { " || " clause }
clause     := comparator { " " comparator }
comparator := version | "=" version | ">" version | ">=" version | "<" version | "<=" version
```

Separators are the exact ASCII strings shown. Caret, tilde, wildcard, partial, hyphen, comma,
alternate-whitespace, and `v`-prefixed forms are rejected rather than interpreted. Numeric
identifiers compare without lossy number conversion. A prerelease running Ziggy satisfies a clause
only when that clause contains a prerelease comparator with the same major/minor/patch base. The
root `package.json.version` is the sole Ziggy product-version authority and is statically embedded
for CLI output, protocol advertisements, compatibility checks, and compiled smoke; workspace
versions mirror it. Compatibility APIs receive the running Ziggy version explicitly. Runtime code
never uses `Bun.version` as the product version or reads package files from a compiled executable.
Schema decoding validates grammar only. The explicit `isZiggyVersionCompatible` API receives the
running Ziggy version and evaluates compatibility. The daemon-mediated install boundary and every
enable, Skill load, Tool import, or subprocess boundary reject incompatibility before execution.
Provider-runtime composition now passes the root Ziggy version into the sealed installed-Skill,
Command, and Tool loaders. Install, enable, Skill load, Command invocation, Tool import, and
subprocess boundaries all reject an incompatible Extension before reading or executing its
capability content.

**Immutable package and daemon-owned Extension authority:**

```
extensions/<id>/
  extension.json
  skills/<id>/
    SKILL.md
    references/                    # optional, reviewed prose/data only
    scripts/                       # optional and inert by existence
    assets/                        # optional, reviewed and referenced only
  <declared-command-executable>   # manifest-v2 Command, optional
  tools/<id>/tool.ts              # in-process escape hatch only
  setup/{verify,doctor}
.runtime/extensions/<id>/
  provenance.json                 # sole installed-origin/trust/seal authority
  state/                          # sole mutable Extension subtree
```

The immutable package contains no `provenance.json`, trust claim, mutable state, or second seal
catalog. The daemon writes `.runtime/extensions/<id>/provenance.json` with schema-v1 fields
`schemaVersion`, `extensionId`, `extensionVersion`, `source:{kind,locator}`, `trustTier`,
`verification:{method,keyId,signature}`, sorted `files:[{path,kind,bytes,sha256}]`, and `treeDigest`.
`builtin` requires a release-owned `(id, version, treeDigest)` catalog match; `verified` requires a
valid Ed25519 signature from a Ziggy-trusted key over
`UTF8("ziggy-extension-provenance-v1\\0" + id + "\\0" + version + "\\0" + treeDigest)`; all other
valid unsigned installs are `community`. A supplied invalid signature rejects installation rather
than downgrading trust.

The file catalog seals `extension.json`, every retained Skill/support file, every Command
executable, every Tool/setup file, and declared Tool dependencies. Each digest is raw SHA-256 with
its byte length. Records sort by
UTF-8 path bytes; one SHA-256 stream hashes `UTF8("ziggy-extension-tree-v1\\0")` followed for each
record by `u32be(pathLength) || path || u32be(kindLength) || kind || u64be(bytes) || rawDigest`.
The provenance record and mutable state are excluded. Installation validates a quarantine copy and
atomically activates the immutable snapshot. Every Skill read, Tool import, and subprocess spawn
rechecks canonical confinement/link identity and recomputes this seal.

Mutable state exists only below `.runtime/extensions/<id>/state/`. It is daemon-owned, excluded
from support traversal, module/executable resolution, seals, and provenance inputs, and writable
only through an approved daemon capability. Structured state is schema-stamped and fails loud on
mismatch; reinstall preserves it and never repairs or rewrites it automatically. Approval
fingerprints bind Extension ID/version, exact Tool or argv entry, permissions, executable path and
digest, trust tier, and tree digest. Command fingerprints additionally bind the fixed argv prefix,
argument mode, cwd policy, and timeout. Any bound change invalidates the affected approval, and a
detected immutable mutation starts a new approval epoch even if the old bytes are restored.
Relative executables resolve only within immutable package content; bare commands resolve once at
approval through a controlled `PATH`, recording real path and digest, with no runtime `PATH`
lookup, shell parsing, alias following, or state resolution. Immediately before each invocation,
the daemon reads the approved executable through one open file identity, rechecks its digest, writes
those exact bytes to a mode-0700 private execution snapshot, and spawns only that snapshot. Direct
mutation of the installed or external path after inspection cannot change the executed bytes.

Each declared Skill is exactly `skills/<id>`, with an immediate regular `SKILL.md`; manifest ID,
root basename, and Agent Skills frontmatter `name` match. A Skill root may otherwise contain only
`references/`, `scripts/`, and `assets/`. Reachability scans only Markdown-body inline links and
images of the exact forms `[label](destination)` and `![label](destination)`, with one destination
and no title. YAML frontmatter, fenced/inline code, HTML, autolinks, reference-style links, prose
mentions, and unsupported Markdown do not establish reachability. External scheme/authority links
are ignored and never fetched.

A local destination is a relative POSIX path with no query, fragment, empty/repeated/`.`/`..`
component, backslash, NUL, absolute/drive prefix, malformed percent escape, or percent-decoded
separator/escape component. It is decoded once as valid UTF-8/NFC and must remain in the same Skill
root. Targets are regular files, never directories. Reached Markdown recurses; other files are
leaves. Deterministic DFS rejects self/mutual cycles. Every support file must be reachable from
`SKILL.md` and match the independent review allowlist by normalized path, kind, bytes, and SHA-256.
Cross-Skill links, dangling/orphan files, unknown top-level roots, symlinks, hardlinks, and
case/NFC collisions fail closed. Reachability never grants execution authority.

**Install flow.** `ziggy extension install <source>` currently accepts a local Extension directory,
copies it into quarantine, parses (never executes) `extension.json`, runs non-executable `requires`
checks, and atomically publishes the sealed snapshot. Any in-process Tool, callable Command, or
executable setup/doctor entry prompts for explicit approval before import or spawn. Command
approval records the fixed structured argv prefix, argument mode, cwd policy, timeout,
executable/support-file digests, declared permissions, and Extension version; shell command strings
are invalid. Approval is recorded so it is not re-asked every daemon restart, but any version bump,
bound Command setting, argv/permission change, or installed-tree digest change re-triggers approval.

The install is a daemon-mediated explicit command: the CLI sends the request over the attach
protocol, and only the daemon writes the installed Extension files and daemon-owned Extension
state. `extension.json` and structured Extension state carry schema-version stamps; human-owned
`SKILL.md` and blueprint markdown do not.

**Doctor.** `setup.doctor` is an optional structured argv, never a shell string. It is a distinct
post-install `extension/doctor` operation and runs as a supervised subprocess only after the exact
executable content, argv, permissions, digest, and Extension version are approved. Bounded
stdout/stderr returns over the daemon response; non-zero and timeout outcomes are explicit failed
doctor results. No Session-log persistence is claimed, and install never auto-runs doctor.

**Merlin capability migration, never framework migration.** `../merlin/extensions` is a bounded evidence corpus of 47 capability packages. A port preserves only a proven user outcome. It does not preserve Merlin's manifest fields, `clis/`/`files/`/`bin/` conventions, setup machinery, state model, package boundaries, or runtime assumptions. References, scripts, and assets receive the same treatment as code: each retained file must serve the accepted capability, be re-authored or reduced for Ziggy, live beneath the `skills[].path` declared by Ziggy's manifest, and be reachable from that Skill without path escape or a dangling link. Installer validation rejects support files outside declared Skill roots and orphan support material. Installation seals the canonical Extension tree with content digests; every Skill load, Tool import, and subprocess execution revalidates canonical confinement, link policy, and the seal. Post-install replacement or aliasing fails closed until explicit reinstall and reapproval. A bundled script gains no execution authority by existing; execution must cross an already-approved Ziggy Command, Tool, or supervised setup/doctor boundary with declared permissions. Classification follows Ziggy's existing mechanisms and stage ownership:

- Skills and optional lifecycle-only setup/doctor argv remain the no-callable-code content tier.
- Reusable external behavior becomes a declarative Command when fixed argv plus the closed argument
  mode can express it cleanly.
- In-process behavior becomes a `defineTool` Extension only when a Skill or supervised Command
  cannot express the capability cleanly.
- One-off integration instructions become a Blueprint, not runtime code.
- Scheduled behavior belongs to an Automation in S5, not an Extension-owned scheduler.
- Discord, Slack, iMessage, WhatsApp, and similar delivery surfaces are Gateway candidates for S6/S7, not Extensions with transport authority.
- Capabilities requiring loop hooks, Provider registration, a second durable authority, or a broader ABI are deferred, merged into an existing capability, or dropped. Ziggy is not widened to make a port fit.

**Per-candidate lean review and closure.** Ledger `deliveryStatus` is exact: `drop` is the only
`not-applicable` disposition; `planned` accepts a target but claims no implementation or budget
review; `landed` requires implementation, registered S4 capability scenarios, one fresh independent
accepted review, and no open S4 finding. Future-stage deferrals remain planned. Exactly one review
exists for each accepted S4-owned `port`, `merge`, or `blueprint` changing to landed—no review is
required or permitted to imply implementation while planned. Extension trust tier is required only
for an Extension target. `executor` is governed by the same derivation and cannot approve another
candidate or widen Ziggy.

The review records the single user outcome, target/execution mode, allowed production files and
physical-line budget, exact runtime dependencies, permissions, subprocess argv, typed persisted
state paths, support allowlist/digests/budgets, capability scenario IDs, findings, and assertions for
lowest trust tier, no duplicate authority, no compatibility shim, and no inactive vendored
material. Accepted means every assertion is true and no finding is open. Increasing any budget
requires a new independent review.

`reviewedInputDigest` is SHA-256 of recursively key-sorted canonical JSON containing
`schemaVersion`, candidate ID, delivery status, the canonical ledger-row digest, and the
verifier-derived sorted list of `{path,bytes,sha256}` inputs. Inputs include the ledger row,
Extension manifest, measured production/support files, relevant package manifests, and lockfile;
they exclude the review itself, every other review, findings input, `.artifacts`, `.git`, `vendor`,
`node_modules`, and timestamps. This avoids a self-referential digest while making implementation,
dependency, path, and status changes stale the review.

Landed reviews have distinct scout, implementer, and verifier context IDs, with clean `HEAD`
revision equality and ordered completion/start timestamps. S4 adds scoped findings/evidence
versions without changing S3 replay: findings carry `scope:{stage:"s4",candidateId:string|null}`;
current-workspace S4 closure rejects duplicate IDs, `open`/`not-applicable` dispositions, fixed
findings without registered regressions, and accepted non-reproducible findings without rationale.
`extension-integrity` meta-validates the schemas, exact ledger/review sets, digests, budgets,
reachability, scenario registration, clean-checkout rule, and S4 scope while inheriting S0-S3. These
implemented gates run under `verify:s4`; passing them proves only the currently landed set, not S4
stage closure.

**Closed inventory.** These IDs are the complete initial review queue, derived from the exact audited inventory of **47 candidates, 175 regular files, and 17,631,635 bytes**, whose canonical digest is `e629623273623eb3672adbe0523a33d2bab275dcdabf8abe75cdd38a9921b791`. The checked-in ledger carries that inventory evidence so verification never reads `../merlin`; additions require an explicit plan update rather than appearing opportunistically:

```text
acp-router, agent-browser, apple-notes, apple-reminders, architecture-diagram,
blogwatcher, clawhub, codex, coding-agent, diffs, discord, executor, gh-issues,
github, github-issues, github-pr-triage, gog, goplaces, here-now, humanizer,
hyperframes, imsg, linear, lossless-claw, mcporter, nano-pdf, notion, obsidian,
onepassword, open-computer-use, openai-whisper, peekaboo, qmd,
self-improving-agent, session-logs, skill-creator, skill-curator, slack,
smart-memory, summarize, telephony, things-mac, tmux, wacli, weather,
web-search, xurl
```

Every non-dropped row was registered as `planned`; no row initially claimed landed S4 behavior.
The checked-in ledger is now authoritative for current delivery status: `hyperframes` and
`skill-creator` are landed with independent reviews, while all future-stage deferrals and the
remaining S4 implementation queue stay planned. The strict target
union is `extension | core-skill | blueprint | automation | gateway`, with target ID, owner stage
`s4 | s5 | s6 | s7`, and Extension trust tier/execution mode only where applicable. `core-skill`
allows `skill-creator` to target the baked-in S4 skill-writing Skill. S7 Extension targets allow
`self-improving-agent`, `skill-curator`, and `smart-memory` to remain Extensions rather than being
misclassified as Gateways. Every partial migration records `excludedCapabilities`; persisted paths
are typed `{ scope, path, authority }`; permissions explicitly type external authorities such as
Notes, desktop accessibility, browser profiles, and external vaults; evidence entries carry exact
source-relative path, kind, byte count, and content digest. `executor` is a tentative ordinary
candidate with no predetermined mechanism, privileged proof role, inherited approval,
daemon/Session authority, or exemption from independent disposition and landed review.

**Non-extensible in v1 (core-only):** loop hooks (`beforeToolCall`/`afterToolCall` equivalents), provider registration, gateway adapters. This is a deliberate scope cut — extend it only once a proven third-party need emerges, per the constitution's minimal-trusted-surface stance.

## Verification growth

Extend `tests/testkit` with isolated Extension fixtures, dynamic-import probes, approval records,
version controls, supervised-subprocess fakes, and filesystem fault injection. Register malformed
or incompatible manifests, non-directory Skill roots, missing immediate `SKILL.md`, frontmatter/ID/root mismatches, path traversal, dangling or escaping Skill references, symlink/hardlink aliases, post-install mutation, orphan support material, support scripts that attempt undeclared execution, setup/doctor shell strings, Command ID collisions, invalid input mode/NUL/count/byte bounds, execution before fixed-prefix/digest/permission approval, runtime PATH lookup, live cancellation or timeout without descendant cleanup, version-bump reapproval, import-before-approval, failed/partial installs, doctor timeout/failure, blueprint postconditions, and concurrent install/
enable operations. Evidence includes parsed manifests, approval/import timelines, subprocess
results, Profile diffs, and compiled-binary loader smoke output. A separate Sol medium agent in an
independent run and context reviews trusted-code entry, daemon-only writes, schema stamps, path
confinement, and accidental new extensibility.

## Acceptance criteria

- A Skill-only Extension with no Tools or executable setup installs without execution approval and becomes visible to the agent loop with zero code loaded. If it declares setup/doctor argv, installation remains non-executing until the user approves the exact argv, permissions, executable/support-file digests, and Extension version; only then may supervised doctor report pass/fail.
- A manifest-v2 Command is absent while disabled or unapproved. Once approved and enabled, it becomes a Session Tool that executes the pinned absolute executable with its fixed argv prefix and only its declared `none | append` argument mode, explicit cwd, timeout, declared environment, bounded output, and structured result. Shell syntax stays inert; cancellation terminates the process group; every invocation revalidates compatibility, identity, exact authority, seal, and executable digest.
- An in-process Extension with a `tools/<id>/tool.ts` is refused execution until `ziggy extension install` records explicit approval; after approval, the daemon's dynamic `import()` loads it and the Tool becomes callable in a Turn.
- Re-running install after an Extension version, Tool, setup/doctor argv, permissions, or sealed-tree digest change re-prompts for the affected execution approval; an identical same-version reinstall does not.
- The schema-v1 migration ledger contains exactly the 47 declared Merlin candidate IDs, no duplicates and no unreviewed rows. Every row—including `executor`—records an independently justified disposition and rationale; every `port` or `merge` names its Ziggy target mechanism, and an Extension target also names its trust tier. Gateway- and Automation-shaped capabilities are deferred to their owning stages rather than smuggled into Extensions.
- Every declared Skill path is a normalized confined relative directory containing immediate `SKILL.md`; manifest ID, root basename, and Agent Skills frontmatter name match. References resolve within the sealed root, all support material is reachable and reviewed, symlinks/hardlinks are rejected, and post-install mutation fails every load/import/spawn until reinstall and reapproval.
- Every landed S4 port has a schema-valid fresh independent leanness review, registered deterministic capability scenarios, and no open S4 finding; planned rows need no budget review. Its implementation uses Ziggy's `extension.json`, directories, approval model, and daemon-owned state without copied Merlin source, a Merlin compatibility layer, unused wrappers/assets, or an ABI expansion made solely for migration. Every retained reference, script, and asset lives under a manifest-declared Skill root, is justified by the review, resolves without escape or dangling links, and remains inert unless invoked through a separately approved Ziggy execution boundary. `verify:s4` measures its files/lines, dependencies, permissions, subprocesses, support material, and persisted-state paths against the reviewed budget and fails closed on growth.
- A blueprint fixture Profile lives under the test fixtures. After an agent applies a `blueprints/` markdown guide to that fixture, a deterministic postcondition check proves the expected files and exact content changes, with no blueprint code executed directly.
- Manifest schema decoding enforces strict required fields and cross-field invariants, rejects package provenance/trust claims, non-canonical versions/ranges, and missing `ziggy.requires`, but validates grammar only. The daemon-mediated install and every load boundary, including provider-runtime Skill and Tool composition, use `isZiggyVersionCompatible` with the explicit running Ziggy version and reject incompatible ranges, including prerelease-clause mismatches, before execution.
- S4 remains `pending` while RED scenarios or any planned gate are not implemented. It becomes implemented only when the harness, plan checklist, and scenario/stage manifests include every landed Extension behavior and negative/concurrency/fault scenario, `extension-integrity` exists, and `verify:s4` plus `verify:all` pass with schema-valid redacted S4-scoped evidence and resolved findings from an independent Sol medium verifier.

## References to consult

- `docs/research/extension-mechanisms.md` — full 5-system comparison (pi, openclaw, hermes, flue, eve); consult Section C for the subprocess-only recommendation that this plan deliberately departs from and for manifest concerns to evaluate independently.
- `docs/research/bun-compiled-plugin-loading.md` — empirical proof the dynamic-import escape hatch works in a compiled binary.
- pi-mono (local: `/Users/yesh/Documents/personal/reference/pi-mono`) — jiti-based TS extension loading (widest trusted surface; explicitly NOT the default here, but informs the in-process ABI shape).
- openclaw (opensrc: `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main`) — manifest/registry/security-scanning machinery and trust-tier precedent (builtin/verified/community adopted from here); also the separate markdown-skills mechanism this plan folds into tier 1.
- hermes-agent (opensrc: `/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main`) — cautionary example of registry sprawl from three overlapping mechanisms; also the trust-tier vocabulary.
- flue (opensrc: `/Users/yesh/.opensrc/repos/github.com/withastro/flue/main`) — blueprints-as-markdown pattern; tools-as-plain-objects (no general runtime loader) pattern behind the declarative default.
- Anthropic Agent Skills spec — for exact `SKILL.md` format compatibility (openclaw and hermes both read this format; ziggy should be byte-compatible).
- `../merlin/extensions` — bounded evidence corpus for capability discovery and behavior-level contracts only. D1 forbids copying its code, manifests, layout, or architecture into Ziggy.

## Suggested agent workflow

For each slice, follow the `docs/VERIFICATION.md` through-loop: dedicated Sol medium scouting/task-decomposition run and context → red scenario → separate Sol medium implementation run and context → independent Sol medium deterministic verification/evidence/review run and context. The implementing run must not be the verifying run.

1. Manifest schema + validator (`packages/core`), unit-tested against valid/invalid fixtures — implementation-shaped, delegate to codex sol/medium.
2. Define the versioned migration-ledger and per-candidate-review schemas, then build the checked-in 47-row Merlin capability ledger against the settled Ziggy manifest and ownership boundaries. Review every candidate, record its disposition, require an Extension trust tier only for Extension targets, and reject any proposed compatibility requirement before port implementation begins.
3. `SKILL.md` discovery/loader wired into the existing skill-injection point from S1 — small, mechanical.
4. `ziggy extension` CLI subcommands + daemon-side install/approval state persistence — implementation-shaped; test that the CLI performs no direct Profile writes.
5. In-process `defineTool` ABI + dynamic-import loader with approval gate — higher-trust-boundary code; require a dedicated Sol medium scouting/task-decomposition run and context before implementation, then independent Sol medium verification/review in a third run and context, plus deterministic regressions for applicable findings, before merging.
6. Generic manifest-v2 Command boundary with exact approval and supervised-process contracts; independently verify it before using `executor` as the first ordinary canary.
7. Implement accepted S4-owned candidates in small waves, with one independent leanness review and deterministic capability contract per Extension. After the canary, supervised-Command waves and Skill-only waves may run in parallel when they own disjoint files. Defer Automation/Gateway candidates to S5/S6/S7 and remove merged/dropped candidates from the implementation queue with rationale retained.
8. Implement accepted Blueprint candidates and the baked-in skill-writing Skill with deterministic postconditions and no new runtime authority.
9. `smart-memory`/`smart-extensions` scaffolds only. Their migration reviews may record a later-stage disposition but cannot authorize behavior in S4.

## Non-goals

- Loop hooks, provider registration, or gateway adapters as third-party-extensible surfaces (core-only in v1).
- Extension marketplace/registry service — local filesystem + manual `install <source>` only.
- Sandboxing/process-isolation for in-process Tool code beyond the approval gate (no seccomp/VM boundary in v1 — approval is the control, not runtime isolation; revisit if community-tier extensions become common).
- Full behavior for `smart-memory`/`smart-extensions`; S4 ships scaffolding only, and migration review cannot override this scope boundary.
- Merlin manifest/layout compatibility, source-level ports, bulk copying, blind import of references/scripts/assets, or preserving every Merlin package merely because it exists. The closed review queue guarantees consideration, not automatic acceptance.
