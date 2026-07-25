---
name: effect-schema-boundaries
description: Decode unknown filesystem and CLI input once with Effect Schema before it enters Ziggy's typed domain. Use when changing file parsing, command input, environment input, JSON decoding, or code that probes or asserts unknown shapes.
---

Parse external data once at the filesystem or CLI boundary. After decoding, pass typed values
through faces, application services, and domain code without repeated assertions or shape probes.

## Boundary workflow

1. Define the schema next to the boundary-owned data contract.
2. Compile `Schema.decodeUnknownEffect(MySchema)` once at module scope.
3. For JSON text, compose `Schema.fromJsonString(MySchema)` before compiling the decoder.
4. Map parse failures into the boundary's expected `Schema.TaggedErrorClass`.
5. Pass only decoded values into the application layer.

Good:

```ts
const ProfileConfig = Schema.Struct({
  name: Schema.String,
  model: Schema.String,
});

const decodeProfileConfig = Schema.decodeUnknownEffect(ProfileConfig);

const config = yield* decodeProfileConfig(raw);
```

For filesystem JSON:

```ts
const decodeProfileConfigJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProfileConfig),
);

const config = yield* decodeProfileConfigJson(rawText);
```

Translate the parse error without leaking `ParseError` into a domain contract:

```ts
const config = yield* decodeProfileConfigJson(rawText).pipe(
  Effect.mapError(
    (cause) => new ProfileConfigInvalid({ path: configPath, cause }),
  ),
);
```

Bad:

```ts
const config = JSON.parse(rawText) as { name: string; model: string };
```

```ts
const config = raw as unknown as ProfileConfig;
```

```ts
if ("model" in value && typeof value.model === "string") {
  // repeated boundary probing
}
```

Avoid `JSON.parse`, double casts, inline object assertions, `as Record<string, unknown>`,
`"field" in value`, and `Reflect.get` for boundary data. A named type guard is acceptable only
when schema decoding is not the right abstraction and the guard has a precise return type.

CLI arguments and environment values are external input even when TypeScript types them as
`string` or `string | undefined`; validate their domain shape before application orchestration.

When an Effect Schema API is uncertain, inspect `vendor/effect`, pinned to
`effect@4.0.0-beta.99`, and follow the library's own usage.
