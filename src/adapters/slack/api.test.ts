/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeSlackApi } from "./api";

const clientFrom = (response: () => Response): HttpClient.HttpClient =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response())));

describe("Slack HTTP adapter", () => {
  test("adds and removes source-message progress reactions", async () => {
    const requests: Array<{ readonly body: string; readonly url: string }> = [];
    const client = HttpClient.make((request) => {
      requests.push({
        url: request.url,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response('{"ok":true}', { status: 200 })),
      );
    });
    const api = makeSlackApi(client);

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* api.addReaction("bot-secret", "C123", "1.0", "eyes");
        yield* api.removeReaction("bot-secret", "C123", "1.0", "eyes");
      }),
    );

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/reactions.add",
        body: JSON.stringify({ channel: "C123", timestamp: "1.0", name: "eyes" }),
      },
      {
        url: "https://slack.com/api/reactions.remove",
        body: JSON.stringify({ channel: "C123", timestamp: "1.0", name: "eyes" }),
      },
    ]);
  });

  test("sets and clears Slack's native assistant thread status", async () => {
    const requestBodies: Array<string> = [];
    const client = HttpClient.make((request) => {
      if (request.body._tag === "Uint8Array") {
        requestBodies.push(new TextDecoder().decode(request.body.body));
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response('{"ok":true}', { status: 200 })),
      );
    });
    const api = makeSlackApi(client);

    await Effect.runPromise(
      Effect.all([
        api.setStatus("bot-secret", "C123", "0.9", "is thinking..."),
        api.setStatus("bot-secret", "C123", "0.9", ""),
      ]),
    );

    expect(requestBodies).toEqual([
      JSON.stringify({
        channel_id: "C123",
        thread_ts: "0.9",
        status: "is thinking...",
      }),
      JSON.stringify({ channel_id: "C123", thread_ts: "0.9", status: "" }),
    ]);
  });

  test("sends agent output as standard Markdown instead of Slack mrkdwn", async () => {
    let requestBody = "";
    const client = HttpClient.make((request) => {
      if (request.body._tag === "Uint8Array") {
        requestBody = new TextDecoder().decode(request.body.body);
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('{"ok":true,"ts":"1.0"}', { status: 200 }),
        ),
      );
    });

    const result = await Effect.runPromise(
      makeSlackApi(client).postMessage("bot-secret", "C123", "**bold**", "0.9"),
    );

    expect(result).toEqual({ ts: "1.0" });
    expect(requestBody).toBe(
      JSON.stringify({
        channel: "C123",
        markdown_text: "**bold**",
        thread_ts: "0.9",
      }),
    );
  });

  test("replaces a visible working message with the final Markdown answer", async () => {
    let requestBody = "";
    const client = HttpClient.make((request) => {
      if (request.body._tag === "Uint8Array") {
        requestBody = new TextDecoder().decode(request.body.body);
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('{"ok":true,"ts":"1.0"}', { status: 200 }),
        ),
      );
    });

    await Effect.runPromise(
      makeSlackApi(client).updateMessage("bot-secret", "C123", "1.0", "**done**"),
    );

    expect(requestBody).toBe(
      JSON.stringify({
        channel: "C123",
        ts: "1.0",
        markdown_text: "**done**",
      }),
    );
  });

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
