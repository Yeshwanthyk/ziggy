---
name: effect-value-inferred-types
description: Derive TypeScript object API types from the runtime factory or value that owns their shape. Use when an interface or type alias mirrors a returned client surface, handler map, route map, or other single-implementation object.
---

Prefer value-first types when one runtime factory owns an object's shape. Name the factory and
export `ReturnType<typeof makeX>` so consumers retain a stable type name without duplicating the
implementation.

## Trace before changing

1. Find the runtime object returned by a named factory or callback.
2. Find the interface or object type repeating its methods and properties.
3. Confirm the object has one implementation. Keep an authored contract when multiple
   implementations intentionally share it.
4. Preserve the exported type name.
5. Use `satisfies` only against an independent boundary contract, not a duplicate of the value.

## Preferred shape

```ts
const makeSearchClient = (context: SearchContext) => {
  const search = (query: string) => Effect.succeed(context.index.lookup(query));
  const clear = Effect.sync(() => context.index.clear());

  return {
    search,
    clear,
  };
};

export type SearchClient = ReturnType<typeof makeSearchClient>;
```

For a curried factory:

```ts
const makeHandler =
  (options: HandlerOptions) =>
  (context: HandlerContext) => ({
    handle: (input: Input) => run(input, options, context),
  });

export type Handler = ReturnType<ReturnType<typeof makeHandler>>;
```

## Avoid

```ts
interface SearchClient {
  readonly search: (query: string) => Effect.Effect<ReadonlyArray<Result>>;
  readonly clear: Effect.Effect<void>;
}

const makeSearchClient = (context: SearchContext) =>
  ({
    search: (query) => Effect.succeed(context.index.lookup(query)),
    clear: Effect.sync(() => context.index.clear()),
  }) satisfies SearchClient;
```

The interface and implementation can drift while appearing to describe the same API.

Do not infer service or dependency interfaces that deliberately support multiple Layers. Keep
public configuration inputs authored when stability is part of the API. Keep branded IDs,
discriminated unions, and small aliases that do not mirror an object value.

If Effect Schema owns the data shape, derive the type from the schema instead. This skill applies
to runtime object APIs, not decoded data models.

After changing a value-derived type, run `bun run typecheck`, `bun run lint`, and `bun run fmt`.
When an Effect v4 type is uncertain, inspect `vendor/effect`, pinned to
`effect@4.0.0-beta.99`.
