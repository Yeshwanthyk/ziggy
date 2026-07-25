---
name: typescript-type-safety
description: Remove TypeScript escape hatches and repair the boundary that caused them. Use when changing code with @ts-nocheck, @ts-ignore, broad assertions, any, non-null assertions, or unchecked unknown external data.
---

Fix the local type or boundary instead of disabling TypeScript. Keep unknown data unknown until it
is decoded, and keep expected failures in Effect's typed error channel.

## Trace before changing

1. Identify the exact expression TypeScript cannot prove.
2. Decide whether the problem is external data, a throwing or Promise API, a duplicated type, or
   an imprecise local helper.
3. Repair the narrowest owning boundary.
4. Remove the escape hatch and let `bun run typecheck` prove the result.

For unknown filesystem, CLI, environment, JSON, or HTTP input, decode once with Effect Schema:

```ts
const decodeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ConfigSchema),
);

const config = yield* decodeConfig(text).pipe(
  Effect.mapError((cause) => new ConfigInvalid({ path, cause })),
);
```

Avoid:

```ts
const config = JSON.parse(text) as Config;
const value = input as unknown as Config;
```

For narrowing internal unions, use the discriminant TypeScript already knows:

```ts
switch (result._tag) {
  case "Ready":
    return result.value;
  case "Unavailable":
    return yield* new ProviderUnavailable({ provider: result.provider });
}
```

Do not use `!` to hide a missing-state path. Model optionality, validate the invariant, or return a
typed `Schema.TaggedErrorClass`.

## Keep casts narrow

When an external library's declarations cannot express a verified invariant, isolate the cast at
the adapter boundary and document that invariant:

```ts
// The SDK guarantees bytes for successful binary responses.
const bytes = response.body as Uint8Array;
```

Do not spread the asserted type through application or domain code. `src/adapters/pi/` is the only
Pi importer, so Pi-specific type repair stays there.

Remove broad bypasses such as `@ts-nocheck`, `@ts-ignore`, `any`, double casts, and whole-object
assertions. Use `@ts-expect-error` only for a deliberate compile-time test whose expected error is
the subject of that test.

Prefer schema-derived types for decoded data and `ReturnType`-derived types for single-owner
runtime objects. Do not create a duplicate interface solely to make an assertion compile.

Run `bun run typecheck`, `bun run lint`, and `bun run fmt`. When Effect v4 typing is uncertain,
inspect `vendor/effect`, pinned to `effect@4.0.0-beta.99`, and align with the library's own usage.
