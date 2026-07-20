# Verification policy

This document is the canonical cross-stage verification policy for Ziggy. Stage plans define
which behavior lands; this policy defines the proof required before a slice or stage may be
declared done.

## Authority model

1. **Deterministic tests and scenarios are the hard correctness authority.** They run without
   network or model calls and are reproducible from a clean checkout. A failure cannot be waived
   by an agent review, a manual observation, or prior evidence.
2. **AI-agent verification is a required implementation-loop gate, not a correctness oracle.** It
   runs in a separate context before a slice or stage is declared done. Findings become deterministic
   regression scenarios when the behavior can be reproduced deterministically; otherwise they
   remain explicit reviewed findings with replayable evidence and a disposition.
3. **Evidence proves what ran; it does not become product truth.** Verification evidence is
   derived, non-authoritative development state. It is not authoritative Profile state, Session
   transcript or Run evidence, Memory, or another writable authority. If replay material is copied
   into a synthetic Profile, it remains disposable derived Profile state; the evidence bundle
   under `.artifacts/` remains its only development-artifact location.

A stage inherits every predecessor gate. `verify:sN` runs the stage's focused gate plus all
required predecessor deterministic gates; `verify:all` runs the complete deterministic suite.

## Repository layout

The intended harness layout is:

```text
tests/
  testkit/                 # shared test-only helpers and deterministic boundary adapters
  scenarios/               # executable regression scenarios and registry
verification/
  manifests/               # tracked slice/stage scenario and gate manifests
  schemas/                 # tracked scenario, manifest, and evidence schemas
  README.md                # tracked workflow and replay documentation
.artifacts/
  verification/<run-id>/   # ignored local evidence bundles
```

D13's four product workspace packages remain `core`, `protocol`, `tui`, and `ziggy`. Shared test
code lives only under `tests/testkit`, never under `packages/testkit`, and production packages
must never import it. `tests/testkit` may import public production contracts to run reusable
contract suites against implementations. `tests/scenarios` owns deterministic end-to-end and
regression scenarios; tracked manifests map slices and stages to scenario IDs, commands, required
predecessor gates, and expected evidence.

For evidence formats and outputs, only schemas, manifests, and workflow documentation are tracked.
Generated reports, logs, traces, fixtures containing runtime output, screenshots, and replay
material live under `.artifacts/` locally. Hosted CI is disabled while the repository is private;
artifact upload resumes only when the user explicitly restores CI near publication.

## Deterministic boundary adapters

All nondeterministic or external boundaries used by a deterministic scenario are injectable and
controlled by `tests/testkit`: clock and scheduling, IDs and randomness, filesystem/process
faults, Provider streams, sockets and connection timing, subprocesses, HTTP/webhooks, Gateway
services, and remote storage. The storage contract is semantic—Session-log and Memory-document
operations—not generic byte paths or revisioned transactions. Memory batch replacement is
crash-safe atomic across documents (recovery exposes all old or all new), and a partial/torn final
Session NDJSON line fails loud without automatic ignore, truncation, or repair. Adapters expose
deliberate pause, reorder, disconnect, timeout, partial-write, crash, and failure hooks as
appropriate to the stage.

A deterministic test never calls a real Provider, model, OAuth service, Gateway API, public
network endpoint, or Cloudflare service. Real integrations may have separate smoke/manual checks;
they do not replace deterministic contracts or enter the deterministic correctness gate unless
they are fully simulated.

## Evidence bundles

Each verifier emits a schema-valid bundle under `.artifacts/verification/<run-id>/` containing at
least:

- evidence manifest: schema version, git revision/dirty state, stage/slice, command, scenario IDs,
  timestamps, tool/runtime versions, and overall result;
- machine-readable scenario results with seeds/schedules and boundary-adapter configuration;
- bounded redacted stdout/stderr diagnostic text, its diagnostic digest, and truncation state as
  needed to explain a failure, never unrestricted raw output, its digest, or byte counts;
- replay instructions and references to the exact manifest and deterministic inputs;
- agent scout/review findings and their disposition when the through-loop is being recorded.

Replay must require only the checkout, declared toolchain, tracked manifests, and bundle inputs;
secrets and live services are never required for deterministic replay. Redaction happens before a
bundle is persisted or uploaded: credentials, tokens, Authorization/Cookie headers, owner or
Person identifiers, message content not explicitly fixture-owned, absolute Profile paths, and
other user data are removed or replaced with stable synthetic values. Redaction is itself
schema-checked, and a redaction failure fails evidence publication. Generated bundles are never
committed.

## Verifier commands

The intended end-state root commands are:

```text
bun run verify:s0
bun run verify:s1
...
bun run verify:s7
bun run verify:all
```

S0 creates every command and the manifest-driven runner. Before a stage exists, its verifier may
report `not implemented` successfully only when its tracked manifest declares no behavior yet; it
must not silently skip declared scenarios. As behavior lands, the same change updates the relevant
scenario, stage/slice manifest, expected evidence, and plan checklist. `verify:all` is the local
hard gate while the repository is private; focused `verify:sN` commands support the implementation
loop without weakening inherited predecessor gates.

## AI roles and cadence

- **Sol medium — scout/decompose:** in a dedicated run and context, inspect contracts, invariants,
  predecessor scenarios, likely race/fault surfaces, missing negative cases, and task
  decomposition. This run does not implement or approve implementation.
- **Sol medium — implement:** in a separate run and context, make the smallest change that turns
  the accepted red scenario green. Focused test execution used while implementing does not count
  as independent verification.
- **Independent Sol medium — verify/review:** after implementation, a third Sol medium agent in a
  separate run and context runs focused and full deterministic verification, produces and reviews
  the evidence, and checks for contract divergence, authority violations, untested interleavings,
  boundary leaks, and scope pulled from later stages. Findings cannot waive failures or substitute
  for a deterministic gate.

Independent Sol medium verification is required at least once per slice and once across the
integrated stage before it is declared done. Scouting/task decomposition, implementation, and
verification/review use separate Sol medium runs and contexts. The implementing run must never be
the verifying run. While the repository is private, all verification runs locally and hosted CI
remains disabled until the user explicitly restores it near publication.

## Through-loop

Every slice follows this order:

1. **Scout/decompose** — a Sol medium agent in a dedicated run and context performs contract
   scouting, design exploration, and task decomposition without implementing.
2. **Red deterministic scenario** — add or select a manifest-registered scenario and prove it
   fails for the intended reason.
3. **Smallest implementation** — a different Sol medium run and context changes only what is
   needed for that scenario and its contract.
4. **Focused/full verification** — a third, independent Sol medium run and context runs the focused
   stage gate, then `verify:all`; the implementing run must not perform this verification role and
   no failures may be waived.
5. **Evidence** — the verifying run emits, validates, redacts, and retains the replayable evidence
   bundle.
6. **Independent verification/review** — that verifying Sol medium run reviews the implementation
   and evidence against invariants, negative cases, concurrency, and fault behavior.
7. **Fix and re-run** — convert applicable findings into deterministic regression scenarios, fix,
   and repeat verification and evidence generation.
8. **Update plan and harness** — update acceptance checklists, scenario/stage manifests, and any
   testkit contract needed by the behavior before declaring the slice or stage done.
