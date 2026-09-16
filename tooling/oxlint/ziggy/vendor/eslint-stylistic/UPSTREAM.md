# Vendored padding-line-between-statements

Source: [ESLint Stylistic](https://github.com/eslint-stylistic/eslint-stylistic), commit `435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08`.

The runtime helper is a JavaScript port of the upstream TypeScript adaptation used by anti-slop commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40e`:

- `padding-line-between-statements.ts` → `padding-line-between-statements.mjs`
- `padding-line-ast.ts` → `padding-line-ast.mjs`

The upstream `LICENSE` is retained verbatim. The helper remains MIT-licensed; keep this license with every redistributed copy. No Stylistic, ESLint, TypeScript-ESLint, or additional parser runtime dependency is required.

## Local adaptations

- TypeScript-only syntax and type imports are removed for Ziggy's native `.mjs` Oxlint plugin convention.
- Oxlint's public ESTree/source-code API is used directly; the helper preserves the upstream statement matchers, scope tracking, comment-aware insertion/removal, and selector support.
- The opinionated policy lives in `../../rules/require-readable-spacing.mjs`; it supplies options directly and exposes no user configuration options.

Fetch an explicit upstream revision before updating this helper, compare the original rule and its types against that revision, and preserve this record and the license. Focused Ziggy tests provide compatibility evidence for the enabled policy and repeated autofix stability; they do not claim full upstream conformance.
