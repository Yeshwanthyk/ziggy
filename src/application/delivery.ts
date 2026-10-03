import { Config, Effect, Option } from "effect";
import type { DiscordApiError } from "../adapters/discord/api";
import type { SlackApiError } from "../adapters/slack/api";
import type { TelegramApiError } from "../adapters/telegram/api";
import type { AutomationDeliveryFailureCategory, AutomationTarget } from "../domain/automation";
import type { ProfileTarget } from "../profile";

/** A place a gateway can post to: a Slack channel or thread, a Discord channel or thread, a Telegram chat. */
export type GatewayTarget = Exclude<AutomationTarget, { readonly _tag: "conversation" }>;

export interface DeliveryFailure {
  readonly category: AutomationDeliveryFailureCategory;
  readonly retriable: boolean;
}

/** The one delivery seam: post `text` to `target` through the gateway that owns it. */
export type Deliver = (
  profile: ProfileTarget,
  target: GatewayTarget,
  text: string,
) => Effect.Effect<void, DeliveryFailure>;

export const configurationFailure: DeliveryFailure = {
  category: "configuration",
  retriable: false,
};

export const apiFailure = (
  error: TelegramApiError | DiscordApiError | SlackApiError,
): DeliveryFailure => {
  switch (error.reason) {
    case "network":
    case "gateway":
    case "socket":
      return { category: "transport", retriable: error.retriable };
    case "authentication":
      return { category: "authentication", retriable: error.retriable };
    case "rate-limited":
      return { category: "rate-limited", retriable: error.retriable };
    case "invalid-response":
    case "decode":
      return { category: "invalid-response", retriable: error.retriable };
    case "server":
    case "rejected":
    case "api":
      return { category: "remote", retriable: error.retriable };
  }
};

/**
 * A chat API base URL from the environment (e.g. `ZIGGY_SLACK_API_URL`); unset or empty means the
 * real API. A value that is not a URL is a configuration failure, not a retriable send failure.
 */
export const chatApiUrl = (name: string): Effect.Effect<string | undefined, DeliveryFailure> =>
  Effect.gen(function* () {
    const value = Option.getOrUndefined(yield* Config.string(name).pipe(Config.option));

    if (value === undefined || value === "") return undefined;

    if (!URL.canParse(value)) return yield* Effect.fail(configurationFailure);

    return value.replace(/\/+$/, "");
  }).pipe(Effect.mapError(() => configurationFailure));
