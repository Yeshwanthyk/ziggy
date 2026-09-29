export { SlackGateway, SlackGatewayLive, makeSlackGateway } from "./slack/runtime";

export type {
  SlackGatewayApi,
  SlackGatewayError,
  SlackTransport,
  SlackIngressRuntime,
  SlackHealthRuntime,
} from "./slack/model";

export {
  loadSlackGatewayConfig,
  normalizeSlackUserText,
  slackReplyThreadTs,
  resolveSlackChannelMode,
  classifySlackMessage,
  normalizeSlackMessage,
  classifySlackCommand,
} from "./slack/intake";

export type { SlackAdmissionReason, SlackAdmission, SlackCommandAdmission } from "./slack/intake";

export {
  escapeSlackBroadcastMentions,
  slackMessageChunks,
  slackIngressTerminalState,
  shouldUpdateSlackProgress,
  uniqueSlackStatusTargets,
  prepareSlackAttachmentPrompt,
  renderSlackThreadContext,
  retrySlackDelivery,
} from "./slack/delivery";

export type { SlackProgressUpdateState } from "./slack/delivery";
