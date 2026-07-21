---
name: wrdn-effect-tests
description: Keep tests deterministic and Effect-aware. Use when lint flags conditional assertions or nondeterministic Effect test structure in Ziggy's Bun test suite.
---

Use Bun's test runner for tests in this repo. This is the Executor remediation pattern adapted to Ziggy's selected runner.

## Fix Shape

- Import `describe`, `it`, and `expect` from `bun:test`.
- Run scoped tests with `bun test <path>` and the complete suite with `bun test`.
- Do not put `expect(...)` behind `if`, ternary, logical, or switch branches.
- Split conditional behavior into separate tests, or assert the branch condition and expected value explicitly.

## Bad

```ts
if (result.ok) {
  expect(result.value).toBe("x");
}
```

## Good

```ts
expect(result).toEqual({ ok: true, value: "x" });
```
