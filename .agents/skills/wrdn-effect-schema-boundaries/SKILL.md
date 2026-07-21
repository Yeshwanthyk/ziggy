---
name: wrdn-effect-schema-boundaries
description: Normalize unknown or loosely typed data at boundaries with Effect Schema, named guards, or typed adapters. Use when lint flags double casts, inline object assertions, unknown shape probing, or ad hoc property checks on unknown values.
---

You fix one pattern: domain code is asserting or probing an unknown shape instead of parsing it once at the boundary.

## Fix Shape

- Compile decoders once at module scope with `Schema.decodeUnknownEffect(MySchema)`.
- For JSON strings, compose `Schema.fromJsonString(MySchema)` before compiling the decoder.
- Keep domain code typed after the decode; do not keep `unknown` and probe it repeatedly.
- Replace `JSON.parse`, `value as string`, `as unknown as X`, `as Record<string, unknown>`, inline object assertions, `"field" in value`, and `Reflect.get` with a schema, typed adapter, or named guard.
- A named guard is acceptable only when parsing is not the right abstraction and the guard has a precise return type.

## Good

```ts
const ParsedConfig = Schema.Struct({
  endpoint: Schema.String,
});
const decodeConfig = Schema.decodeUnknownEffect(ParsedConfig);

const config = yield * decodeConfig(raw);
```

```ts
const decodeConfigJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ParsedConfig));
const config = yield * decodeConfigJson(rawText);
```

## Bad

```ts
const config = raw as unknown as { endpoint: string };
```

```ts
const config = JSON.parse(rawText) as { endpoint: string };
```

```ts
const pattern = updated.pattern as string;
```
