---
name: effect-client-wrapper
description: Wrap Promise-based third-party clients at Ziggy adapter boundaries and expose Effect-shaped services. Use when adding an SDK client, changing a client service, or finding Promise-returning methods that leak into application or domain code.
---

Keep third-party clients and their Promise behavior inside adapters. Convert each Promise once
with `Effect.tryPromise`, map rejection into a typed `Schema.TaggedErrorClass`, and expose named
methods returning `Effect.Effect`.

## Trace the boundary

1. Find the third-party call and the adapter that owns it.
2. Reuse an existing tagged error and service before adding new types.
3. Keep SDK-specific inputs, outputs, and Promise failures out of application and domain code.
4. Preserve one production path. A test may replace the service Layer, but should exercise the
   same consumer contract.
5. Let `BunRuntime.runMain` in `src/main.ts` remain the only production execution edge.

`src/adapters/pi/` is the only code allowed to import Pi packages. Never move a Pi import into a
service merely to make wrapping convenient.

## Preferred shape

```ts
import { Context, Effect, Layer, Schema } from "effect";

export class ClientRequestError extends Schema.TaggedErrorClass<ClientRequestError>()(
  "ClientRequestError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface SearchClientShape {
  readonly search: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<SearchResult>, ClientRequestError>;
}

export class SearchClient extends Context.Service<SearchClient, SearchClientShape>()(
  "ziggy/SearchClient",
) {}

const makeSearchClient = (sdk: ThirdPartySdk): SearchClientShape => ({
  search: (query) =>
    Effect.tryPromise({
      try: (signal) => sdk.search({ query, signal }),
      catch: (cause) => new ClientRequestError({ operation: "search", cause }),
    }),
});

export const SearchClientLive = Layer.effect(
  SearchClient,
  Effect.gen(function* () {
    const sdk = yield* ThirdPartySdkAdapter;
    return makeSearchClient(sdk);
  }),
);
```

Use named operations when they form Ziggy's stable contract. A low-level adapter may instead
offer a generic `use` operation when named methods would duplicate an entire SDK:

```ts
interface VendorSdkShape {
  readonly use: <A>(
    operation: string,
    run: (sdk: VendorSdk, signal: AbortSignal) => PromiseLike<A>,
  ) => Effect.Effect<A, ClientRequestError>;
}
```

Do not expose the raw SDK from the service shape.

## Avoid

```ts
interface SearchClient {
  readonly search: (query: string) => Promise<ReadonlyArray<SearchResult>>;
}

const results = await sdk.search(query).catch(() => []);
```

These leak untyped rejection and turn failure into successful empty data.

Keep retry policy at the operation boundary and only for operations safe to retry. Preserve the
rejected value as `cause`; do not inspect unknown message fields to drive product behavior.

When an Effect v4 client, Context, or Layer API is uncertain, inspect `vendor/effect`, pinned to
`effect@4.0.0-beta.99`, and follow the library's own usage.
