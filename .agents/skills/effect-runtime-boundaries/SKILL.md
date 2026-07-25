---
name: effect-runtime-boundaries
description: Keep Ziggy's orchestration, capability contracts, asynchronous ownership, and Effect execution at explicit boundaries. Use when changing application or domain services, adapting Pi SDK Promises, or reviewing Effect execution in production code.
---

Keep Ziggy Effect-native throughout its application architecture. Domain and application
capabilities return `Effect.Effect`; faces translate input into application calls; only the
production entrypoint executes the composed program.

## Trace the boundary

1. Identify the face, application service, domain capability, or adapter that owns the operation.
2. Keep orchestration and capability contracts Effect-native, including deterministic workflows.
3. Keep small total calculations as plain expressions or total helper functions inside services
   when wrapping them adds no failure, requirement, resource, scheduling, or observability value.
4. Adapt host or third-party APIs at the narrowest adapter boundary.
5. Return Effects inward and upward. Never execute them from domain, application, or adapter code.

## Application contracts

Bad:

```ts
export async function loadProfile(path: string): Promise<Profile> {
  return readProfile(path);
}
```

Good:

```ts
export const loadProfile = (
  path: string,
): Effect.Effect<Profile, ProfileReadError, ProfileStore> =>
  Effect.gen(function* () {
    const store = yield* ProfileStore;
    return yield* store.read(path);
  });
```

Use plain expressions for small total work within an Effect service:

```ts
const displayName = path.basename(profilePath);

return yield* store.save({ path: profilePath, displayName });
```

Do not move orchestration into Promise-returning helpers or make capability contracts synchronous
to avoid Effect composition.

## Pi SDK Promise boundary

`src/adapters/pi/` is the only code allowed to import Pi packages. Wrap each Pi SDK Promise
exactly once with `Effect.tryPromise` there:

```ts
const request = Effect.tryPromise({
  try: (signal) => piSession.prompt(prompt, { signal }),
  catch: (cause) => new PiRequestError({ operation: "prompt", cause }),
});
```

Do not expose, re-wrap, or await that Promise in a face, application service, or domain module.
Return the adapted Effect from the Pi adapter.

## Production execution edge

Bad:

```ts
export const save = (value: Value): Promise<void> =>
  Effect.runPromise(saveEffect(value));
```

Good:

```ts
export const save = (
  value: Value,
): Effect.Effect<void, SaveError, Store> => saveEffect(value);
```

`BunRuntime.runMain` in `src/main.ts` is the only production execution edge. Do not call
`Effect.runPromise`, `Effect.runPromiseExit`, `Effect.runFork`, `Effect.runSync`, or
`Effect.runSyncExit` elsewhere in production code.

When an Effect v4 API is uncertain, inspect `vendor/effect`, pinned to
`effect@4.0.0-beta.99`, and follow the library's own usage.
