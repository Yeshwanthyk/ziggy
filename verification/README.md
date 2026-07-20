# Verification harness

Tracked manifests are the closed-world declaration of behavior for each stage. Exactly
`verification/manifests/s0.json` through `s7.json` must exist. Their predecessor lists are strict,
ordered transitive closures; symbolic gates come from the manifest gate allowlist and are
executed from those declarations. The registry at `tests/scenarios/registry.ts` is bijective with
manifest scenario IDs and uses unique, normalized, repository-contained `.test.ts` files.
`s0` and `s1` are implemented; `s2`–`s7` remain `manifest-empty` until product behavior lands.
Pending requirements may be cataloged without claiming implementation. Unsupported schema
versions, unknown fields/stages/gates/scenarios, duplicates, invalid paths, and status/content
contradictions fail closed.

## Schema boundary

The harness uses exact dev dependency `ajv@8.20.0` for Draft 2020-12 meta-validation and runtime
validation of every tracked manifest, scenario declaration, summary, result, replay document, and
nested command-evidence record. This dependency is intentionally narrow: manifests and evidence
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

The S0 manifest has separate gates for explicitly executing every registered scenario module and
for full `bun test`, which covers unregistered supporting/unit tests. A scenario command fails on
missing tests, skips, command failure, path/output mismatch, or undeclared execution. Evidence
records each scenario's actual result plus its declared deterministic seed, schedule, and boundary
configuration. Every S1 scenario must emit exactly one bounded structured observation marker after
its runtime assertions succeed; missing, duplicate, malformed, mismatched, or oversized markers fail
the scenario gate. The marker is parsed from captured process output and never persisted directly.

The compile smoke constructs the locked `bun build --compile` argv without `--minify`, writes only
to an isolated OS temporary directory, applies bounded compile and binary-execution timeouts,
terminates the process tree on timeout, executes `--version`, requires `0.0.0`, and removes the
directory on every exit path.

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
fault schedules, and filesystem diffs. Event and Provider observations are derived from runtime
objects, not manifest labels. Optional scout/review findings retain role, severity, and an explicit
open/accepted/fixed/not-applicable disposition; an empty list means no agent review was recorded for
that verifier run and does not satisfy an independent-review requirement. Independent runs attach a
bounded schema-valid report from an untracked file outside the repository:

```text
bun tooling/verification/runner.ts s1 --agent-findings /tmp/ziggy-s1-findings.json
```

The input uses `agent-findings-v1.schema.json`, is capped at 65,536 bytes, and is redacted before it
enters evidence. Its source path and raw bytes are never retained. Standard verifier commands omit
the option and continue to publish an empty findings list. Hosted CI is disabled while the
repository is private and resumes only when the user explicitly restores it near publication.

Replay binds summary/result digests and a deterministic workspace-input digest. Its per-file input
catalog covers manifests, schemas, the scenario registry and files, `bun.lock`, package manifests,
package source, root configuration, tests, and verification tooling while excluding generated,
vendor, dependency, and VCS directories. Validation compares the bundle against current inputs, so
unborn or dirty `HEAD` states remain replayable without embedding raw source in artifacts.
