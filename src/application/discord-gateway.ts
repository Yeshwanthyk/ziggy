export { DiscordGateway, DiscordGatewayLive, makeDiscordGateway } from "./discord/runtime";

export { loadDiscordGatewayConfig } from "./discord/intake";

export type {
  DiscordGatewayApi,
  DiscordGatewayError,
  DiscordTransport,
  DiscordHealthRuntime,
  DiscordIngressRuntime,
} from "./discord/model";

export type { DiscordProgressUpdateState } from "./discord/delivery";

export {
  normalizeDiscordMessage,
  isDiscordStopCommand,
  discordThreadConversation,
} from "./discord/intake";

export {
  shouldUpdateDiscordProgress,
  discordMessageChunks,
  prepareDiscordAttachmentPrompt,
  discordIngressTerminalState,
  retryDiscordDelivery,
} from "./discord/delivery";
