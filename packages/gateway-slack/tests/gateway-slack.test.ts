import { describe, expect, it } from "bun:test";
import { gatewayInboundMessageKey, type GatewayInboundMessage } from "@ziggy/protocol";
import { FakeGatewayAttachPeer } from "@ziggy/protocol/testing";
import { Effect, Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { runEffect } from "../../../tests/testkit/effect.ts";
import {
  decodeSlackCredentials,
  decodeSlackGatewayConfig,
  makeSlackGateway,
  makeSlackWebApi,
  slackResumeHandle,
  type SlackGatewayConfig,
} from "../src/index.ts";
import { makeFakeSlackService } from "../src/testing.ts";

const config: SlackGatewayConfig = {
  gatewayId: "slack-owner",
  resumeGranularity: "conversation",
};
const botToken = ["xox", "b-test-token"].join("");
const directMessage = {
  event: {
    type: "message",
    channel: "D123",
    channel_type: "im",
    user: "U123",
    ts: "1700000000.123456",
    text: "hello",
    team: "T123",
    client_msg_id: "client-message-123",
  },
};

describe("Slack Gateway configuration", () => {
  it("strictly decodes config and redacted bot credentials", async () => {
    const decoded = await runEffect(decodeSlackGatewayConfig(config));
    const credentials = await runEffect(decodeSlackCredentials({ botToken }));

    expect(decoded).toEqual(config);
    expect(String(credentials.botToken)).not.toContain("test-token");
  });

  it("rejects unknown config fields and malformed credentials", async () => {
    const configExit = await runEffect(
      Effect.exit(decodeSlackGatewayConfig({ ...config, accountName: "display-only" })),
    );
    const credentialsExit = await runEffect(
      Effect.exit(decodeSlackCredentials({ botToken: "not-a-bot-token" })),
    );

    expect(Exit.isFailure(configExit)).toBe(true);
    expect(Exit.isFailure(credentialsExit)).toBe(true);
  });
});

describe("Slack inbound normalization", () => {
  it("maps direct text without leaking Slack display metadata", async () => {
    const service = await runEffect(makeFakeSlackService());
    const gateway = await runEffect(makeSlackGateway(config, service));
    const accepted = await runEffect(gateway.acceptInbound(directMessage));

    expect(accepted).toEqual({
      status: "accepted",
      message: {
        gatewayId: "slack-owner",
        messageId: "1700000000.123456",
        conversation: { chatId: "D123", kind: "direct" },
        senderId: "U123",
        sentAt: "2023-11-14T22:13:20.123Z",
        text: "hello",
      },
    });
  });

  it("requires quoted text with matching reply identity", async () => {
    const service = await runEffect(makeFakeSlackService());
    const gateway = await runEffect(makeSlackGateway(config, service));
    const replyEvent = {
      ...directMessage.event,
      ts: "1700000001.123456",
      thread_ts: "1700000000.123456",
      text: "reply",
    };
    const accepted = await runEffect(
      gateway.acceptInbound({
        event: replyEvent,
        quotedMessage: { messageId: "1700000000.123456", text: "hello" },
      }),
    );
    const missingQuote = await runEffect(Effect.exit(gateway.acceptInbound({ event: replyEvent })));
    const mismatchedQuote = await runEffect(
      Effect.exit(
        gateway.acceptInbound({
          event: replyEvent,
          quotedMessage: { messageId: "1700000000.999999", text: "different parent" },
        }),
      ),
    );

    expect(accepted).toEqual({
      status: "accepted",
      message: {
        gatewayId: "slack-owner",
        messageId: "1700000001.123456",
        conversation: {
          chatId: "D123",
          threadId: "1700000000.123456",
          kind: "direct",
        },
        senderId: "U123",
        sentAt: "2023-11-14T22:13:21.123Z",
        text: "reply",
        replyTo: { messageId: "1700000000.123456", text: "hello" },
      },
    });
    expect(Exit.isFailure(missingQuote)).toBe(true);
    expect(Exit.isFailure(mismatchedQuote)).toBe(true);
  });

  it("rejects channel, edited, and rich message payloads", async () => {
    const service = await runEffect(makeFakeSlackService());
    const gateway = await runEffect(makeSlackGateway(config, service));
    const results = await runEffect(
      Effect.all([
        Effect.exit(
          gateway.acceptInbound({
            event: { ...directMessage.event, channel: "C123", channel_type: "channel" },
          }),
        ),
        Effect.exit(
          gateway.acceptInbound({ event: { ...directMessage.event, subtype: "message_changed" } }),
        ),
        Effect.exit(gateway.acceptInbound({ event: { ...directMessage.event, files: [] } })),
      ]),
    );

    expect(results.map(Exit.isFailure)).toEqual([true, true, true]);
  });

  it("keeps the first accepted normalized identity", async () => {
    const service = await runEffect(makeFakeSlackService());
    const gateway = await runEffect(makeSlackGateway(config, service));
    const first = await runEffect(gateway.acceptInbound(directMessage));
    const duplicate = await runEffect(
      gateway.acceptInbound({
        event: { ...directMessage.event, user: "U999", text: "replacement" },
      }),
    );

    expect(first.status).toBe("accepted");
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.message).toEqual(first.message);
    expect(gatewayInboundMessageKey(first.message)).toBe(
      gatewayInboundMessageKey(duplicate.message),
    );
  });
});

describe("Slack route and delivery mapping", () => {
  it("derives resume identity and replays only with the returned stream handle", async () => {
    const service = await runEffect(makeFakeSlackService());
    const gateway = await runEffect(makeSlackGateway(config, service));
    const accepted = await runEffect(gateway.acceptInbound(directMessage));
    const resume = slackResumeHandle(config, accepted.message);
    const peer = new FakeGatewayAttachPeer();
    const resolved = peer.resolveSession({ resumeHandle: resume });

    expect(resume).toEqual({
      type: "gateway-resume",
      gatewayId: "slack-owner",
      route: { type: "conversation", conversation: { chatId: "D123" } },
    });
    expect(peer.stream({ streamHandle: resolved.streamHandle, sinceSeq: 0 })).toEqual({
      replayThroughSeq: 0,
      events: [],
    });
  });

  it("includes sender and thread route identity at peer granularity", () => {
    const peerConfig: SlackGatewayConfig = {
      gatewayId: "slack-owner",
      resumeGranularity: "peer",
    };
    const message: GatewayInboundMessage = {
      gatewayId: "slack-owner",
      messageId: "1700000001.123456",
      conversation: {
        chatId: "D123",
        threadId: "1700000000.123456",
        kind: "direct",
      },
      senderId: "U123",
      sentAt: "2023-11-14T22:13:21.123Z",
      text: "reply",
    };

    expect(slackResumeHandle(peerConfig, message)).toEqual({
      type: "gateway-resume",
      gatewayId: "slack-owner",
      route: {
        type: "peer",
        conversation: { chatId: "D123", threadId: "1700000000.123456" },
        senderId: "U123",
      },
    });
  });

  it("maps normalized delivery to the deterministic Slack fake", async () => {
    const service = await runEffect(makeFakeSlackService());
    const gateway = await runEffect(makeSlackGateway(config, service));
    const receipt = await runEffect(
      gateway.deliver({
        target: {
          type: "gateway",
          gatewayId: "slack-owner",
          conversation: { chatId: "D123", threadId: "1700000000.123456" },
        },
        text: "done",
      }),
    );

    expect(receipt).toEqual({ channel: "D123", ts: "1700000000.000001" });
    expect(await runEffect(service.requests)).toEqual([
      { channel: "D123", thread_ts: "1700000000.123456", text: "done" },
    ]);
  });

  it("rejects delivery for another configured Gateway", async () => {
    const service = await runEffect(makeFakeSlackService());
    const gateway = await runEffect(makeSlackGateway(config, service));
    const result = await runEffect(
      Effect.exit(
        gateway.deliver({
          target: { type: "gateway", gatewayId: "other", conversation: { chatId: "D123" } },
          text: "wrong account",
        }),
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(await runEffect(service.requests)).toEqual([]);
  });

  it("rejects outbound text Slack would truncate", async () => {
    const service = await runEffect(makeFakeSlackService());
    const gateway = await runEffect(makeSlackGateway(config, service));
    const result = await runEffect(
      Effect.exit(
        gateway.deliver({
          target: {
            type: "gateway",
            gatewayId: "slack-owner",
            conversation: { chatId: "D123" },
          },
          text: "x".repeat(40_001),
        }),
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(await runEffect(service.requests)).toEqual([]);
  });
});

describe("Slack Web API boundary", () => {
  it("decodes successful and rejected chat.postMessage responses", async () => {
    const successApi = await runEffect(
      makeSlackWebApi(
        { botToken },
        responseClient({ ok: true, channel: "D123", ts: "1700000000.000001" }),
      ),
    );
    const rejectionApi = await runEffect(
      makeSlackWebApi({ botToken }, responseClient({ ok: false, error: "channel_not_found" })),
    );
    const request = { channel: "D123", text: "done" };

    expect(await runEffect(successApi.postMessage(request))).toEqual({
      channel: "D123",
      ts: "1700000000.000001",
    });
    expect(Exit.isFailure(await runEffect(Effect.exit(rejectionApi.postMessage(request))))).toBe(
      true,
    );
  });
});

function responseClient(body: unknown): HttpClient.HttpClient {
  return HttpClient.make((request) => {
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://slack.com/api/chat.postMessage");
    expect(request.headers.authorization).toBe(`Bearer ${botToken}`);
    expect(request.headers["content-type"]).toBe("application/json");
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
}
