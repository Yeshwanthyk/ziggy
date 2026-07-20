# S0 — Foundation

## Goal

Stand up the Bun workspace, tooling, and Effect v4 vendor submodule so every later stage has a correct, strict, lint-enforced base to build on. No product behavior ships in S0 — this stage is infrastructure only.

## Deliverables

- Bun workspace at repo root with four S0 packages: `packages/core`, `packages/protocol`, `packages/tui`, `packages/ziggy` (CLI entry), plus a root `extensions/` directory (empty, for first-party curated extensions like `smart-memory` in later stages). First-party Gateways are added at their later stages as additional `packages/gateway-*` leaf workspace packages that depend only on `packages/protocol`.
- `LICENSE` — Apache-2.0; the repository remains private until the user explicitly changes its visibility.
- `tsconfig.json` (root, extended per-package): `strict: true`, `noUncheckedIndexedAccess: true`, no implicit `any`. Enforce **no `any` and no TypeScript assertion syntax except `as const`** — via lint rules, not just tsconfig.
- `oxlint` config (`.oxlintrc.json`) plus TypeScript-aware custom rules that ban `TSAsExpression` except `as const`, ban the `TSTypeAssertion` angle-bracket form, and ban non-null assertions. Add lint-test fixtures covering `as Type`, generic assertions, multiline assertions, angle-bracket assertions, and non-null assertions, with an explicit passing fixture for `as const`. Add `oxfmt` configuration for formatting and `knip` configuration for unused-export detection across the workspace.
- `vendor/effect` — git submodule of `https://github.com/Effect-TS/effect`, pinned to tag `effect@4.0.0-beta.99` (commit `6184a7dc53cb9310e299b65ad6d6c712c2cbf202`).
- `AGENTS.md` at repo root (if not already written by the parallel docs task) with a rule: **before writing any Effect code, consult `vendor/effect/ai-docs/src/` (narrative guides + checked examples) and `vendor/effect/migration/` (v3→v4 API changes)** — there is no top-level `docs/` at this tag and v4 API surface is still churning pre-stable.
- Pinned (exact, no `^`/`~`) dependencies: `effect@4.0.0-beta.99`, `@effect/platform-bun@4.0.0-beta.99`, `@earendil-works/pi-ai` (exact version, latest at implementation time), `@earendil-works/pi-tui` (exact version, latest at implementation time). Record the exact pinned versions in this plan's implementation PR description.
- Verification harness skeleton from `docs/VERIFICATION.md`: shared test-only helpers and deterministic boundary adapters under `tests/testkit`; executable scenarios and a registry under `tests/scenarios`; tracked stage/slice manifests and versioned scenario/manifest/evidence schemas under `verification/`; `.artifacts/` ignored for generated local evidence. Shared test code never lives in a workspace package and is never imported by production packages.
- Contract-test harness: a `defineContractTests` helper under `tests/testkit/world/` (pattern from flue — one executable test suite that any storage/world adapter implementation must pass), with zero product adapters implemented yet. S0 proves the harness against a trivial test-only in-memory stub.
- Root verifier scripts `verify:s0` through `verify:s7` plus `verify:all`, driven by tracked manifests. S0's gate includes lint, format, typecheck, tests, package-graph enforcement, and compile smoke; undeveloped stages are explicitly manifest-empty rather than silently skipped.
- CI (GitHub Actions or equivalent): `bun install`, `bun run lint` (oxlint), `bun run fmt:check` (oxfmt), `bun run typecheck` (tsc --noEmit), `bun test`, and `bun run verify:all`. The S0 verifier includes a compile smoke test: `bun build --compile packages/ziggy/src/main.ts --outfile /tmp/ziggy-smoke` **without** `--minify` (effect-smol issue #2126 — `Stream.mkUint8Array` crashes under Bun's minifier when combined with `--compile`). Assert the smoke binary runs and exits 0 on a trivial `--version` command. Validate/redact generated evidence and upload `.artifacts/verification/` as a CI artifact; never commit generated bundles.
- `README.md` stub: one paragraph pointing to `docs/NORTH-STAR.md`, `docs/ROADMAP.md`, and `AGENTS.md`.

## Design (locked decisions binding this stage)

- **Repo layout is locked at S0**: `core` (runtime/daemon), `protocol` (attach-protocol types + dependency-free client SDK), `tui` (pi-tui-based client, depends on `protocol` only, never on `core`), and `ziggy` (CLI entry, bundles everything for `bun build --compile`). First-party Gateways join later as additional leaf workspace packages depending only on `protocol`.
- **License is locked**: Apache-2.0 from commit one. The repository remains private until the user explicitly says to make it public; binaries remain deferred to v1 (after S6) unless separately changed.
- Effect v4 exact version and submodule pin are locked — do not float to `latest` (which resolves to stable v3) or to a newer beta without deliberately re-verifying against `docs/research/effect-v4-status.md`.
- `pi-ai` and `pi-tui` are exact-pinned given pre-1.0 churn (pi-ai had 30+ releases in ~10 weeks per research).

## Verification growth

S0 creates the manifest-driven harness, not product behavior. Deterministic hooks cover clock/IDs,
filesystem/process faults, and command capture as test-only adapters; the initial negative cases
prove prohibited package edges, assertion syntax, malformed/undeclared scenarios, invalid evidence,
and accidental `--minify` fail closed. Evidence contains package-graph, lint/type/test, manifest,
and compile-smoke results with replay metadata. A separate Sol medium agent in an independent run
and context reviews package-boundary leakage, silent skips, redaction, and whether every later
verifier exists without claiming later behavior.

## Acceptance criteria

- [x] `bun install` succeeds from a clean clone (submodule included via `git submodule update --init`).
- [x] `bun run lint`, `bun run fmt:check`, `bun run typecheck`, `bun test` all pass (trivially, on placeholder code) in CI.
- [x] Lint-test fixtures prove that `as Type`, generic assertions, multiline assertions, angle-bracket assertions, and non-null assertions all fail, while `as const` passes. The checks operate on TypeScript AST node kinds (`TSAsExpression`, `TSTypeAssertion`, and non-null assertion), not a grep heuristic.
- [x] `vendor/effect` is present, at the pinned tag, and `vendor/effect/ai-docs/src/` is readable.
- [x] Compile smoke test produces a working binary without `--minify` and the binary runs.
- [x] `tests/testkit`, `tests/scenarios`, the scenario registry, tracked stage/slice manifests, versioned evidence schemas, and workflow documentation exist; `.artifacts/` is ignored and no production package imports testkit code.
- [x] The package-graph check enforces exactly D13's four S0 workspace packages and the allowed dependency direction; `defineContractTests` under `tests/testkit` passes against a trivial test-only in-memory stub.
- [x] `bun run verify:s0` and `bun run verify:all` pass; `verify:s1` through `verify:s7` explicitly report manifest-empty stages without claiming behavior. The S0 evidence bundle validates, is redacted, is replayable, and is uploaded by CI.
- [x] The S0 plan checklist and scenario/stage manifests reflect the implemented harness, and findings from verification/review by a separate Sol medium agent in an independent run and context are resolved without waiving deterministic failures.

## References to consult

- `docs/research/effect-v4-status.md` — exact version, package layout, Bun adapter APIs, the `--compile --minify` caveat, submodule instructions.
- `docs/research/bun-compiled-plugin-loading.md` — confirms `bun build --compile` behavior relevant to the smoke test (not directly needed until S4, but the compile pipeline itself is set up here).
- flue repo (`opensrc path github.com/withastro/flue`) — contract-test-suite pattern for adapters (informs the `defineContractTests` shape).
- `docs/REFERENCES.md` for exact repo paths.

## Suggested agent workflow

Follow the through-loop in `docs/VERIFICATION.md` for each slice. A dedicated Sol medium run and
context scouts and decomposes the workspace, package-graph, harness, and CI failure surfaces. A
separate Sol medium run and context then implements the smallest slice against a red deterministic
scenario: (1) four-package workspace/tooling/license, (2) Effect submodule pin, (3)
`tests/testkit` + scenarios/manifests/schemas/verifier runner, and (4) CI compile smoke, evidence
validation/redaction, and artifact upload. A third, independent Sol medium run and context runs
focused `verify:s0` and full `verify:all`, produces the evidence, and reviews assertion-ban
coverage, forbidden package edges/imports, silent skips, compile flags, and evidence leakage; the
implementing run must not be the verifying run. Fix, re-run, then update the plan and manifests.

## Non-goals

- No real session engine, no real provider calls, no real daemon — those are S1/S2.
- No Cloudflare/world adapter beyond the trivial in-memory stub used to prove the contract-test harness runs — the filesystem adapter is S1/S2, Cloudflare is S7.
- No extension loading, no TUI rendering — S3/S4.
