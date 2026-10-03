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

## Services: one shape

A service holds state, owns a resource, or needs its dependencies built once. Everything else is a
plain function returning `Effect` (parsing frontmatter, a scope table, an id resolver). A lock is a
function (`withFileLock`, `acquireFileLock` in `src/platform/file-lock.ts`), not a service.

Write a service with `Context.Service`'s `make` option, so its shape is inferred and there is no
separate `…Api` interface to keep in sync:

```ts
export class Sessions extends Context.Service<Sessions>()("ziggy/Sessions", {
  make: Effect.gen(function* () {
    const paths = yield* ZiggyPaths;

    const list = Effect.fn("Sessions.list")(function* (target: ProfileTarget) {
      // ...
    });

    return { list } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(ZiggyPathsLive));
}
```

- The service's `layer` provides its own dependencies; `composition.ts` only merges the layers a
  command needs.
- Public methods use `Effect.fn("Service.method")` so failures and traces name their origin.
- Every member is required. Fakes live in `test/harness/`; an optional member means the feature
  is optional, not that a test needed a seam.

## Resources

Anything that must be released (a lease, a lock, an open handle, a socket) is acquired with
`Effect.acquireRelease` in a `Scope`, or `Effect.acquireUseRelease` around one use. Do not hand-roll
release with Promise bridges or `try/finally` around Effects. Serialize with one semaphore per
owner; never hold a registry-wide permit around handle I/O.

## Pi SDK Promise boundary

Pi packages may be imported only in `src/adapters/pi/` and the `[Pi]` files of the tight-core
layout (`ziggy/import-boundaries` enforces it). Wrap each Pi SDK Promise exactly once with
`Effect.tryPromise` there:

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

The one written exception is Pi tool callbacks: Pi calls a tool's `execute` with a Promise. They
go through a single helper in `session/tools.ts` that captures the services with
`Effect.context<R>()` when the runtime is built and runs each tool with
`Effect.runPromiseWith(context)(effect, { signal })`. Until that helper lands, existing callback
bridges stay where they are; do not add new ones.

When an Effect v4 API is uncertain, inspect `vendor/effect`, pinned to
`effect@4.0.0-beta.99`, and follow the library's own usage.
