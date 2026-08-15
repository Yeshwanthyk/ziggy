/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type { SlackIngressFileReference } from "ziggy/domain/slack-ingress";
import { MAX_SLACK_IMAGE_BYTES, makeSlackApi } from "ziggy/adapters/slack/api";

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

  test("starts, appends, and stops a DM plan stream with bounded task_update chunks", async () => {
    const requests: Array<{ readonly body: string; readonly url: string }> = [];
    const client = HttpClient.make((request) => {
      requests.push({
        url: request.url,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('{"ok":true,"ts":"2.0"}', { status: 200 }),
        ),
      );
    });
    const api = makeSlackApi(client);
    const longId = `call-${"x".repeat(300)}`;
    const longTitle = `bash ${"y".repeat(300)}`;
    const longDetails = `cmd ${"z".repeat(300)}`;

    const started = await Effect.runPromise(
      api.startStream("bot-secret", "D123", "1.0", {
        chunks: [
          { type: "plan_update", title: "Working" },
          {
            type: "task_update",
            id: longId,
            title: longTitle,
            status: "in_progress",
            details: longDetails,
          },
        ],
      }),
    );
    await Effect.runPromise(
      api.appendStream("bot-secret", "D123", started.ts, [
        { type: "task_update", id: "tool-1", title: "read", status: "complete" },
      ]),
    );
    await Effect.runPromise(api.stopStream("bot-secret", "D123", started.ts));

    expect(started).toEqual({ ts: "2.0" });
    expect(requests).toEqual([
      {
        url: "https://slack.com/api/chat.startStream",
        body: JSON.stringify({
          channel: "D123",
          thread_ts: "1.0",
          task_display_mode: "plan",
          chunks: [
            { type: "plan_update", title: "Working" },
            {
              type: "task_update",
              id: [...longId].slice(0, 32).join(""),
              title: [...longTitle].slice(0, 80).join(""),
              status: "in_progress",
              details: [...longDetails].slice(0, 120).join(""),
            },
          ],
        }),
      },
      {
        url: "https://slack.com/api/chat.appendStream",
        body: JSON.stringify({
          channel: "D123",
          ts: "2.0",
          chunks: [{ type: "task_update", id: "tool-1", title: "read", status: "complete" }],
        }),
      },
      {
        url: "https://slack.com/api/chat.stopStream",
        body: JSON.stringify({ channel: "D123", ts: "2.0" }),
      },
    ]);
  });

  test("includes recipient identity on channel stream starts", async () => {
    const requests: Array<{ readonly body: string; readonly url: string }> = [];
    const client = HttpClient.make((request) => {
      requests.push({
        url: request.url,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('{"ok":true,"ts":"2.0"}', { status: 200 }),
        ),
      );
    });
    const api = makeSlackApi(client);

    await Effect.runPromise(
      api.startStream("bot-secret", "C123", "1.0", {
        chunks: [{ type: "task_update", id: "tool-1", title: "bash", status: "in_progress" }],
        recipientUserId: "U123",
        recipientTeamId: "T1",
      }),
    );

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/chat.startStream",
        body: JSON.stringify({
          channel: "C123",
          thread_ts: "1.0",
          task_display_mode: "plan",
          chunks: [{ type: "task_update", id: "tool-1", title: "bash", status: "in_progress" }],
          recipient_user_id: "U123",
          recipient_team_id: "T1",
        }),
      },
    ]);
  });

  test("classifies a native stream API failure without leaking the token", async () => {
    const secret = "bot-stream-secret";
    const api = makeSlackApi(
      clientFrom(() => new Response('{"ok":false,"error":"invalid_chunks"}', { status: 200 })),
    );

    const result = await Effect.runPromise(
      api.startStream(secret, "D123", "1.0").pipe(Effect.result),
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { operation: "startStream", reason: "api", retriable: false },
    });
    expect(serialized).not.toContain(secret);
  });

  test("retrieves all prior thread replies with cursor pagination", async () => {
    const requests: Array<{ readonly method: string; readonly url: string }> = [];
    const client = HttpClient.make((request) => {
      requests.push({ method: request.method, url: request.url });
      const cursor = new URL(request.url).searchParams.get("cursor");
      const response =
        cursor === null
          ? {
              ok: true,
              messages: [
                { ts: "0.9", user: "U1", text: "parent" },
                {
                  ts: "1.0",
                  bot_id: "B1",
                  text: "first",
                  files: [
                    {
                      id: "F1",
                      name: "parking.png",
                      mimetype: "image/png",
                      size: 123,
                      url_private_download: "https://files.slack.com/files-pri/T-F1/download",
                    },
                  ],
                },
              ],
              response_metadata: { next_cursor: "page-2" },
            }
          : {
              ok: true,
              messages: [{ ts: "1.1", user: "U2", text: "second" }],
              response_metadata: { next_cursor: "" },
            };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(response), { status: 200 }),
        ),
      );
    });

    const history = await Effect.runPromise(
      makeSlackApi(client).getThreadReplies("bot-secret", "C123", "0.9", "1.2"),
    );

    expect(history).toEqual({
      messages: [
        { ts: "0.9", text: "parent", userId: "U1" },
        {
          ts: "1.0",
          text: "first",
          botId: "B1",
          files: [
            {
              id: "F1",
              name: "parking.png",
              mimeType: "image/png",
              size: 123,
              urlPrivate: "https://files.slack.com/files-pri/T-F1/download",
            },
          ],
        },
        { ts: "1.1", text: "second", userId: "U2" },
      ],
      truncated: false,
    });
    expect(requests).toEqual([
      {
        method: "GET",
        url: "https://slack.com/api/conversations.replies?channel=C123&ts=0.9&latest=1.2&inclusive=false&limit=100",
      },
      {
        method: "GET",
        url: "https://slack.com/api/conversations.replies?channel=C123&ts=0.9&latest=1.2&inclusive=false&limit=100&cursor=page-2",
      },
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

  test("downloads only bounded Slack-hosted images with matching response metadata", async () => {
    const requests: Array<{
      readonly authorization: string | undefined;
      readonly url: string;
    }> = [];
    const client = HttpClient.make((request) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-length": "3", "content-type": "image/png" },
          }),
        ),
      );
    });
    const api = makeSlackApi(client);

    const result = await Effect.runPromise(
      api.downloadFile("bot-secret", {
        id: "F1",
        mimeType: "image/png",
        size: 3,
        urlPrivate: "https://files.slack.com/files-pri/T-F1/download",
      }),
    );

    expect(result).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
    expect(requests).toEqual([
      {
        url: "https://files.slack.com/files-pri/T-F1/download",
        authorization: "Bearer bot-secret",
      },
    ]);

    const guarded = await Effect.runPromise(
      Effect.all([
        api
          .downloadFile("bot-secret", {
            id: "F2",
            mimeType: "application/pdf",
            size: 3,
            urlPrivate: "https://files.slack.com/files-pri/T-F2/download",
          })
          .pipe(Effect.result),
        api
          .downloadFile("bot-secret", {
            id: "F3",
            mimeType: "image/png",
            size: MAX_SLACK_IMAGE_BYTES + 1,
            urlPrivate: "https://files.slack.com/files-pri/T-F3/download",
          })
          .pipe(Effect.result),
        api
          .downloadFile("bot-secret", {
            id: "F4",
            mimeType: "image/png",
            size: 3,
            urlPrivate: "https://files.slack.com.evil.test/private-secret",
          })
          .pipe(Effect.result),
      ]),
    );
    expect(guarded.map((item) => item._tag)).toEqual(["Failure", "Failure", "Failure"]);
    expect(requests).toHaveLength(1);
  });

  test("redacts credentials and private URLs from denied file downloads", async () => {
    const token = "bot-super-secret";
    const url = "https://files.slack.com/files-pri/T-private/download-secret";
    const api = makeSlackApi(clientFrom(() => new Response("missing_scope", { status: 403 })));

    const result = await Effect.runPromise(
      api
        .downloadFile(token, { id: "F1", mimeType: "image/png", size: 3, urlPrivate: url })
        .pipe(Effect.result),
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { operation: "downloadFile", reason: "authentication", status: 403 },
    });
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(url);
    expect(serialized).not.toContain("download-secret");
  });

  test("rejects mismatched response MIME and oversized Content-Length before reading", async () => {
    const file: SlackIngressFileReference = {
      id: "F1",
      mimeType: "image/png",
      size: 3,
      urlPrivate: "https://files.slack.com/files-pri/T-F1/download",
    };
    const mismatch = makeSlackApi(
      clientFrom(
        () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-length": "3", "content-type": "image/jpeg" },
          }),
      ),
    );
    const oversized = makeSlackApi(
      clientFrom(
        () =>
          new Response(null, {
            status: 200,
            headers: {
              "content-length": String(MAX_SLACK_IMAGE_BYTES + 1),
              "content-type": "image/png",
            },
          }),
      ),
    );

    const results = await Effect.runPromise(
      Effect.all([
        mismatch.downloadFile("secret", file).pipe(Effect.result),
        oversized.downloadFile("secret", file).pipe(Effect.result),
      ]),
    );

    expect(results).toMatchObject([
      { _tag: "Failure", failure: { operation: "downloadFile", reason: "api" } },
      { _tag: "Failure", failure: { operation: "downloadFile", reason: "api" } },
    ]);
  });

  test("bounds a streamed file body when Content-Length is absent", async () => {
    const chunk = new Uint8Array(3 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const api = makeSlackApi(
      clientFrom(
        () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      ),
    );

    const result = await Effect.runPromise(
      api
        .downloadFile("secret", {
          id: "F1",
          mimeType: "image/png",
          size: 3,
          urlPrivate: "https://files.slack.com/files-pri/T-F1/download",
        })
        .pipe(Effect.result),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { operation: "downloadFile", reason: "api" },
    });
  });
});
