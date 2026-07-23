# Verification harness

Tracked manifests are the closed-world declaration of behavior for each stage. Exactly
`verification/manifests/s0.json` through `s7.json` must exist. Their predecessor lists are strict,
ordered transitive closures; symbolic gates come from the manifest gate allowlist and are
executed from those declarations. The registry at `tests/scenarios/registry.ts` is bijective with
manifest scenario IDs and uses unique, normalized, repository-contained `.test.ts` files.
`s0` through `s3` are implemented. S4 remains pending, with implemented manifest/compatibility,
closed-ledger, daemon lifecycle, mutation recovery, supervised Command and approved Tool
boundaries, publication recovery, and legacy Blueprint/core-Skill/curated-scaffold slices; `s5`–`s7`
remain `manifest-empty` until product behavior lands. S3 covers Profile initialization,
Provider/auth, CLI, the shared Attach Client, Session listing, and deterministic plus manual-live
TUI behavior.
Pending requirements may be cataloged without claiming implementation. Unsupported schema versions,
unknown fields/stages/gates/scenarios, duplicates, invalid paths, and status/content contradictions
fail closed.

## Schema boundary

The harness uses exact dev dependency `ajv@8.20.0` for Draft 2020-12 meta-validation and runtime
validation of every tracked manifest, scenario declaration, S4 migration ledger and independent
review, summary, result, replay document, and nested command-evidence record. This dependency is intentionally narrow: manifests and evidence
are an external durable verification boundary, and hand-rolled partial schema checks previously
left correctness gaps. Explicit TypeScript decoders still run after schema validation.

Package-boundary analysis uses exact dev dependency `oxc-parser@0.140.0` narrowly for
deterministic, synchronous AST inspection after observed TypeScript 7 unstable parser hangs. It
has no subprocess or lexical fallback: parser diagnostics and computed module specifiers fail
verification closed.

## Commands

- `bun run verify:s0` resolves S0's declared transitive closure and runs its manifest gates.
- `bun run verify:sN` validates all manifests, resolves the selected manifest's declared
  predecessor closure, runs implemented gates once, and reports undeveloped stages as
  `manifest-empty` without claiming behavior.
- `bun run verify:all` resolves all declarations and de-duplicates inherited gates and scenarios.

S4 adds the `extension-integrity` gate. The settled plan requires it to validate the exact 47-row
distribution—39 standalone S4 Extensions, five Gateways (two S6, three S7), and three drops—and derive reviews only
from landed S4 `port` rows without reading `../merlin`. Planned rows have no placeholder review.
When a row lands, the gate checks independent context/revision freshness, reviewed-input digest,
production/support budgets, permissions, and registered deterministic capability scenarios. It
must enforce the five Skill-only / 34 supervised-Command split and reject any Skill-only outcome
that needs filesystem, network, CLI, external-application, or prior-Session-transcript access
beyond daemon-owned primitive Session Tools.

Shared S4 verification must cover the single daemon-owned Extension authoring Tool's bounded
manifest-plus-file-map input, inspect/create/update/delete operations, strict lifecycle validation,
existing staged atomic publication, expected current tree digests for update/delete, approval
enforcement without self-approval, absence of a draft or second authority, and next-Session-only
availability for newly installed or enabled Tools. Catalog assertions are incremental: candidate
waves add and prove their own entries. No pre-content chunk may claim all packages exist; only final
S4 closure asserts 40 bundled entries and exactly two default-enabled IDs.

The current schema, review-set derivation, manifests, and scenarios still encode the superseded
Blueprint/core-Skill architecture. This planning-only edit intentionally does not change them or
delete stale review files. The first S4 transition slice must update those executable contracts,
remove the HyperFrames and core-skill-writing scenarios/reviews, remove the legacy production
surfaces, and restore `verify:s4` before candidate implementation waves begin.

The S0 manifest has separate gates for explicitly executing every registered scenario module and
for full `bun test`, which covers unregistered supporting/unit tests. A scenario command fails on
missing tests, skips, command failure, path/output mismatch, or undeclared execution. Evidence
records each scenario's actual result plus its declared deterministic seed, schedule, and boundary
configuration. Every implemented S1, S2, and S3 scenario must emit exactly one bounded structured
observation marker after its runtime assertions succeed; the runner applies the same fail-closed
rule to every non-S0 scenario registered later. Missing, duplicate, malformed, mismatched,
unknown-field, or oversized markers fail the scenario gate. The marker is parsed from captured
process output and never persisted directly.

The compile smoke constructs the locked `bun build --compile` argv without `--minify`, writes only
to an isolated OS temporary directory, applies bounded compile and binary-execution timeouts,
terminates the process tree on timeout, executes `--version`, requires `0.0.0`, and removes the
directory on every exit path.

The real native service smoke is intentionally outside deterministic stage gates:
`bun run native-service:smoke` publishes one schema-valid, redacted
`native-service-smoke-v1.schema.json` record under `.artifacts/verification/`. It uses a compiled
binary to initialize a disposable Profile through `ziggy init`, then exercises install/definition
validation/doctor/stop/start/remove,
and records cleanup and platform capabilities. Its commands use placeholders and its diagnostics
are bounded semantic summaries with recomputable digests; raw native output is never persisted. A
digest over the bounded tracked tooling/service inputs makes dirty-worktree executions auditable.

## Evidence and replay

Each verifier atomically publishes redacted derived evidence to
`<repo>/.artifacts/verification/<run-id>/{summary,result,replay}.json`. Publication uses a sibling
temporary directory and renames it only after schema validation, explicit decoding, redaction,
leak scanning, and replay validation; failed publication removes the temporary directory. New
publications use `evidence-summary-v2.schema.json` and `evidence-result-v2.schema.json`; replay stays
on `evidence-replay-v1.schema.json`. Replay selects summary/result schemas from each document's
version and accepts unchanged S0 v1 bundles without migration. Evidence
captures preflight, gate, scenario, and publication phases, including failure evidence whenever the
evidence subsystem remains usable.

Command evidence never stores unrestricted raw stdout/stderr, their digests, or their byte counts.
For each stream it stores bounded redacted diagnostic text, a SHA-256 digest of that stored
diagnostic, and whether the redacted text was truncated. Sensitive keys are normalized
case/separator-insensitively; auth/cookie headers, bearer/basic credentials,
query tokens, JSON-encoded headers, repository/Profile/home/temp paths, and private-looking Profile
output are redacted before `.artifacts` exists. Scenario result evidence additionally retains bounded
schema-validated summaries of observed canonical event traces, Provider call inputs, deterministic
fault schedules, filesystem diffs, and named semantic counters. Canonical observations retain
Turn/Step identity, fixture-owned text and deltas, origin, and terminal status; TUI counters retain
replay cursors, duplicate application counts, and cleanup counts. Event and Provider observations
are derived from runtime objects, not manifest labels. Optional scout/review findings retain role,
severity, reviewed-workspace digest/revision/timestamp, and an explicit
open/accepted/fixed/not-applicable disposition; an empty list means no agent review was recorded for
that verifier run and does not satisfy an independent-review requirement. Once S3 is marked
implemented, verification fails in preflight unless an attached report contains unique review IDs
and every disposition is `fixed` or `accepted`; `open` and `not-applicable` cannot close the stage.
Deterministic failures remain authoritative regardless of disposition. Independent runs attach a
bounded schema-valid report from an untracked file outside the repository:

```text
bun tooling/verification/runner.ts s3 --agent-findings /tmp/ziggy-s3-findings.json
bun tooling/verification/runner.ts all --agent-findings /tmp/ziggy-s3-findings.json
```

The input uses `agent-findings-v1.schema.json`, is capped at 65,536 bytes, and is redacted before it
enters evidence. Every finding must include `review.workspaceDigest`, `review.gitRevision`, and
`review.reviewedAt`; preflight rejects a digest that does not match the current deterministic
workspace inputs. Its source path and raw bytes are never retained. Because S3 is implemented,
commands selecting S3 or `all` must use the documented `--agent-findings` form; bare `bun run
verify:s3` and `bun run verify:all` intentionally fail preflight rather than publish closure without
independent review. Hosted CI is disabled while the repository is private and resumes only when the
user explicitly restores it near publication.

Replay binds summary/result digests and a deterministic workspace-input digest. Its per-file input
catalog covers manifests, schemas, the scenario registry and files, `bun.lock`, package manifests,
package source, root configuration, tests, and verification tooling while excluding generated,
vendor, dependency, and VCS directories. Validation compares the bundle against current inputs, so
unborn or dirty `HEAD` states remain replayable without embedding raw source in artifacts.
