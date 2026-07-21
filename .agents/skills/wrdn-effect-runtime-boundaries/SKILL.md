---
name: wrdn-effect-runtime-boundaries
description: Keep asynchronous ownership and Effect execution at explicit runtime boundaries. Use when lint flags native async, Promise types or orchestration, or Effect.runPromise/runFork/runSync inside migrated Ziggy domain code.
---

Fix one boundary pattern: migrated domain code owns native Promise control flow or executes an Effect instead of returning it.

## Trace before changing

1. Identify whether the operation is pure synchronous TypeScript, Effect domain work, or a forced host/third-party adapter.
2. Keep pure synchronous code synchronous. Do not wrap deterministic calculations or data transforms in `Effect.sync` without a failure, service, resource, scheduling, or observability reason.
3. Change asynchronous domain contracts from `Promise<A>` to `Effect.Effect<A, E, R>` with a typed error and explicit requirements.
4. Wrap a forced Promise API once with `Effect.tryPromise` inside the narrow adapter that owns that API.
5. Return Effects through domain and service layers. Execute them only in the approved executable entrypoint or a test adapter.

## Native Promise boundary

Bad:

```ts
export async function loadProfile(path: string): Promise<Profile> {
  return readProfile(path);
}
```

Good:

```ts
export const loadProfile = (path: string): Effect.Effect<Profile, ProfileReadError, FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    return yield* fileSystem.readProfile(path);
  });
```

For a third-party Promise-only API, adapt once:

```ts
const request = Effect.tryPromise({
  try: (signal) => sdk.request({ signal }),
  catch: (cause) => new ProviderRequestError({ cause }),
});
```

Do not expose the Promise through the Provider, Extension, Session, Memory, or daemon contract.

## Effect execution boundary

Bad:

```ts
export const save = (value: Value): Promise<void> => Effect.runPromise(saveEffect(value));
```

Good:

```ts
export const save = (value: Value): Effect.Effect<void, SaveError, Store> => saveEffect(value);
```

Call `Effect.runPromise`, `Effect.runPromiseExit`, `Effect.runFork`, `Effect.runSync`, or `Effect.runSyncExit` only in an explicitly approved executable or test adapter. Do not scatter execution boundaries through domain services.
