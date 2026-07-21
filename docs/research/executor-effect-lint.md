# Executor Effect lint provenance

## Immutable source

Ziggy's Executor comparison is pinned to commit
[`7d6fcea263772a8e26f82ea6029fa7a57a64ca78`](https://github.com/UsefulSoftwareCo/executor/tree/7d6fcea263772a8e26f82ea6029fa7a57a64ca78).
The cached root package reports version
[`1.4.0-beta.0`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/package.json#L1-L4),
but no `1.4.0-beta.0` or `v1.4.0-beta.0` git tag was present during the audit. All links below
use the commit SHA rather than a branch or version label.

Executor registers 35 rules in its
[plugin entry point](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor.js#L1-L78).
Its test authority is the selective
[`oxlint-plugin-executor.test.ts`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/packages/core/sdk/src/oxlint-plugin-executor.test.ts#L1-L246),
not one negative and positive fixture per registered rule. Executor has no lint-skill inventory
validation script at this commit.

## Adapted Executor behavior

These Ziggy rules retain the corresponding Executor rule's AST behavior, with local `.mjs` module
paths, Ziggy scope decisions, and `wrdn-*` remediation diagnostics where applicable.

| Ziggy rule                              | Executor source                                                                                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-conditional-tests`                  | [`no-conditional-tests.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-conditional-tests.js#L1-L43)                                   |
| `no-effect-escape-hatch`                | [`no-effect-escape-hatch.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-effect-escape-hatch.js#L1-L33)                               |
| `no-error-constructor`                  | [`no-error-constructor.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-error-constructor.js#L1-L40)                                   |
| `no-inline-schema-compile`              | [`no-inline-schema-compile.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-inline-schema-compile.js#L1-L104)                          |
| `no-instanceof-error`                   | [`no-instanceof-error.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-instanceof-error.js#L1-L22)                                     |
| `no-instanceof-tagged-error`            | [`no-instanceof-tagged-error.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-instanceof-tagged-error.js#L1-L27)                       |
| `no-json-parse`                         | [`no-json-parse.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-json-parse.js#L1-L27)                                                 |
| `no-manual-tag-check`                   | [`no-manual-tag-check.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-manual-tag-check.js#L1-L37)                                     |
| `no-match-orelse`                       | [`no-match-orelse.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-match-orelse.js#L1-L27)                                             |
| `no-promise-catch`                      | [`no-promise-catch.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-promise-catch.js#L1-L30)                                           |
| `no-promise-client-surface`             | [`no-promise-client-surface.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-promise-client-surface.js#L1-L42)                         |
| `no-raw-fetch`                          | [`no-raw-fetch.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-raw-fetch.js#L1-L64)                                                   |
| `no-redundant-error-factory`            | [`no-redundant-error-factory.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-redundant-error-factory.js#L1-L90)                       |
| `no-try-catch-or-throw`                 | [`no-try-catch-or-throw.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-try-catch-or-throw.js#L1-L23)                                 |
| `no-ts-nocheck`                         | [`no-ts-nocheck.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-ts-nocheck.js#L1-L26)                                                 |
| `no-unknown-error-message`              | [`no-unknown-error-message.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-unknown-error-message.js#L1-L98)                           |
| `no-unknown-shape-probing`              | [`no-unknown-shape-probing.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-unknown-shape-probing.js#L1-L32)                           |
| `no-unsupported-effect-api`             | [`no-unsupported-effect-api.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/no-unsupported-effect-api.js#L1-L37)                         |
| `prefer-effect-predicate`               | [`prefer-effect-predicate.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/prefer-effect-predicate.js#L1-L89)                             |
| `prefer-schema-inferred-types`          | [`prefer-schema-inferred-types.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/prefer-schema-inferred-types.js#L1-L66)                   |
| `prefer-value-inferred-extension-types` | [`prefer-value-inferred-extension-types.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/prefer-value-inferred-extension-types.js#L1-L81) |
| `prefer-yield-tagged-error`             | [`prefer-yield-tagged-error.js`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/rules/prefer-yield-tagged-error.js#L1-L40)                         |

`no-promise-client-surface` is a direct behavioral port: `*Client` interfaces and exported
`*Sdk` interfaces are inspected for Promise-shaped methods and function properties. Its recursive
Promise-type helpers come from Executor's
[`isPromiseType` and `containsPromiseType`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor/utils.js#L100-L122).
Executor registers the rule at
[`scripts/oxlint-plugin-executor.js:60`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/scripts/oxlint-plugin-executor.js#L58-L61)
and enables it for its SDK boundary at
[`.oxlintrc.jsonc:141`](https://github.com/UsefulSoftwareCo/executor/blob/7d6fcea263772a8e26f82ea6029fa7a57a64ca78/.oxlintrc.jsonc#L135-L145).
Ziggy intentionally corrects Executor's unresolved `effect-client-wrapper` diagnostic to the
installed `wrdn-effect-client-wrapper` skill. General Promise ownership remains a separate
`no-native-promise-ownership` finding mapped to `wrdn-effect-runtime-boundaries`.

## Ziggy-specific closure

`no-effect-execution-boundary` and `no-native-promise-ownership` are Ziggy-specific rules; they
were not copied from Executor. Together with the 22 adapted rules above, Ziggy has 24 closed-world
Effect rules after adding the client-surface rule.

Ziggy additionally requires:

- exact agreement among enabled config entries, rule files, plugin imports, and plugin registrations;
- exact agreement between referenced and installed `wrdn-*` skills;
- an explicit allowlist for enabled diagnostics that intentionally have no remediation skill
  (`no-inline-schema-compile`, `no-match-orelse`, and `prefer-effect-predicate`);
- isolated bad/good fixture execution and exact diagnostic-code checks for all 24 rules.

## Scope evidence

Task 11 write-scope evidence is recorded locally at
[`.artifacts/verification/task-11-executor-lint-closure/write-scope.json`](../../.artifacts/verification/task-11-executor-lint-closure/write-scope.json).
It parses the `transcripts.json` files for workflows `wf_c0bcb00336e0`,
`wf_58a25ed6d3f5`, and `wf_f6d56329c055`, inventories their mutation-capable tool events, and
records no observed write to a product runtime path. This is transcript-scoped attribution only;
it does not claim that the pre-existing dirty worktree is clean.
