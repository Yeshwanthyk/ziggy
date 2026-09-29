import { loadDiscordConfigFile } from "../../adapters/fs/gateway-config";
import type { DiscordInboundMessage } from "../../adapters/discord/socket";
import type {
  DiscordIngressAttachmentReference,
  DiscordIngressPayload,
} from "../../domain/discord-ingress";

export const THREAD_TYPES = new Set([10, 11, 12]);

export const ROOT_CHANNEL_TYPES = new Set([0, 5]);

export interface AdmittedMessage {
  readonly messageId: string;
  readonly channelId: string;
  readonly sourceChannelId: string;
  readonly guildId: string | undefined;
  readonly authorId: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DiscordIngressAttachmentReference>;
  readonly omittedAttachmentCount?: number;
}

type InboundMessage = DiscordIngressPayload;

export const normalizeDiscordMessage = (
  message: DiscordInboundMessage,
  ownerUserId: string,
): AdmittedMessage | undefined => {
  if (
    message.authorIsBot ||
    message.authorId !== ownerUserId ||
    (message.content.trim().length === 0 &&
      message.attachments.length === 0 &&
      message.omittedAttachmentCount === 0)
  ) {
    return undefined;
  }

  return {
    messageId: message.id,
    channelId: message.channelId,
    sourceChannelId: message.channelId,
    guildId: message.guildId,
    authorId: message.authorId,
    text: message.content,
    ...Object.fromEntries(
      [
        message.attachments.length > 0
          ? (["attachments", message.attachments] as const)
          : undefined,
        message.omittedAttachmentCount > 0
          ? (["omittedAttachmentCount", message.omittedAttachmentCount] as const)
          : undefined,
      ].flatMap((entry) => (entry === undefined ? [] : [entry])),
    ),
  };
};

export const loadDiscordGatewayConfig = loadDiscordConfigFile;

export const isDiscordStopCommand = (text: string): boolean =>
  text.trim().toLocaleLowerCase() === "stop";

export const threadName = (text: string): string => {
  const normalized = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return [...(normalized.length === 0 ? "Squarey request" : normalized)].slice(0, 80).join("");
};

export const discordThreadConversation = (
  message: AdmittedMessage,
  threadId: string,
  parentChannelId: string,
  label?: string,
): InboundMessage => {
  const groupId = `dc${parentChannelId}`;

  const inbound = {
    ...message,
    channelId: threadId,
    chatKey: `group-${groupId}-thread-${threadId}`,
    context: { kind: "group", groupId },
  } satisfies InboundMessage;

  return label === undefined ? inbound : { ...inbound, label };
};
