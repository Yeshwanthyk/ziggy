/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Result } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { isDiscordAttachmentUrl, makeDiscordApi } from "ziggy/adapters/discord/api";

const clientFrom = (response: () => Response): HttpClient.HttpClient =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response())));

describe("Discord HTTP adapter", () => {
  test("idempotently registers Ziggy slash commands and responds ephemerally", async () => {
    const requests: Array<{
      readonly method: string;
      readonly url: string;
      readonly authorization: string | undefined;
      readonly body: string;
    }> = [];
    const client = HttpClient.make((request) => {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      if (request.url.endsWith("/oauth2/applications/@me")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('{"id":"app-1"}', { status: 200 })),
        );
      }
      if (request.url.endsWith("/applications/app-1/commands") && request.method === "GET") {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify([
                {
                  id: "status-id",
                  name: "status",
                  type: 1,
                  description: "Show this Ziggy conversation's state",
                  integration_types: [0],
                  contexts: [0, 1],
                },
                {
                  id: "legacy-global-id",
                  name: "kiri-status",
                  type: 1,
                  description: "Legacy Kiri status",
                },
                {
                  id: "unrelated-global-id",
                  name: "weather",
                  type: 1,
                  description: "Unrelated command",
                },
              ]),
              { status: 200 },
            ),
          ),
        );
      }
      if (
        request.url.endsWith("/applications/app-1/guilds/guild-1/commands") &&
        request.method === "GET"
      ) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify([
                {
                  id: "legacy-guild-id",
                  name: "kiri-queue",
                  type: 1,
                  description: "Legacy Kiri queue",
                },
                {
                  id: "unrelated-guild-id",
                  name: "deploy",
                  type: 1,
                  description: "Unrelated guild command",
                },
              ]),
              { status: 200 },
            ),
          ),
        );
      }
      if (request.url.endsWith("/applications/app-1/commands")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ id: "stop-id", ...JSON.parse(body) }), { status: 201 }),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
      );
    });
    const api = makeDiscordApi(client);

    await Effect.runPromise(api.ensureCommands("bot-secret", ["guild-1", "guild-1"]));
    await Effect.runPromise(
      api.respondToInteraction("interaction-1", "interaction-secret", "Active: 0 · queued: 0."),
    );

    expect(requests).toHaveLength(7);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "https://discord.com/api/v10/oauth2/applications/@me",
      authorization: "Bot bot-secret",
    });
    expect(requests[1]).toMatchObject({
      method: "GET",
      url: "https://discord.com/api/v10/applications/app-1/commands",
      authorization: "Bot bot-secret",
    });
    expect(requests[2]).toMatchObject({
      method: "DELETE",
      url: "https://discord.com/api/v10/applications/app-1/commands/legacy-global-id",
      authorization: "Bot bot-secret",
    });
    expect(requests[3]).toMatchObject({
      method: "GET",
      url: "https://discord.com/api/v10/applications/app-1/guilds/guild-1/commands",
      authorization: "Bot bot-secret",
    });
    expect(requests[4]).toMatchObject({
      method: "DELETE",
      url: "https://discord.com/api/v10/applications/app-1/guilds/guild-1/commands/legacy-guild-id",
      authorization: "Bot bot-secret",
    });
    expect(requests[5]).toMatchObject({
      method: "POST",
      url: "https://discord.com/api/v10/applications/app-1/commands",
      authorization: "Bot bot-secret",
      body: JSON.stringify({
        name: "stop",
        type: 1,
        description: "Stop work in this Ziggy conversation",
        integration_types: [0],
        contexts: [0, 1],
      }),
    });
    expect(requests[6]).toMatchObject({
      method: "POST",
      url: "https://discord.com/api/v10/interactions/interaction-1/interaction-secret/callback",
      authorization: undefined,
      body: JSON.stringify({
        type: 4,
        data: {
          content: "Active: 0 · queued: 0.",
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      }),
    });
  });

  test("uses Discord-native threads, message delivery, reactions, and typing", async () => {
    const requests: Array<{
      readonly method: string;
      readonly url: string;
      readonly body: string;
    }> = [];
    const client = HttpClient.make((request) => {
      requests.push({
        method: request.method,
        url: request.url,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      });
      const responseBody = request.url.endsWith("/threads")
        ? '{"id":"m1","type":11,"guild_id":"g1","parent_id":"c1"}'
        : request.url.endsWith("/typing") || request.url.includes("/reactions/")
          ? null
          : '{"id":"reply1"}';
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(responseBody, { status: responseBody === null ? 204 : 200 }),
        ),
      );
    });
    const api = makeDiscordApi(client);

    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const thread = yield* api.startThreadFromMessage("secret", "c1", "m1", "A request");
        expect(thread).toMatchObject({ id: "m1", type: 11, parent_id: "c1" });
        const created = yield* api.createMessage("secret", "m1", "Working on that…");
        yield* api.updateMessage("secret", "m1", created.id, "Done");
        yield* api.triggerTyping("secret", "m1");
        yield* api.addReaction("secret", "c1", "m1", "👀");
        yield* api.removeReaction("secret", "c1", "m1", "👀");
        return created;
      }),
    );

    expect(receipt).toEqual({ id: "reply1" });
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://discord.com/api/v10/channels/c1/messages/m1/threads",
        body: JSON.stringify({ name: "A request", auto_archive_duration: 1440 }),
      },
      {
        method: "POST",
        url: "https://discord.com/api/v10/channels/m1/messages",
        body: JSON.stringify({
          content: "Working on that…",
          allowed_mentions: { parse: [] },
        }),
      },
      {
        method: "PATCH",
        url: "https://discord.com/api/v10/channels/m1/messages/reply1",
        body: JSON.stringify({ content: "Done", allowed_mentions: { parse: [] } }),
      },
      {
        method: "POST",
        url: "https://discord.com/api/v10/channels/m1/typing",
        body: "",
      },
      {
        method: "PUT",
        url: `https://discord.com/api/v10/channels/c1/messages/m1/reactions/${encodeURIComponent("👀")}/@me`,
        body: "",
      },
      {
        method: "DELETE",
        url: `https://discord.com/api/v10/channels/c1/messages/m1/reactions/${encodeURIComponent("👀")}/@me`,
        body: "",
      },
    ]);
  });

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

  test("downloads only bounded Discord CDN images with matching metadata", async () => {
    const urls: Array<string> = [];
    const api = makeDiscordApi(
      HttpClient.make((request) => {
        urls.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              headers: { "content-type": "image/png", "content-length": "3" },
            }),
          ),
        );
      }),
    );
    const url = "https://cdn.discordapp.com/attachments/1/2/image.png?ex=signed";

    expect(
      await Effect.runPromise(
        api.downloadAttachment({
          id: "attachment-1",
          filename: "image.png",
          mimeType: "image/png",
          size: 3,
          url,
        }),
      ),
    ).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
    expect(urls).toEqual([url]);
    expect(isDiscordAttachmentUrl("https://media.discordapp.net/attachments/1/2/image.png")).toBe(
      true,
    );
    expect(isDiscordAttachmentUrl("https://example.com/attachments/1/2/image.png")).toBe(false);
  });

  test("rejects untrusted attachment URLs and response type mismatches", async () => {
    let requests = 0;
    const api = makeDiscordApi(
      HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(new Uint8Array([1]), {
              status: 200,
              headers: { "content-type": "text/plain" },
            }),
          ),
        );
      }),
    );
    const untrusted = await Effect.runPromise(
      api
        .downloadAttachment({
          id: "attachment-1",
          mimeType: "image/png",
          size: 1,
          url: "https://example.com/attachments/1/2/image.png",
        })
        .pipe(Effect.result),
    );
    expect(Result.isFailure(untrusted) && untrusted.failure.reason).toBe("rejected");
    expect(requests).toBe(0);

    const mismatch = await Effect.runPromise(
      api
        .downloadAttachment({
          id: "attachment-2",
          mimeType: "image/png",
          size: 1,
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
        })
        .pipe(Effect.result),
    );
    expect(Result.isFailure(mismatch) && mismatch.failure.reason).toBe("rejected");
    expect(requests).toBe(1);
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
