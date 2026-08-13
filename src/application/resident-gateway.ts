import { join } from "node:path";
import { Context, Effect, Layer, Scope } from "effect";
import {
  acquireGatewayOwner,
  inspectGatewayOwner,
  type GatewayOwnerHandle,
} from "../adapters/bun/gateway-owner";
import { type DiscordApiError } from "../adapters/discord/api";
import { gatewayConfigPresent, validateGatewayProfile } from "../adapters/fs/gateway-config";
import { type SlackApiError } from "../adapters/slack/api";
import { type TelegramApiError } from "../adapters/telegram/api";
import { ProfileNotInitialized } from "../domain/agent";
import { type AutomationSchedulerError } from "../domain/automation";
import {
  GatewayConfigError,
  type GatewayOwnerError,
  type GatewayOwnerStatus,
} from "../domain/gateway";
import type { ProfileTarget } from "../domain/profile";
import type { DiscordGatewayConfig } from "../domain/discord";
import type { DiscordIngressDatabaseError } from "../domain/discord-ingress";
import type { SlackGatewayConfig } from "../domain/slack";
import type { SlackIngressDatabaseError } from "../domain/slack-ingress";
import type { TelegramGatewayConfig } from "../domain/telegram";
import { AutomationScheduler, type AutomationSchedulerApi } from "./automation-scheduler";
import {
  DiscordGateway,
  type DiscordGatewayApi,
  loadDiscordGatewayConfig,
} from "./discord-gateway";
import { Gateway, type GatewayApi, loadGatewayConfig } from "./gateway";
import { loadSlackGatewayConfig, SlackGateway, type SlackGatewayApi } from "./slack-gateway";

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

export interface ResidentGatewayApi {
  readonly run: (target: ProfileTarget) => Effect.Effect<never, ResidentGatewayError>;
  readonly status: (target: ProfileTarget) => Effect.Effect<GatewayOwnerStatus, GatewayOwnerError>;
}

export class ResidentGateway extends Context.Service<ResidentGateway, ResidentGatewayApi>()(
  "ziggy/ResidentGateway",
) {}

export interface ResidentGatewayRuntime {
  readonly loadConfig: typeof loadResidentGatewayConfig;
  readonly acquireOwner: (
    target: ProfileTarget,
  ) => Effect.Effect<GatewayOwnerHandle, GatewayOwnerError, Scope.Scope>;
  readonly inspectOwner: (
    target: ProfileTarget,
  ) => Effect.Effect<GatewayOwnerStatus, GatewayOwnerError>;
  readonly logError: (message: string) => Effect.Effect<void>;
}

const liveRuntime: ResidentGatewayRuntime = {
  loadConfig: loadResidentGatewayConfig,
  acquireOwner: acquireGatewayOwner,
  inspectOwner: inspectGatewayOwner,
  logError: (message) => Effect.sync(() => console.error(message)),
};

export const makeResidentGateway = (
  scheduler: AutomationSchedulerApi,
  telegram: GatewayApi,
  discord: DiscordGatewayApi,
  slack: SlackGatewayApi,
  runtime: ResidentGatewayRuntime = liveRuntime,
): ResidentGatewayApi => ({
  status: (target) => runtime.inspectOwner(target),
  run: (target) =>
    Effect.gen(function* () {
      const config = yield* runtime.loadConfig(target);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* runtime.acquireOwner(target);
          const branches: Array<Effect.Effect<never, AutomationSchedulerError>> = [
            scheduler.run(target, owner),
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
              discord.runLoop(target, config.discord).pipe(
                Effect.catchTag("DiscordApiError", (failure: DiscordApiError) =>
                  runtime
                    .logError(`[gateway] Discord stopped: ${failure.message}`)
                    .pipe(Effect.andThen(Effect.never)),
                ),
                Effect.catchTag(
                  "DiscordIngressDatabaseError",
                  (failure: DiscordIngressDatabaseError) =>
                    runtime
                      .logError(`[gateway] Discord stopped: ${failure.message}`)
                      .pipe(Effect.andThen(Effect.never)),
                ),
              ),
            );
          if (config.slack !== undefined)
            branches.push(
              slack.runLoop(target, config.slack).pipe(
                Effect.catchTag("SlackApiError", (failure: SlackApiError) =>
                  runtime
                    .logError(`[gateway] Slack stopped: ${failure.message}`)
                    .pipe(Effect.andThen(Effect.never)),
                ),
                Effect.catchTag("SlackIngressDatabaseError", (failure: SlackIngressDatabaseError) =>
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
