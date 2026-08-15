---
name: effect-tests
description: Write focused, deterministic tests for real Ziggy invariants while preserving Effect boundaries. Use when adding or changing tests around typed failures, Layers, cancellation, retries, decoding, or other behavior where a regression would violate a concrete contract.
---

Add a test only when it protects a real invariant. Ziggy does not need test-framework ceremony,
test-only architecture, or coverage-driven duplication.

Core tests live in a parallel `test/` tree that mirrors `src/` (`src/adapters/pi/auth.ts` →
`test/adapters/pi/auth.test.ts`). Import Ziggy source through package exports, the same way Effect
imports `effect/Deferred`, not with `../../`:

```ts
import { makePiAuth } from "ziggy/adapters/pi/auth";
```

`package.json` maps `"./*"` to `"./src/*.ts"`. Extension suites stay in `extensions/*/test/`; tooling
tests stay next to `tooling/`.

## Test the contract

1. Name the invariant that could regress.
2. Exercise the same Effect-shaped consumer path production uses.
3. Replace dependencies with a test Layer when isolation is required; do not bypass the service.
4. Keep time, randomness, networking, and filesystem state deterministic.
5. Assert the complete expected success or typed failure.
6. Run the narrow test first, then the repository's applicable checks.

Tests are allowed execution edges. Production execution still belongs only to
`BunRuntime.runMain` in `src/main.ts`.

## Assert unconditionally

Avoid assertions hidden behind control flow:

```ts
if (result.ok) {
  expect(result.value).toBe("x");
}
```

The test can pass without asserting the intended branch. Assert the whole result:

```ts
expect(result).toEqual({ ok: true, value: "x" });
```

For an Effect failure, inspect the `Exit` and assert the expected tagged case rather than catching
an unknown error and comparing message text:

```ts
const exit = await Effect.runPromiseExit(program);

expect(exit).toEqual(
  Exit.fail(new ProfileNotFound({ path: profilePath })),
);
```

Use the exact `Exit` or Cause API available in the pinned Effect version; do not guess across
Effect releases.

## Preserve service boundaries

A test replacement still returns Effect:

```ts
const SearchClientTest = Layer.succeed(SearchClient, {
  search: (query) => Effect.succeed(query === "ziggy" ? fixtures : []),
});

const result = await Effect.runPromise(
  program.pipe(Effect.provide(SearchClientTest)),
);
```

Do not call a Promise SDK directly from a consumer test. Do not patch `globalThis.fetch`; for the
Telegram adapter, use a focused local fixture or server only when the HTTP invariant itself needs
coverage.

Do not add a test merely to mirror implementation branches, prove TypeScript types, or introduce a
new harness. Prefer the smallest test that would have caught the actual regression.

Use Bun for any focused tests that exist, but follow the repository's current scripts rather than
adding runner setup. Always run `bun run typecheck`, `bun run lint`, and `bun run fmt` after code
changes. When an Effect v4 testing API is uncertain, inspect `vendor/effect`, pinned to
`effect@4.0.0-beta.99`.
