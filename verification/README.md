# Verification harness

Tracked manifests are the closed-world declaration of behavior for each stage. Exactly
`verification/manifests/s0.json` through `s7.json` must exist. Their predecessor lists are strict,
ordered transitive closures; symbolic gates come from the manifest gate allowlist and are
executed from those declarations. The registry at `tests/scenarios/registry.ts` is bijective with
manifest scenario IDs and uses unique, normalized, repository-contained `.test.ts` files.
`s0` is implemented; `s1`–`s7` are intentionally `manifest-empty` until product behavior lands.
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
configuration.

The compile smoke constructs the locked `bun build --compile` argv without `--minify`, writes only
to an isolated OS temporary directory, applies bounded compile and binary-execution timeouts,
terminates the process tree on timeout, executes `--version`, requires `0.0.0`, and removes the
directory on every exit path.

## Evidence and replay

Each verifier atomically publishes redacted derived evidence to
`<repo>/.artifacts/verification/<run-id>/{summary,result,replay}.json`. Publication uses a sibling
temporary directory and renames it only after schema validation, explicit decoding, redaction,
leak scanning, and replay validation; failed publication removes the temporary directory. Evidence
captures preflight, gate, scenario, and publication phases, including failure evidence whenever the
evidence subsystem remains usable.

Command evidence never stores unrestricted raw stdout/stderr, their digests, or their byte counts.
For each stream it stores bounded redacted diagnostic text, a SHA-256 digest of that stored
diagnostic, and whether the redacted text was truncated. Sensitive keys are normalized
case/separator-insensitively; auth/cookie headers, bearer/basic credentials,
query tokens, JSON-encoded headers, repository/Profile/home/temp paths, and private-looking Profile
output are redacted before `.artifacts` exists.

Replay binds summary/result digests and a deterministic workspace-input digest. Its per-file input
catalog covers manifests, schemas, the scenario registry and files, `bun.lock`, package manifests,
package source, root configuration, tests, and verification tooling while excluding generated,
vendor, dependency, and VCS directories. Validation compares the bundle against current inputs, so
unborn or dirty `HEAD` states remain replayable without embedding raw source in artifacts.
