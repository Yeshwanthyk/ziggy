import type {
  GatewayInboundMessage,
  GatewayResumeHandle,
  GatewaySessionResolveResponse,
  GatewayStreamRequest,
} from "@ziggy/protocol";
import { gatewayInboundMessageKey } from "@ziggy/protocol";
import { Effect, Ref } from "effect";
import type { TelegramGatewayConfig } from "./config.ts";
import type { TelegramSendRequest } from "./telegram-api.ts";

export function telegramSendRequest(
  conversation: { readonly chatId: string; readonly threadId?: string },
  text: string,
  replyToMessageId?: string,
): TelegramSendRequest {
  return {
    chatId: conversation.chatId,
    text,
    ...(conversation.threadId === undefined ? {} : { threadId: conversation.threadId }),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
  };
}

export function resumeHandleFor(
  config: TelegramGatewayConfig,
  message: GatewayInboundMessage,
): GatewayResumeHandle {
  const conversation = {
    chatId: message.conversation.chatId,
    ...(message.conversation.threadId === undefined
      ? {}
      : { threadId: message.conversation.threadId }),
  };
  return {
    type: "gateway-resume",
    gatewayId: config.gatewayId,
    route:
      config.resumeGranularity === "peer"
        ? { type: "peer", conversation, senderId: message.senderId }
        : { type: "conversation", conversation },
  };
}

/** Replay identity is runtime-owned and must come directly from resolution. */
export function replayRequestFromResolution(
  response: GatewaySessionResolveResponse,
  sinceSeq: number,
): GatewayStreamRequest {
  return { streamHandle: response.streamHandle, sinceSeq };
}

export interface InboundIdempotency {
  readonly accept: (message: GatewayInboundMessage) => Effect.Effect<boolean>;
}

export const makeInboundIdempotency = Effect.gen(function* () {
  const accepted = yield* Ref.make(new Set<string>());
  return {
    accept: (message: GatewayInboundMessage) =>
      Ref.modify(accepted, (seen) => {
        const key = gatewayInboundMessageKey(message);
        if (seen.has(key)) return [false, seen];
        const next = new Set(seen);
        next.add(key);
        return [true, next];
      }),
  } satisfies InboundIdempotency;
});
