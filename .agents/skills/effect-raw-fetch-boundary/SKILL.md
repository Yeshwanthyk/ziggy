---
name: effect-raw-fetch-boundary
description: Keep Ziggy's sole raw fetch use inside the Telegram HTTP adapter and expose typed Effects above it. Use when changing src/adapters/telegram/api.ts, adding Telegram operations, or finding fetch, Response, or network failures outside that boundary.
---

`src/adapters/telegram/api.ts` is Ziggy's one raw-fetch boundary. Keep `fetch`, `Response`, token
handling, HTTP classification, and response decoding there. Application and domain code consume
typed Effect operations, not ambient HTTP APIs.

## Boundary workflow

1. Confirm the call belongs to Telegram's API adapter. Do not create another raw-fetch boundary.
2. Wrap `fetch` exactly once with `Effect.tryPromise` and pass its cancellation signal.
3. Reduce the ambient response to a small adapter-owned value before returning from the wrapper.
4. Map network rejection into `TelegramApiError`.
5. Decode response text with Effect Schema and classify status or envelope failures explicitly.
6. Redact the bot token from stored causes, messages, logs, and telemetry.

Use the existing adapter as the canonical shape:

```ts
interface RawResponse {
  readonly status: number;
  readonly body: string;
}

const request = (
  token: string,
  operation: TelegramApiOperation,
  body: object,
): Effect.Effect<RawResponse, TelegramApiError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(
        `https://api.telegram.org/bot${encodeURIComponent(token)}/${operation}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
      );
      return { status: response.status, body: await response.text() };
    },
    catch: (cause) => apiError(operation, "network", true, cause, token),
  });
```

Compile the decoder once and translate parse failures into the adapter's tagged error:

```ts
const decodeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([Success, TelegramFailure])),
);

const envelope = yield* decodeResponse(response.body).pipe(
  Effect.mapError((cause) => invalidResponse(operation, response, cause, token)),
);
```

## Keep above the boundary

Expose operations such as:

```ts
export const sendMessage = (
  token: string,
  chatId: number,
  text: string,
): Effect.Effect<void, TelegramApiError> => request(/* ... */);
```

Do not expose `fetch`, `Response`, `typeof globalThis.fetch`, or Promise-returning HTTP methods.
Do not patch `globalThis.fetch` in tests. Test real invariants through the adapter's Effect
contract with a focused fixture or local server only when that behavior warrants a test.

Do not import Pi packages here; `src/adapters/pi/` remains the only Pi importer. Do not execute
the Effect here; `BunRuntime.runMain` in `src/main.ts` is the only production execution edge.

When an Effect v4 or Schema API is uncertain, inspect `vendor/effect`, pinned to
`effect@4.0.0-beta.99`, and follow the library's own usage.
