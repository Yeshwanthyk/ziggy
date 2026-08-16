# anti-slop alignment report (final, post-implementation)

Date: 2026-08-16. Scope: one report file (`docs/research/anti-slop-alignment.md`) on the state of
upstream `dmmulroy/anti-slop` vs Ziggy's vendored port, from the pre-implementation audit through the
completed implementation. Facts about the current tree were verified in this session against
`/Users/yesh/code/personal/ziggy` (HEAD `bcae30e`, working tree carrying the implementation diff) and a
fresh clone of `/tmp/pi-github-repos/dmmulroy/anti-slop` (HEAD `446268e`, "Ignore agent tooling when
installing anti-slop", Fri Aug 14 2026). Sections 1–2 and 4 are preserved audit history: section 4's
finding counts are the **pre-implementation baseline** and do not describe the current tree.
Sections 3 and 5–7 describe the **completed state**. The implementation remains uncommitted at the
time of this report.

## 1. Upstream vendoring model and 15-rule inventory

Upstream `README.md` (`/tmp/pi-github-repos/dmmulroy/anti-slop/README.md`) states the vendoring
model explicitly: *"This project is meant to be vendored, not treated as a fixed npm dependency.
Copy the rules into your repository, read them, and change them to match your team's standards"*;
the bundled agent skill performs the initial copy/configuration and the vendored files become the
consumer's own. Upstream ships two install paths: `npx skills add dmmulroy/anti-slop --skill
install-anti-slop` (agent-skill install) and manual copy of `src/` into the target repo (e.g.
`tools/oxlint/anti-slop/`) plus `jsPlugins` registration and per-rule `"error"` entries.
`src/` is canonical; `pnpm sync:skill-assets` regenerates the bundled skill copy and CI
(`.github/workflows/ci.yml` → `pnpm check`) enforces they stay identical.

The 15 rules, all defined in `src/index.ts` (`eslintCompatPlugin({ meta: { name: "anti-slop" } })`)
and listed in `README.md` (canonical file per rule under `src/rules/`):

1. `no-chained-type-assertions` — rejects nested type-assertion chains.
2. `no-conditional-empty-object-spread` — rejects `...(cond ? {x} : {})` spreads.
3. `no-known-value-widening` — rejects broad target types that discard known value evidence.
4. `no-module-mocking` — rejects Vitest/Jest module mocks.
5. `no-object-parameters` — rejects broad `object` on function inputs.
6. `no-reflect-apply` — rejects `Reflect.apply`.
7. `no-reflect-get` — rejects `Reflect.get`.
8. `no-runtime-typeof` — requires boundary parsing over ad hoc `typeof`; optional
   `allowInTypeGuards` (default `false`).
9. `no-shape-in-symbol-names` — rejects `shape` in symbol names.
10. `no-unknown-parameters` — rejects `unknown` inputs except the explicit `cause` convention.
11. `no-unknown-returns` — rejects `unknown`/`Promise<unknown>` returns.
12. `no-unknown-type-aliases` — rejects aliases that conceal `unknown`.
13. `no-unsafe-dictionary-type` — rejects dictionary value contracts of `unknown`/`any`/`object`/`{}`.
14. `no-widen-then-assert` — rejects widen-then-assert flows.
15. `require-safety-comment-for-type-assertion` — requires a `SAFETY:` justification per assertion.

Shared helpers live in `src/shared/`: `dictionary-types.ts`, `lexical-type-parameters.ts`,
`reflect-method.ts`. Upstream dev stack: oxlint + `@oxlint/plugins` 1.78.0, pnpm 10.33.0.

## 2. Pre-implementation audit: skill command run and dormant lock artifacts

The exact command run against this repo per upstream README install instructions:

```bash
npx skills add dmmulroy/anti-slop --skill install-anti-slop
```

Verified evidence the skills CLI was invoked: the fetched package is still in npx's cache at
`~/.npm/_npx/ac0ed6aa23b37c1e/node_modules/skills` (`skills@1.5.22`, "The open agent skills
ecosystem"; its `dist/cli.mjs` defines the lock file as `LOCAL_LOCK_FILE = "skills-lock.json"`).
The subsequent vendor commits in this repo record the outcome:
`c10b22b` ("chore: vendor anti-slop oxlint rules") → `274828e` ("chore: fold type-safety lints into
the ziggy oxlint plugin").

Dormant `.agents/.claude/.pi` lock artifacts are confirmed removed/absent at HEAD:

- `find . -name "*skills-lock*"` (whole repo, excluding `node_modules`/`.git`): zero results —
  no `.agents/skills-lock`, `.claude/skills-lock`, `.pi/skills-lock`, and no root `skills-lock.json`.
- `.claude/` does not exist at all; `.agents/` contains only tracked `skills/` (9 Effect skills +
  `typescript-type-safety`, all in `git ls-files`); `.pi/` contains only `skills/` (empty) and
  `tasks/` (excluded from git via `.git/info/exclude`).
- No `skills-lock` file ever entered git history (`git log --all --diff-filter=D --name-only`).
- `git status --porcelain=v1 -uall` shows nothing in `.agents`/`.claude`/`.pi`.

## 3. Completed state: ported, registered, enabled, gated, tested

- **All 16 rules live and enabled.** All 15 upstream rules are ported under
  `tooling/oxlint/ziggy/rules/*.mjs`, plus the pre-existing local rule
  `no-unsafe-typescript-syntax.mjs` (present since `77d2cdd`, predates the port) — 16 rule files
  total (`ls tooling/oxlint/ziggy/rules/*.mjs | wc -l` → 16). All 16 are registered via `import`
  in the `ziggy` plugin map (`tooling/oxlint/ziggy-plugin.mjs`, `meta: { name: "ziggy" }`) and all
  16 are enabled `"error"` in `.oxlintrc.json` — the same file registers only
  `./tooling/oxlint/ziggy-plugin.mjs` and `./tooling/oxlint/effect-plugin.mjs` as `jsPlugins`. No
  rule file is dormant: every `rules/*.mjs` is both registered and enabled.
- **Shared files restored at upstream fidelity.** Three shared helpers:
  `tooling/oxlint/ziggy/dictionary-types.mjs`, `tooling/oxlint/ziggy/reflect-method.mjs`, and the
  new `tooling/oxlint/ziggy/lexical-type-parameters.mjs` (mirrors upstream
  `src/shared/lexical-type-parameters.ts`). The lexical helper is consumed by both rules that use
  it upstream — `tooling/oxlint/ziggy/rules/no-object-parameters.mjs` and
  `tooling/oxlint/ziggy/rules/no-unknown-returns.mjs` both `import { lexicalTypeParameterNames }
  from "../lexical-type-parameters.mjs"` — replacing the two divergent inline copies (mapped-type
  `nameType`/`typeAnnotation` shadowing and `TSInferType` names now match upstream).
- **Root gate covers the gateway client.** `package.json` adds `check:gateway-client`:
  `bun run --cwd clients/gateway-client lint && bun run --cwd clients/gateway-client typecheck &&
  bun run --cwd clients/gateway-client test`, wired into `check` after `typecheck`. The client's
  own scripts (`clients/gateway-client/package.json`) run `oxlint -c .oxlintrc.json src test`,
  `tsc --noEmit -p tsconfig.json` (strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), and `bun test ./test` (9 tests).
- **Scoped client policy, no inline exemptions.** `clients/gateway-client/.oxlintrc.json`
  registers only the ziggy plugin and enables 12 of the 16 rules at `"error"`, with
  `reportUnusedDisableDirectives: "error"`. The boundary exemption is at policy level: the four
  rules aimed at assertion-heavy parser/boundary code paths
  (`no-runtime-typeof`, `no-unknown-parameters`, `no-unsafe-dictionary-type`,
  `no-unsafe-typescript-syntax`) are intentionally excluded for the protocol-mirror guards in
  `clients/gateway-client/src/index.ts`, and `ziggy-effect` is not registered for the client. The
  source was tightened to need zero disable directives — `grep -rn "oxlint-disable" clients/`
  returns nothing — e.g. `ERROR_CODES`/`EXTENSION_OPERATIONS`/`EXTENSION_FAILURE_STAGES` became
  `Set<string>` with membership tests inside the guards (removing the widen-then-assert casts),
  `decodeResponse` was rewritten from a conditional spread to `if/else` branches, and the test
  fixture (`clients/gateway-client/test/client.test.ts`) dropped `event as never` casts and added
  the required `SAFETY:` comment on its `JSON.parse` assertion.
- **Parity and lexical fidelity tests added.** `test/tooling/oxlint-parity.test.ts` runs the local
  oxlint binary against temp fixtures with a plugin-only config and asserts six rule behaviors
  (Reflect methods incl. shadowed owners; runtime `typeof` incl. type guards; unsafe-syntax vs
  safety-comment separation; the `cause` unknown exemption; nested unsafe dictionaries;
  vi/jest mocking with shadowing). `tooling/oxlint/ziggy/lexical-type-parameters.test.ts` asserts
  mapped-type `nameType`/constraint shadowing vs annotation-only shadowing, `TSInferType`
  renaming, generic shadowing, and nested functions.
- **Verification results (this session).** `bun run test` (i.e. `bun test ./test ./extensions
  ./tooling && bun run test:helpers`): **580 pass / 0 fail across 85 files**. Focused run
  `bun test ./tooling/oxlint/ziggy/lexical-type-parameters.test.ts
  ./test/tooling/oxlint-parity.test.ts`: **7 pass / 0 fail**. `bun run check` (oxfmt `--check`,
  `lint`, `typecheck`, `check:gateway-client`, `check:catalog`, `check:pi-docs`): **exit 0, green**.
- **No duplicate artifacts.** `package.json` devDependencies hold no `@oxlint/plugins` and no
  anti-slop dependency (only `oxlint@1.75.0`, `oxfmt@0.60.0`); the fold commit `274828e`
  deliberately dropped the separate `anti-slop` plugin dir and the `@oxlint/plugins` dependency;
  no `tooling/oxlint/anti-slop/` exists at HEAD (`ls tooling/oxlint/` → `effect`,
  `effect-plugin.mjs`, `ziggy`, `ziggy-plugin.mjs`). No duplicate skill or lock artifacts (§2).

## 4. Pre-implementation audit baseline (historical counts)

Describes the tree **before** the implementation above; counts here were never re-measured and do
not reflect the current tree. Methodology: run upstream's own oxlint 1.78.0 with the upstream plugin
(fresh clone, `pnpm install`) against the local repo using a temp config registering only the
upstream plugin (`/tmp/anti-slop-audit.oxlintrc.json`, `"jsPlugins": [{ "name": "anti-slop",
"specifier": "/tmp/pi-github-repos/dmmulroy/anti-slop/src/index.ts" }]`, all 15 rules `"error"`)
over the same path set plus clients:

```bash
cd /Users/yesh/code/personal/ziggy
/tmp/pi-github-repos/dmmulroy/anti-slop/node_modules/.bin/oxlint \
  -c /tmp/anti-slop-audit.oxlintrc.json src test extensions tooling clients
```

Result: **88 findings** (`exit=1`), per rule:

| rule | count |
|---|---|
| `no-runtime-typeof` | 33 |
| `require-safety-comment-for-type-assertion` | 25 |
| `no-unknown-parameters` | 25 |
| `no-reflect-apply` | 2 |
| `no-unsafe-dictionary-type` | 1 |
| `no-conditional-empty-object-spread` | 1 |
| `no-chained-type-assertions` | 1 |

Per path: 65 `clients/gateway-client/src/index.ts`, 12
`test/adapters/pi/ziggy-tui-extension.test.ts`, 6 `clients/gateway-client/test/client.test.ts`, 2
`test/adapters/bun/automation-sqlite.test.ts`, 2 `src/adapters/pi/specialist.ts`, 1
`extensions/lossless-claw/src/store.ts`.

Why most findings were "gateway" findings (71/88 = 81%):

1. **`clients/gateway-client` was excluded from root lint.** The gate was `oxlint src test
   extensions tooling` (package.json `lint` script); `clients/` had never been linted, so these
   diagnostics were never triaged. The gateway-client file had **zero** `oxlint-disable`
   directives (`grep -rn "oxlint-disable" clients/` → none), so every diagnostic fully surfaced.
2. **Namespace disables differed.** The remaining 17 findings were in files clean under the local
   `ziggy/*` namespace precisely because they carry `ziggy`-qualified disable directives, which
   do not match the upstream `anti-slop/*` namespace:
   - `test/adapters/pi/ziggy-tui-extension.test.ts:1` disables `ziggy/no-unsafe-typescript-syntax,
     ziggy/require-safety-comment-for-type-assertion, ziggy/no-chained-type-assertions` (11 of the
     12 findings);
   - `test/adapters/bun/automation-sqlite.test.ts:469/484` `oxlint-disable-next-line
     ziggy/no-reflect-apply` → findings at 470/485 (both `no-reflect-apply`);
   - `src/adapters/pi/specialist.ts:794/910` `oxlint-disable-next-line ziggy/no-unknown-parameters`
     → findings at 795/911;
   - `extensions/lossless-claw/src/store.ts:258` `oxlint-disable-next-line
     ziggy/no-unknown-parameters` → finding at 259.

A local scan with Ziggy's own oxlint 1.75.0 and the local plugins (`.oxlintrc.json`) over
`src test extensions tooling clients` reported **127 total diagnostics**, all in `clients/` (115
`clients/gateway-client` incl. its test, 12 `clients/example-web/main.ts`), 0 in
`src`/`test`/`extensions`/`tooling`; 71 of the 115 gateway diagnostics were the `ziggy/*`
anti-slop-family subset (33 `no-runtime-typeof` + 22 `no-unknown-parameters` + 14
`require-safety-comment-for-type-assertion` + 1 `no-unsafe-dictionary-type` + 1
`no-conditional-empty-object-spread`), the rest being local-only rules
(`no-unsafe-typescript-syntax`, `ziggy-effect`) — and the 12 `example-web` diagnostics were all
`ziggy-effect`. Gateway-client's own tests passed (8/8) but were absent from the root gate.

This baseline motivated the completed changes in §5: the client was out of the gate, its protocol
guards tripped `no-runtime-typeof`/`no-unknown-parameters` wholesale, the lexical helper had
diverged, and no ported-rule tests existed.

## 5. Implemented changes (mapping the audit recommendations)

Each prioritized improvement from the audit is completed:

1. **Client tests/typecheck in the root gate** — done: `check:gateway-client` runs the client's
   scoped lint, strict typecheck (`clients/gateway-client/tsconfig.json`), and 9 tests from
   `bun run check` (`package.json`).
2. **Scoped client lint policy** — done: `clients/gateway-client/.oxlintrc.json` enables 12 ziggy
   rules with `reportUnusedDisableDirectives: "error"` and exempts the assertion-heavy policy at
   boundary level (leaving `no-runtime-typeof`, `no-unknown-parameters`,
   `no-unsafe-dictionary-type`, `no-unsafe-typescript-syntax` — and `ziggy-effect` — out of the
   client scope). The 33-baseline `no-runtime-typeof` divergence (the port still implements no
   `allowInTypeGuards` option, so every `typeof` reports) is resolved by policy, not by adding
   the option; the parity test pins the current behavior.
3. **Shared lexical type-parameter fidelity** — done: `tooling/oxlint/ziggy/lexical-type-parameters.mjs`
   restores upstream semantics and is consumed by `tooling/oxlint/ziggy/rules/no-object-parameters.mjs`
   and `tooling/oxlint/ziggy/rules/no-unknown-returns.mjs`.
4. **Parity tests** — done: `test/tooling/oxlint-parity.test.ts` (6 tests) plus
   `tooling/oxlint/ziggy/lexical-type-parameters.test.ts` (1 test).

Rejections from the audit held: no duplicate `anti-slop` namespace/plugin dir, no
`@oxlint/plugins` dependency, no wholesale root lint of `clients/` under the core policy, and no
removal of overlap rules as dormant.

## 6. Remaining later work

- **Periodic upstream parity review only.** Upstream's sole post-port commit (`446268e`) touched
  install tooling, not rule semantics, so no re-sync is required today. On future upstream
  releases, re-diff `src/rules/*.ts` and `src/shared/*.ts` in
  `/tmp/pi-github-repos/dmmulroy/anti-slop` against `tooling/oxlint/ziggy/` before folding changes;
  the parity tests in §5 are the regression net for that review.
- No other work remains: no config, dependency, skill, lock, or dormant-file cleanup is pending (§3).

## 7. Git state

`git status --porcelain=v1 -uall` shows exactly the intended implementation diff
(`package.json`, `clients/gateway-client/{package.json,.oxlintrc.json,src/index.ts,test/client.test.ts}`,
`tooling/oxlint/ziggy/lexical-type-parameters.{mjs,test.ts}`,
`tooling/oxlint/ziggy/rules/{no-object-parameters,no-unknown-returns}.mjs`,
`test/tooling/oxlint-parity.test.ts`, `LOG.md`) — **plus one unrelated file outside the intended
diff**: the untracked `docs/isometric-codebase-map.html`. The fresh upstream clone under
`/tmp/pi-github-repos/` and the temp audit config `/tmp/anti-slop-audit.oxlintrc.json` are outside
the repo and leave no trace in Ziggy. Markdown sanity (balanced code fences, no trailing
whitespace) and `git diff --check` both pass; no whitespace errors in the diff.

## Appendix: cited paths and proof commands

- Upstream: `README.md`, `src/index.ts`, `src/rules/*.ts`, `src/shared/{dictionary-types,lexical-type-parameters,reflect-method}.ts`, `.github/workflows/ci.yml`, `package.json` — all under `/tmp/pi-github-repos/dmmulroy/anti-slop` (HEAD `446268e`).
- Local (completed state): `package.json` (`check:gateway-client`), `tooling/oxlint/ziggy-plugin.mjs`, `tooling/oxlint/ziggy/rules/*.mjs` (16), `tooling/oxlint/ziggy/{dictionary-types,reflect-method,lexical-type-parameters}.mjs`, `tooling/oxlint/ziggy/lexical-type-parameters.test.ts`, `.oxlintrc.json`, `clients/gateway-client/{.oxlintrc.json,package.json,tsconfig.json,src/index.ts,test/client.test.ts}`, `test/tooling/oxlint-parity.test.ts`, `.agents/skills/*`, LOG.md §"Type-safety Oxlint rules added".
- Proof commands (all run in this session): `bun run test` → 580 pass / 85 files; `bun test ./tooling/oxlint/ziggy/lexical-type-parameters.test.ts ./test/tooling/oxlint-parity.test.ts` → 7 pass; `bun run check` → exit 0 (incl. `check:gateway-client`: lint + typecheck + 9 tests pass); `grep -rn "oxlint-disable" clients/` → none; `find . -name "*skills-lock*"` → zero; `ls tooling/oxlint/ziggy/rules/*.mjs | wc -l` → 16; `git status --porcelain=v1 -uall`; `git diff --check` → clean; upstream audit and local scan commands quoted in §4.