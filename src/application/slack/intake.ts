import { loadSlackConfigFile } from "../../adapters/fs/gateway-config";
import type { SlackInboundMessage } from "../../adapters/slack/socket";
import type { SlackGatewayConfig, SlackChannelMode } from "../../domain/slack";
import type { SlackIngressPayload } from "../../domain/slack-ingress";

type InboundMessage = SlackIngressPayload;

export const SLACK_BROADCAST_MENTION = /<!(?:everyone|channel|here)(?:\|[^>\n]*)?>/gi;

const SLACK_LINK = /<((?:https?|mailto|tel):[^|>]+)(?:\|([^>]*))?>/giu;

const SLACK_ENTITY = /&(amp|lt|gt);/gu;

const SLACK_ENTITY_VALUE = {
  amp: "&",
  gt: ">",
  lt: "<",
} as const;

export type SlackAdmissionReason =
  | "bot-message"
  | "empty-message"
  | "mention-required"
  | "not-owner";

export type SlackAdmission =
  | { readonly kind: "accepted"; readonly message: InboundMessage }
  | { readonly kind: "ignored"; readonly reason: SlackAdmissionReason };

export type SlackCommandAdmission =
  | { readonly kind: "turn" | "stop"; readonly message: InboundMessage }
  | { readonly kind: "ignored"; readonly reason: SlackAdmissionReason };

export const isSlackStopCommand = (text: string): boolean => text === "stop" || text === "/stop";

export const loadSlackGatewayConfig = loadSlackConfigFile;

export const normalizeSlackUserText = (text: string): string =>
  text
    .replace(SLACK_LINK, (_token, target: string, label: string | undefined) =>
      label === undefined || label.length === 0 ? target : label,
    )
    .replace(
      SLACK_ENTITY,
      (_token, entity: keyof typeof SLACK_ENTITY_VALUE) => SLACK_ENTITY_VALUE[entity],
    );

export const slackReplyThreadTs = (
  message: Pick<SlackIngressPayload, "context" | "statusThreadTs" | "threadTs">,
): string | undefined =>
  message.context.kind === "group" ? message.statusThreadTs : message.threadTs;

export const resolveSlackChannelMode = (
  config: Pick<SlackGatewayConfig, "channels">,
  channel: string,
): typeof SlackChannelMode.Type => config.channels?.[channel] ?? "mention";

export const classifySlackMessage = (
  message: SlackInboundMessage,
  botUserId: string,
  ownerUserId: string,
  channelMode: typeof SlackChannelMode.Type = "mention",
): SlackAdmission => {
  if (message.userId === botUserId) {
    return { kind: "ignored", reason: "bot-message" };
  }

  if (message.userId !== ownerUserId) {
    return { kind: "ignored", reason: "not-owner" };
  }

  const hasFiles = (message.files?.length ?? 0) > 0 || (message.omittedFileCount ?? 0) > 0;

  if (message.text.trim().length === 0 && !hasFiles) {
    return { kind: "ignored", reason: "empty-message" };
  }

  const optionalFields = Object.fromEntries(
    [
      message.files !== undefined ? (["files", message.files] as const) : undefined,
      message.omittedFileCount !== undefined
        ? (["omittedFileCount", message.omittedFileCount] as const)
        : undefined,
      message.teamId !== undefined ? (["teamId", message.teamId] as const) : undefined,
    ].flatMap((entry) => (entry === undefined ? [] : [entry])),
  );

  if (message.channelType === "im") {
    const ingressMessage: InboundMessage = {
      chatKey: `user-${message.userId}`,
      channel: message.channel,
      context: { kind: "user", userId: "owner" },
      statusThreadTs: message.threadTs ?? message.ts,
      sourceTs: message.ts,
      text: normalizeSlackUserText(message.text),
      threadTs: message.threadTs,
      ...optionalFields,
    };

    return { kind: "accepted", message: ingressMessage };
  }

  const botMention = `<@${botUserId}>`;
  const hasBotMention = message.text.includes(botMention);

  if (channelMode === "mention" && !hasBotMention) {
    return { kind: "ignored", reason: "mention-required" };
  }

  const channelText = normalizeSlackUserText(message.text.replaceAll(botMention, "")).trim();

  if (channelText.length === 0 && !hasFiles && !hasBotMention) {
    return { kind: "ignored", reason: "empty-message" };
  }

  // Slack channel IDs are alphanumeric; the "sl" prefix keeps group memory channel-scoped.
  const groupId = `sl${message.channel}`;
  const conversationThreadTs = message.threadTs ?? message.ts;
  const chatKey = `group-${groupId}-thread-${encodeURIComponent(conversationThreadTs)}`;

  const ingressMessage: InboundMessage = {
    chatKey,
    channel: message.channel,
    context: { kind: "group", groupId },
    statusThreadTs: conversationThreadTs,
    sourceTs: message.ts,
    text: channelText,
    threadTs: message.threadTs,
    ...optionalFields,
  };

  return {
    kind: "accepted",
    message: ingressMessage,
  };
};

export const normalizeSlackMessage = (
  message: SlackInboundMessage,
  botUserId: string,
  ownerUserId: string,
  channelMode: typeof SlackChannelMode.Type = "mention",
): InboundMessage | undefined => {
  const admission = classifySlackMessage(message, botUserId, ownerUserId, channelMode);

  return admission.kind === "accepted" ? admission.message : undefined;
};

export const classifySlackCommand = (
  message: SlackInboundMessage,
  botUserId: string,
  ownerUserId: string,
  channelMode: typeof SlackChannelMode.Type = "mention",
): SlackCommandAdmission => {
  const admission = classifySlackMessage(message, botUserId, ownerUserId, channelMode);

  if (admission.kind === "ignored") return admission;

  return {
    kind: isSlackStopCommand(admission.message.text) ? "stop" : "turn",
    message: admission.message,
  };
};
