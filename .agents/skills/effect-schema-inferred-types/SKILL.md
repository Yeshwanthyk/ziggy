---
name: effect-schema-inferred-types
description: Derive TypeScript data types from the Effect Schema that owns their runtime shape. Use when an interface or type alias duplicates fields already defined by Schema.Struct, Schema.Union, Schema.TaggedStruct, Schema.Record, or another nearby schema.
---

Define a runtime data shape once. When Effect Schema owns decoding or validation, export its
TypeScript type from the schema instead of maintaining a parallel interface.

## Trace before changing

1. Find the runtime schema.
2. Find a manual interface or object type that repeats its fields, optionality, or literals.
3. Check importers and preserve the exported type name.
4. Confirm the schema is truly the source of truth. If the two shapes differ, resolve the
   contract mismatch before inferring.
5. Keep a private recursive helper only when TypeScript needs one for `Schema.suspend`.

## Preferred shape

```ts
export const TelegramGatewayConfig = Schema.Struct({
  token: Schema.String,
  allowedChatId: Schema.Number,
});

export type TelegramGatewayConfig = typeof TelegramGatewayConfig.Type;
```

The value and type may share a name because TypeScript keeps value and type namespaces separate.
If naming the schema explicitly is clearer, keep the public type stable:

```ts
export const StoredSourceSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  headers: Schema.Array(HeaderSchema),
});

export type StoredSource = typeof StoredSourceSchema.Type;
```

## Avoid duplicated shapes

```ts
export interface StoredSource {
  readonly id: string;
  readonly url: string;
  readonly headers: ReadonlyArray<Header>;
}

export const StoredSourceSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  headers: Schema.Array(HeaderSchema),
});
```

The static and decoded shapes can drift independently.

For a transformation built with `Schema.decodeTo`, infer the domain type from the decoded schema,
not the raw transport schema.

## Recursive schemas

```ts
interface TypeRefRecursive {
  readonly kind: string;
  readonly ofType: TypeRefRecursive | null;
}

const TypeRefSchema: Schema.Codec<TypeRefRecursive> = Schema.Struct({
  kind: Schema.String,
  ofType: Schema.NullOr(Schema.suspend(() => TypeRefSchema)),
});

export type TypeRef = typeof TypeRefSchema.Type;
```

The helper exists only to type the recursive definition; consumers still use the schema-derived
export.

Do not replace intentional domain-only types, authored input contracts, branded IDs, or opaque
aliases that do not duplicate an object schema. For runtime values rather than schemas, use a
`ReturnType`-derived value type.

When an Effect Schema v4 type API is uncertain, inspect `vendor/effect`, pinned to
`effect@4.0.0-beta.99`, and follow the library's own usage.
