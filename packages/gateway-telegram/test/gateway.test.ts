import { describe, expect, test } from "bun:test";
import {
  decodeTelegramCredentials,
  decodeTelegramGatewayConfig,
  makeInboundIdempotency,
  makeTelegramBotApi,
  replayRequestFromResolution,
  resumeHandleFor,
  TelegramApiError,
  telegramSendRequest,
} from "@ziggy/gateway-telegram";
import { makeFakeTelegramBotApi } from "@ziggy/gateway-telegram/testing";
import { decodeGatewayResumeHandle, type GatewayInboundMessage } from "@ziggy/protocol";
import { FakeGatewayAttachPeer } from "@ziggy/protocol/testing";
import { Effect, Exit, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { runEffect } from "../../../tests/testkit/effect.ts";

const decodeJsonBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const normalizedMessage: GatewayInboundMessage = {
  gatewayId: "personal",
  messageId: "20",
  conversation: { chatId: "30", kind: "direct" },
  senderId: "40",
  sentAt: "2023-11-14T22:13:20.000Z",
  text: "hello",
};

const configInput: {
  readonly gatewayId: string;
  readonly resumeGranularity: "conversation";
} = { gatewayId: "personal", resumeGranularity: "conversation" };

describe("Telegram Gateway", () => {
  test("strictly decodes config and credentials with typed redacted failures", async () => {
    await runEffect(
      Effect.gen(function* () {
        expect(yield* decodeTelegramGatewayConfig(configInput)).toEqual({
          ...configInput,
          longPollTimeoutSeconds: 30,
        });
        const configFailure = yield* Effect.exit(
          decodeTelegramGatewayConfig({ ...configInput, extra: true }),
        );
        expect(Exit.isFailure(configFailure)).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              decodeTelegramGatewayConfig({ ...configInput, gatewayId: "x".repeat(513) }),
            ),
          ),
        ).toBe(true);
        const credentialFailure = yield* Effect.exit(
          decodeTelegramCredentials({ botToken: "secret-token", extra: true }),
        );
        expect(Exit.isFailure(credentialFailure)).toBe(true);
        expect(String(credentialFailure)).not.toContain("secret-token");
      }),
    );
  });

  test("maps outgoing delivery and derives resume routes unconditionally", async () => {
    expect(telegramSendRequest({ chatId: "30", threadId: "55" }, "answer", "20")).toEqual({
      chatId: "30",
      threadId: "55",
      text: "answer",
      replyToMessageId: "20",
    });
    const config = await runEffect(decodeTelegramGatewayConfig(configInput));
    const conversation = resumeHandleFor(config, normalizedMessage);
    const peer = resumeHandleFor({ ...config, resumeGranularity: "peer" }, normalizedMessage);
    expect(conversation.route.type).toBe("conversation");
    expect(decodeGatewayResumeHandle(conversation)).toEqual(conversation);
    expect(peer.route.type).toBe("peer");
    const attach = new FakeGatewayAttachPeer();
    const first = attach.resolveSession({ resumeHandle: conversation });
    expect(attach.resolveSession({ resumeHandle: conversation }).streamHandle).toEqual(
      first.streamHandle,
    );
    expect(replayRequestFromResolution(first, 7)).toEqual({
      streamHandle: first.streamHandle,
      sinceSeq: 7,
    });
  });

  test("uses first-accepted-wins idempotency", async () => {
    expect(
      await runEffect(
        Effect.gen(function* () {
          const idempotency = yield* makeInboundIdempotency;
          return [
            yield* idempotency.accept(normalizedMessage),
            yield* idempotency.accept({ ...normalizedMessage, text: "changed" }),
          ];
        }),
      ),
    ).toEqual([true, false]);
  });

  test("fake scripts normalized polls, records sends, and exposes typed failures", async () => {
    await runEffect(
      Effect.gen(function* () {
        const failure = new TelegramApiError({ operation: "getUpdates", message: "failed" });
        const fake = yield* makeFakeTelegramBotApi([
          { type: "poll", result: { nextOffset: 11, messages: [normalizedMessage] } },
          { type: "failure", error: failure },
        ]);
        expect(yield* fake.getUpdates({ offset: 5, timeoutSeconds: 30 })).toEqual({
          nextOffset: 11,
          messages: [normalizedMessage],
        });
        yield* fake.sendMessage({ chatId: "30", text: "answer" });
        expect(yield* fake.sentRequests).toEqual([{ chatId: "30", text: "answer" }]);
        expect(
          Exit.isFailure(yield* Effect.exit(fake.getUpdates({ offset: 11, timeoutSeconds: 30 }))),
        ).toBe(true);
      }),
    );
  });

  test("HTTP transport normalizes supported messages and advances past ignored updates", async () => {
    const bodies: Array<unknown> = [];
    const response = {
      ok: true,
      result: [
        { update_id: 10, channel_post: { text: "ignored" } },
        { update_id: 11, edited_message: { text: "ignored" } },
        {
          update_id: 12,
          message: {
            message_id: 21,
            date: 1_700_000_000,
            chat: { id: 30, type: "channel" },
            from: { id: 40 },
            text: "ignored",
          },
        },
        {
          update_id: 13,
          message: {
            message_id: 22,
            date: 1_700_000_000,
            chat: { id: 31, type: "private" },
            from: { id: 40 },
          },
        },
        {
          update_id: 14,
          message: {
            message_id: 23,
            date: 1_700_000_000,
            chat: { id: 32, type: "private" },
            text: "senderless",
          },
        },
        {
          update_id: 15,
          message: {
            message_id: 20,
            date: 1_700_000_000,
            chat: { id: 30, type: "private" },
            from: { id: 40 },
            text: "hello",
          },
        },
        {
          update_id: 16,
          message: {
            message_id: 24,
            date: 1_700_000_001,
            chat: { id: -100, type: "supergroup" },
            from: { id: 41 },
            text: "thread reply",
            message_thread_id: 55,
            reply_to_message: { message_id: 19, text: "quoted" },
          },
        },
      ],
    };
    const client = recordingClient(bodies, [response]);
    const result = await runEffect(
      Effect.gen(function* () {
        const config = yield* decodeTelegramGatewayConfig(configInput);
        const credentials = yield* decodeTelegramCredentials({ botToken: "token" });
        const api = yield* makeTelegramBotApi(config, credentials);
        return yield* api.getUpdates({ offset: 5, timeoutSeconds: 30 });
      }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(bodies).toEqual([{ offset: 5, timeout: 30, allowed_updates: ["message"] }]);
    expect(result).toEqual({
      nextOffset: 17,
      messages: [
        normalizedMessage,
        {
          gatewayId: "personal",
          messageId: "24",
          conversation: { chatId: "-100", threadId: "55", kind: "group" },
          senderId: "41",
          sentAt: "2023-11-14T22:13:21.000Z",
          text: "thread reply",
          replyTo: { messageId: "19", text: "quoted" },
        },
      ],
    });
  });

  test("HTTP send uses numeric IDs and malformed/API-false responses fail typed", async () => {
    const bodies: Array<unknown> = [];
    const sentMessage = { message_id: 1, date: 1, chat: { id: 30, type: "private" } };
    const client = recordingClient(bodies, [
      { ok: true, result: sentMessage },
      {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 1,
              date: 8_640_000_000_001,
              chat: { id: 30, type: "private" },
              from: { id: 40 },
              text: "invalid date",
            },
          },
        ],
      },
      { ok: false, description: "no" },
      { broken: true },
    ]);
    await runEffect(
      Effect.gen(function* () {
        const config = yield* decodeTelegramGatewayConfig(configInput);
        const credentials = yield* decodeTelegramCredentials({ botToken: "token" });
        const api = yield* makeTelegramBotApi(config, credentials);
        yield* api.sendMessage({ chatId: "30", text: "x", threadId: "55", replyToMessageId: "20" });
        expect(bodies[0]).toEqual({
          chat_id: "30",
          text: "x",
          message_thread_id: 55,
          reply_parameters: { message_id: 20 },
        });
        expect(yield* Effect.flip(api.getUpdates({ offset: 0, timeoutSeconds: 1 }))).toBeInstanceOf(
          TelegramApiError,
        );
        expect(
          Exit.isFailure(yield* Effect.exit(api.getUpdates({ offset: 0, timeoutSeconds: 1 }))),
        ).toBe(true);
        expect(
          Exit.isFailure(yield* Effect.exit(api.getUpdates({ offset: 0, timeoutSeconds: 1 }))),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(api.sendMessage({ chatId: "30", text: "x", threadId: "01" })),
          ),
        ).toBe(true);
      }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );
  });
});

function recordingClient(
  bodies: Array<unknown>,
  responses: ReadonlyArray<unknown>,
): HttpClient.HttpClient {
  let index = 0;
  return HttpClient.make((request) => {
    const body = request.body;
    bodies.push(
      body instanceof HttpBody.Uint8Array
        ? decodeJsonBody(new TextDecoder().decode(body.body))
        : undefined,
    );
    const response = responses[index];
    index += 1;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }),
      ),
    );
  });
}
