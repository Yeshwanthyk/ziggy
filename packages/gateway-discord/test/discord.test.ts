import { describe, expect, test } from "bun:test";
import type { BroadcastTarget, GatewayInboundMessage } from "@ziggy/protocol";
import { FakeGatewayAttachPeer } from "@ziggy/protocol/testing";
import { Effect, Layer, Redacted, Ref } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { runEffect } from "../../../tests/testkit/effect.ts";
import {
  decodeDiscordCredentials,
  decodeDiscordGatewayConfig,
  deliverDiscordBroadcast,
  discordResumeHandle,
  makeDiscordGateway,
  normalizeDiscordDispatch,
  DiscordService,
  type DiscordGatewayConfig,
} from "../src/index.ts";
import { makeFakeDiscordService } from "../src/testing.ts";

const config: DiscordGatewayConfig = {
  gatewayId: "discord-owner-bot",
  resumeBy: "conversation",
};

const directMessage = {
  op: 0,
  t: "MESSAGE_CREATE",
  s: 12,
  d: {
    id: "message-42",
    channel_id: "dm-7",
    author: { id: "user-9", username: "display-name" },
    content: "new question",
    timestamp: "2026-07-23T12:00:00.000Z",
    type: 19,
    attachments: [],
    embeds: [],
    message_reference: { message_id: "message-41" },
    referenced_message: {
      id: "stale-display-id",
      content: "quoted context",
      author: { id: "user-8", username: "other-display-name" },
    },
  },
};

const normalizedDirectMessage: GatewayInboundMessage = {
  gatewayId: "discord-owner-bot",
  messageId: "message-42",
  conversation: { chatId: "dm-7", kind: "direct" },
  senderId: "user-9",
  sentAt: "2026-07-23T12:00:00.000Z",
  text: "new question",
  replyTo: { messageId: "message-41", text: "quoted context" },
};

describe("Discord Gateway configuration", () => {
  test("strictly decodes instance config and redacted credentials", async () => {
    const decodedConfig = await runEffect(decodeDiscordGatewayConfig(config));
    const credentials = await runEffect(decodeDiscordCredentials({ botToken: "secret-token" }));
    expect(decodedConfig).toEqual(config);
    expect(Redacted.value(credentials.botToken)).toBe("secret-token");
    await expect(
      runEffect(decodeDiscordGatewayConfig({ ...config, botToken: "wrong-authority" })),
    ).rejects.toMatchObject({ _tag: "DiscordConfigurationError", source: "config" });
    await expect(
      runEffect(decodeDiscordCredentials({ botToken: "secret-token", gatewayId: "wrong-place" })),
    ).rejects.toMatchObject({ _tag: "DiscordConfigurationError", source: "credentials" });
  });
});

describe("Discord inbound normalization", () => {
  test("keeps service payload and display metadata inside the leaf while retaining reply identity", async () => {
    const normalized = await runEffect(normalizeDiscordDispatch(config, directMessage));
    expect(normalized).toEqual(normalizedDirectMessage);
    expect(Object.keys(normalized ?? {}).sort()).toEqual([
      "conversation",
      "gatewayId",
      "messageId",
      "replyTo",
      "senderId",
      "sentAt",
      "text",
    ]);
  });

  test("ignores edits, guild channels, bot messages, and rich media but fails malformed creates", async () => {
    const ignored = [
      { ...directMessage, t: "MESSAGE_UPDATE" },
      { ...directMessage, d: { ...directMessage.d, guild_id: "guild-1" } },
      {
        ...directMessage,
        d: { ...directMessage.d, author: { ...directMessage.d.author, bot: true } },
      },
      { ...directMessage, d: { ...directMessage.d, attachments: [{ id: "file-1" }] } },
    ];
    expect(
      await Promise.all(
        ignored.map((payload) => runEffect(normalizeDiscordDispatch(config, payload))),
      ),
    ).toEqual([undefined, undefined, undefined, undefined]);
    await expect(
      runEffect(normalizeDiscordDispatch(config, { ...directMessage, d: { id: "incomplete" } })),
    ).rejects.toMatchObject({ _tag: "DiscordInboundError" });
  });

  test("keeps the first accepted normalized identity for a Discord message key", async () => {
    const gateway = await runEffect(makeDiscordGateway(config));
    const first = await runEffect(gateway.acceptDispatch(directMessage));
    const conflicting = await runEffect(
      gateway.acceptDispatch({
        ...directMessage,
        d: { ...directMessage.d, author: { id: "other-user" }, content: "changed" },
      }),
    );
    expect(conflicting).toEqual(first);
  });
});

describe("Discord routing and delivery", () => {
  test("derives resume from route identity and replays only through the returned stream handle", async () => {
    const peer = new FakeGatewayAttachPeer();
    const resumeHandle = discordResumeHandle(config, normalizedDirectMessage);
    const resolved = peer.resolveSession({ resumeHandle });
    peer.append(resolved.streamHandle, [
      {
        schemaVersion: 1,
        seq: 1,
        emittedAt: "2026-07-23T12:00:01.000Z",
        event: {
          type: "turn-started",
          sessionId: resolved.streamHandle.sessionId,
          turnId: "turn-1",
          message: "new question",
          origin: "user",
        },
      },
    ]);
    expect(resumeHandle).toEqual({
      type: "gateway-resume",
      gatewayId: "discord-owner-bot",
      route: { type: "conversation", conversation: { chatId: "dm-7" } },
    });
    expect(peer.stream({ streamHandle: resolved.streamHandle, sinceSeq: 0 }).events).toHaveLength(
      1,
    );
    expect(peer.resolveSession({ resumeHandle }).streamHandle).toEqual(resolved.streamHandle);
  });

  test("maps normalized targets to deterministic Discord sends and delivery outcomes", async () => {
    const fake = await runEffect(makeFakeDiscordService);
    const target: BroadcastTarget = {
      type: "gateway",
      gatewayId: "discord-owner-bot",
      conversation: { chatId: "channel-1", threadId: "thread-2" },
    };
    const delivered = await runEffect(
      deliverDiscordBroadcast("discord-owner-bot", 0, target, "result").pipe(
        Effect.provideService(DiscordService, fake.service),
      ),
    );
    await runEffect(fake.failNextSend);
    const failed = await runEffect(
      deliverDiscordBroadcast("discord-owner-bot", 1, target, "retry").pipe(
        Effect.provideService(DiscordService, fake.service),
      ),
    );
    expect(delivered).toEqual({ ruleIndex: 0, status: "delivered" });
    expect(failed).toEqual({ ruleIndex: 1, status: "failed", code: "target-unavailable" });
    expect(await runEffect(fake.deliveries)).toEqual([
      { messageId: "discord-fixture-1", channelId: "thread-2", content: "result" },
    ]);
  });

  test("sends the safe Discord HTTP request and preserves status failure semantics", async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const captured = yield* Ref.make(HttpClientRequest.get("https://invalid.example"));
        const status = yield* Ref.make(204);
        const client = HttpClient.make((request) =>
          Ref.set(captured, request).pipe(
            Effect.andThen(Ref.get(status)),
            Effect.map((responseStatus) =>
              HttpClientResponse.fromWeb(request, new Response(null, { status: responseStatus })),
            ),
          ),
        );
        const credentials = yield* decodeDiscordCredentials({ botToken: "fixture-token" });
        const layer = DiscordService.layer(credentials).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        );
        const target: BroadcastTarget = {
          type: "gateway",
          gatewayId: "discord-owner-bot",
          conversation: { chatId: "channel/with slash" },
        };
        const delivered = yield* deliverDiscordBroadcast(
          "discord-owner-bot",
          0,
          target,
          "hello @everyone",
        ).pipe(Effect.provide(layer));
        const request = yield* Ref.get(captured);
        const webRequest = yield* HttpClientRequest.toWeb(request);
        const body = yield* Effect.promise(() => webRequest.json());
        yield* Ref.set(status, 400);
        const rejected = yield* deliverDiscordBroadcast("discord-owner-bot", 1, target, "bad").pipe(
          Effect.provide(layer),
        );
        yield* Ref.set(status, 404);
        const missing = yield* deliverDiscordBroadcast(
          "discord-owner-bot",
          2,
          target,
          "missing",
        ).pipe(Effect.provide(layer));
        const transportClient = HttpClient.make((failedRequest) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request: failedRequest }),
            }),
          ),
        );
        const transportLayer = DiscordService.layer(credentials).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, transportClient)),
        );
        const unknown = yield* deliverDiscordBroadcast(
          "discord-owner-bot",
          3,
          target,
          "ambiguous",
        ).pipe(Effect.provide(transportLayer));
        return { delivered, rejected, missing, unknown, webRequest, body };
      }),
    );
    expect(result.delivered).toEqual({ ruleIndex: 0, status: "delivered" });
    expect(result.rejected).toEqual({
      ruleIndex: 1,
      status: "failed",
      code: "delivery-rejected",
    });
    expect(result.missing).toEqual({
      ruleIndex: 2,
      status: "failed",
      code: "target-not-found",
    });
    expect(result.unknown).toEqual({
      ruleIndex: 3,
      status: "failed",
      code: "outcome-unknown",
    });
    expect(result.webRequest.method).toBe("POST");
    expect(result.webRequest.url).toBe(
      "https://discord.com/api/v10/channels/channel%2Fwith%20slash/messages",
    );
    expect(result.webRequest.headers.get("authorization")).toBe("Bot fixture-token");
    expect(result.webRequest.headers.get("user-agent")).toBe(
      "DiscordBot (https://github.com/yeshwanthyk/ziggy, 0.0.0)",
    );
    expect(result.body).toEqual({
      content: "hello @everyone",
      allowed_mentions: { parse: [] },
    });
  });
});
