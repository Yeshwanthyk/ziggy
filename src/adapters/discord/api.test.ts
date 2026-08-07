/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Result } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/unstable/http";
import { makeDiscordApi } from "./api";

const clientFrom = (response: () => Response): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response())),
  );

describe("Discord HTTP adapter", () => {
  test("classifies rate limits from status, header, and body", async () => {
    const api = makeDiscordApi(
      clientFrom(
        () =>
          new Response('{"retry_after":2.5}', {
            status: 429,
            headers: { "retry-after": "8" },
          }),
      ),
    );

    const result = await Effect.runPromise(api.getGatewayBot("secret").pipe(Effect.result));

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "DiscordApiError",
        operation: "getGatewayBot",
        reason: "rate-limited",
        retriable: true,
        status: 429,
        retryAfterSeconds: 2.5,
      },
    });
  });

  test("maps malformed success bodies to a non-retriable decode failure", async () => {
    const api = makeDiscordApi(clientFrom(() => new Response("{}", { status: 200 })));

    const result = await Effect.runPromise(api.getGatewayBot("secret").pipe(Effect.result));

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "invalid-response", retriable: false, status: 200 },
    });
  });

  test("aborts the injected HttpClient request when interrupted", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = HttpClient.make((_request, _url, signal) => {
      requestSignal = signal;
      return Effect.never;
    });
    const api = makeDiscordApi(client);

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* api.getGatewayBot("secret").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(requestSignal?.aborted).toBe(true);
  });

  test("redacts credentials from transport failures", async () => {
    const secret = "token/with-value";
    const client = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: new Error(`failed for ${secret} and ${encodeURIComponent(secret)}`),
          }),
        }),
      ),
    );
    const api = makeDiscordApi(client);

    const result = await Effect.runPromise(api.getGatewayBot(secret).pipe(Effect.result));

    expect(Result.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(encodeURIComponent(secret));
  });
});
