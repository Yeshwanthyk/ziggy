---
name: effect-typed-errors
description: Keep expected Ziggy failures in Effect's typed error channel as Schema.TaggedErrorClass values. Use when changing thrown errors, try/catch, Promise rejection handling, boundary failure mapping, recovery behavior, or domain error definitions.
---

Represent expected failures with `Schema.TaggedErrorClass` and return them through the Effect
error channel. Reserve defects for violated invariants that cannot be handled meaningfully.

## Trace before changing

1. Identify the face, application, domain, filesystem, CLI, or Pi adapter boundary.
2. Find an existing domain error before adding another class.
3. Add a new tagged error only when callers need a distinct recovery, retry, UI, exit, or
   telemetry path.
4. Preserve failure semantics; do not replace a failure with `false`, `undefined`, `[]`, or a
   generic message merely to simplify the type.
5. Keep unknown external causes in a typed error's `cause` field. Do not derive product behavior
   or user copy by probing unknown thrown values.

## Define expected failures

```ts
export class ProfileConfigInvalid extends Schema.TaggedErrorClass<ProfileConfigInvalid>()(
  "ProfileConfigInvalid",
  {
    path: Schema.String,
    cause: Schema.Defect,
  },
) {}
```

Keep fields structured enough for callers to branch without parsing message text.

## Fail from Effect code

In `Effect.gen`, yield the tagged error directly:

```ts
if (profile === undefined) {
  return yield* new ProfileNotFound({ path });
}
```

In combinator code, use `Effect.fail`:

```ts
Option.match(profile, {
  onNone: () => Effect.fail(new ProfileNotFound({ path })),
  onSome: Effect.succeed,
});
```

## Adapt throwing and Promise APIs once

Use `Effect.try` for a synchronous throwing API:

```ts
const url = Effect.try({
  try: () => new URL(value),
  catch: (cause) => new ProfileUrlInvalid({ value, cause }),
});
```

Every Pi SDK Promise is wrapped exactly once with `Effect.tryPromise` inside
`src/adapters/pi/`, the only Pi importer:

```ts
const response = Effect.tryPromise({
  try: (signal) => piSession.prompt(prompt, { signal }),
  catch: (cause) => new PiRequestError({ operation: "prompt", cause }),
});
```

Do not add `.catch`, `Promise.reject`, another `Effect.tryPromise`, or an `await` around the same
Pi operation elsewhere.

## Decode structured input

Use Schema at filesystem and CLI boundaries instead of `JSON.parse` plus `try/catch`:

```ts
const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(InputSchema));

const input = yield* decodeInput(text).pipe(
  Effect.mapError((cause) => new InputInvalid({ source, cause })),
);
```

## Recover by tag

Catch the typed case that has a real recovery path:

```ts
program.pipe(
  Effect.catchTag("ProfileNotFound", (error) =>
    Effect.fail(new CliProfileMissing({ path: error.path })),
  ),
);
```

Do not inspect `_tag` manually or wrap an entire error union into one generic error. Preserve
specific failures unless the new error adds boundary-level product meaning.

## Do not erase expected failures

Avoid `Effect.orDie`, `Effect.die`, `Effect.ignore`, and `Effect.ignoreCause` for expected
failures. Propagate them, translate a specific case, or catch and report an intentionally
best-effort cleanup:

```ts
cleanup.pipe(
  Effect.catch((error) =>
    Effect.logError("Pi cleanup failed", { error }),
  ),
);
```

Use stable user-facing messages. Keep external details in `cause`, logs, or telemetry rather than
`err instanceof Error ? err.message : String(err)`.

When an Effect v4 error API is uncertain, inspect `vendor/effect`, pinned to
`effect@4.0.0-beta.99`, and follow the library's own usage.
