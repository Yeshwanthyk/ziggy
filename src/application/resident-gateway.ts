import { join } from "node:path";
import { Context, Effect, Layer, Scope } from "effect";
import { acquireGatewayOwner, type GatewayOwnerHandle } from "../adapters/bun/gateway-owner";
import { type DiscordApiError } from "../adapters/discord/api";
import { gatewayConfigPresent, validateGatewayProfile } from "../adapters/fs/gateway-config";
import { type SlackApiError } from "../adapters/slack/api";
import { type TelegramApiError } from "../adapters/telegram/api";
import { ProfileNotInitialized } from "../domain/agent";
import { type AutomationSchedulerError } from "../domain/automation";
import { GatewayConfigError, type GatewayOwnerError } from "../domain/gateway";
import type { ProfileTarget } from "../domain/profile";
import type { DiscordGatewayConfig } from "../domain/discord";
import type { SlackGatewayConfig } from "../domain/slack";
import type { TelegramGatewayConfig } from "../domain/telegram";
import { AutomationScheduler, type AutomationSchedulerShape } from "./automation-scheduler";
import {
  DiscordGateway,
  type DiscordGatewayShape,
  loadDiscordGatewayConfig,
} from "./discord-gateway";
import { Gateway, type GatewayShape, loadGatewayConfig } from "./gateway";
import { loadSlackGatewayConfig, SlackGateway, type SlackGatewayShape } from "./slack-gateway";

export interface ResidentGatewayConfig {
  readonly telegram: TelegramGatewayConfig | undefined;
  readonly discord: DiscordGatewayConfig | undefined;
  readonly slack: SlackGatewayConfig | undefined;
}

export const loadResidentGatewayConfig = (
  target: ProfileTarget,
): Effect.Effect<ResidentGatewayConfig, ProfileNotInitialized | GatewayConfigError> =>
  Effect.gen(function* () {
    yield* validateGatewayProfile(target);
    const telegram = yield* gatewayConfigPresent(join(target.path, "telegram.json"));
    const telegramConfig = telegram ? yield* loadGatewayConfig(target) : undefined;
    const discord = yield* gatewayConfigPresent(join(target.path, "discord.json"));
    const discordConfig = discord ? yield* loadDiscordGatewayConfig(target) : undefined;
    const slack = yield* gatewayConfigPresent(join(target.path, "slack.json"));
    const slackConfig = slack ? yield* loadSlackGatewayConfig(target) : undefined;
    return { telegram: telegramConfig, discord: discordConfig, slack: slackConfig };
  });

export type ResidentGatewayError =
  | ProfileNotInitialized
  | GatewayConfigError
  | GatewayOwnerError
  | AutomationSchedulerError;

export interface ResidentGatewayShape {
  readonly run: (target: ProfileTarget) => Effect.Effect<never, ResidentGatewayError>;
}

export class ResidentGateway extends Context.Service<ResidentGateway, ResidentGatewayShape>()(
  "ziggy/ResidentGateway",
) {}

export interface ResidentGatewayRuntime {
  readonly loadConfig: typeof loadResidentGatewayConfig;
  readonly acquireOwner: (
    target: ProfileTarget,
  ) => Effect.Effect<GatewayOwnerHandle, GatewayOwnerError, Scope.Scope>;
  readonly logError: (message: string) => Effect.Effect<void>;
}

const liveRuntime: ResidentGatewayRuntime = {
  loadConfig: loadResidentGatewayConfig,
  acquireOwner: acquireGatewayOwner,
  logError: (message) => Effect.sync(() => console.error(message)),
};

export const makeResidentGateway = (
  scheduler: AutomationSchedulerShape,
  telegram: GatewayShape,
  discord: DiscordGatewayShape,
  slack: SlackGatewayShape,
  runtime: ResidentGatewayRuntime = liveRuntime,
): ResidentGatewayShape => ({
  run: (target) =>
    Effect.gen(function* () {
      const config = yield* runtime.loadConfig(target);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* runtime.acquireOwner(target);
          const branches: Array<Effect.Effect<never, AutomationSchedulerError>> = [
            scheduler.run(target),
          ];
          if (config.telegram !== undefined)
            branches.push(
              telegram
                .runLoop(target, config.telegram)
                .pipe(
                  Effect.catchTag("TelegramApiError", (failure: TelegramApiError) =>
                    runtime
                      .logError(`[gateway] Telegram stopped: ${failure.message}`)
                      .pipe(Effect.andThen(Effect.never)),
                  ),
                ),
            );
          if (config.discord !== undefined)
            branches.push(
              discord
                .runLoop(target, config.discord)
                .pipe(
                  Effect.catchTag("DiscordApiError", (failure: DiscordApiError) =>
                    runtime
                      .logError(`[gateway] Discord stopped: ${failure.message}`)
                      .pipe(Effect.andThen(Effect.never)),
                  ),
                ),
            );
          if (config.slack !== undefined)
            branches.push(
              slack
                .runLoop(target, config.slack)
                .pipe(
                  Effect.catchTag("SlackApiError", (failure: SlackApiError) =>
                    runtime
                      .logError(`[gateway] Slack stopped: ${failure.message}`)
                      .pipe(Effect.andThen(Effect.never)),
                  ),
                ),
            );
          return yield* Effect.all(branches, { concurrency: "unbounded", discard: true }).pipe(
            Effect.andThen(Effect.never),
          );
        }),
      );
    }),
});

export const ResidentGatewayLive = Layer.effect(
  ResidentGateway,
  Effect.gen(function* () {
    return makeResidentGateway(
      yield* AutomationScheduler,
      yield* Gateway,
      yield* DiscordGateway,
      yield* SlackGateway,
    );
  }),
);
