/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeSlackApi } from "./api";

const clientFrom = (response: () => Response): HttpClient.HttpClient =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response())));

describe("Slack HTTP adapter", () => {
  test("decodes connections.open and sends the app token through the adapter", async () => {
    const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> =
      [];
    const client = HttpClient.make((request) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('{"ok":true,"url":"wss://slack.test/socket"}', { status: 200 }),
        ),
      );
    });

    const result = await Effect.runPromise(makeSlackApi(client).connectionsOpen("app-secret"));

    expect(result).toEqual({ url: "wss://slack.test/socket" });
    expect(requests).toEqual([
      {
        url: "https://slack.com/api/apps.connections.open",
        authorization: "Bearer app-secret",
      },
    ]);
  });

  test("classifies HTTP authentication and rate-limit responses", async () => {
    const unauthorized = makeSlackApi(clientFrom(() => new Response("", { status: 401 })));
    const limited = makeSlackApi(
      clientFrom(() => new Response("", { status: 429, headers: { "retry-after": "7" } })),
    );

    const [auth, rateLimit] = await Effect.runPromise(
      Effect.all([
        unauthorized.connectionsOpen("secret").pipe(Effect.result),
        limited.authTest("secret").pipe(Effect.result),
      ]),
    );

    expect(auth).toMatchObject({
      _tag: "Failure",
      failure: { reason: "authentication", retriable: false, status: 401 },
    });
    expect(rateLimit).toMatchObject({
      _tag: "Failure",
      failure: {
        reason: "rate-limited",
        retriable: true,
        status: 429,
        retryAfterSeconds: 7,
      },
    });
  });

  test("rejects malformed connections.open bodies without exposing the token", async () => {
    const secret = "xapp-secret";
    const api = makeSlackApi(clientFrom(() => new Response("not-json", { status: 200 })));

    const result = await Effect.runPromise(api.connectionsOpen(secret).pipe(Effect.result));

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { operation: "connectionsOpen", reason: "decode", retriable: false },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
