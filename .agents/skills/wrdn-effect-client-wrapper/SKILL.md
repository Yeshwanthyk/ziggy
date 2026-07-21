---
name: wrdn-effect-client-wrapper
description: Wrap Promise-based third-party clients at an adapter boundary and expose Effect-shaped service methods. Use when lint flags Promise-returning Client or exported Sdk interfaces.
---

You fix one boundary pattern: domain-facing client interfaces expose `Promise`, allowing untyped rejection and bypassing Ziggy's Effect service graph.

Keep the third-party SDK and its Promise API inside an adapter. Convert each Promise once with `Effect.tryPromise`, map rejection into a typed `Schema.TaggedErrorClass`, and expose named methods that return `Effect.Effect`.

This repo uses Bun and Effect `4.0.0-beta.99`. Before changing Context, Layer, Schema, or concurrency code, fetch and inspect the pinned Effect source as required by `AGENTS.md`.

## Trace before changing

1. Find the `Client` or exported `Sdk` interface reported by lint.
2. Identify the third-party Promise call and the adapter that owns it.
3. Find the existing tagged error and production service Layer before adding new ones.
4. Preserve the live and test call graph. Tests may replace the SDK adapter, but must not add a test-only route around Runtime ingress or the production service.
5. Expose named domain operations when callers need a stable contract. Use a generic `use` method only for a low-level adapter whose sole job is normalizing one SDK.

## Preferred shape

```ts
import { Context, Effect, Layer, Schema } from "effect";

export class ClientRequestError extends Schema.TaggedErrorClass<ClientRequestError>()(
  "ClientRequestError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
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
    }).pipe(Effect.withSpan("SearchClient.search")),
});

export const SearchClientLive = Layer.effect(
  SearchClient,
  Effect.gen(function* () {
    const sdk = yield* ThirdPartySdkAdapter;
    return makeSearchClient(sdk);
  }),
);
```

The example uses APIs present in the pinned Effect version: `Context.Service`, `Schema.TaggedErrorClass`, `Effect.tryPromise`, `Effect.withSpan`, and `Layer.effect`.

## Bad

```ts
export interface SearchClient {
  readonly search: (query: string) => Promise<ReadonlyArray<SearchResult>>;
}
```

```ts
const results = await sdk.search(query).catch(() => []);
```

Both forms leak Promise failure semantics into domain code. The second also changes failure into a successful empty result.

## Generic adapter variation

A narrow SDK adapter may expose `use` when named operations would only duplicate the entire third-party surface:

```ts
export interface VendorSdkShape {
  readonly use: <A>(
    operation: string,
    run: (sdk: VendorSdk, signal: AbortSignal) => PromiseLike<A>,
  ) => Effect.Effect<A, ClientRequestError>;
}

const makeVendorSdk = (sdk: VendorSdk): VendorSdkShape => ({
  use: (operation, run) =>
    Effect.tryPromise({
      try: (signal) => run(sdk, signal),
      catch: (cause) => new ClientRequestError({ operation, cause }),
    }).pipe(Effect.withSpan(`VendorSdk.${operation}`)),
});
```

Do not expose the raw SDK on the service shape. Keep SDK-specific types and Promise behavior inside the adapter.

## Error design

- Reuse a nearby domain error when it already represents the recovery path.
- Add a distinct tagged error only when callers need different recovery, retry, status, UI, or telemetry behavior.
- Preserve the original rejected value as `cause`; do not inspect unknown `.message` fields for domain behavior.
- Do not add fallback values merely to eliminate a Promise rejection.
- Put retry policy at the adapter or operation boundary only when the operation is safe to retry.

## Tests

Provide the same `SearchClient` service key to tests with a replacement Layer whose methods still return `Effect`. Do not let tests call the Promise SDK directly or bypass the production consumer path.

After editing, run the repo's Bun lint, formatting, typecheck, test, and build gates required by `AGENTS.md`.
