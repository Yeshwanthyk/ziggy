import { join } from "node:path";
import { Clock, Context, Effect, Layer, Match, Option, Predicate, Result } from "effect";
import { liveAutomationGate, type AutomationGate } from "../adapters/bun/automation-gate";
import {
  automationRunStore,
  makeLiveManualRunId,
  type AutomationRunStore,
  type RunTerminal,
} from "../adapters/bun/automation-sqlite";
import { createMessage, DiscordApiError } from "../adapters/discord/api";
import { automationFileStore, type AutomationFileStore } from "../adapters/fs/automation-files";
import { postMessage, SlackApiError } from "../adapters/slack/api";
import { sendMessage, TelegramApiError } from "../adapters/telegram/api";
import {
  type Automation,
  AutomationDatabaseError,
  AutomationFileSystemError,
  AutomationGateFailed,
  AutomationInvalid,
  AutomationNotFound,
  AutomationPaused,
  type AutomationDeliveryFailureCategory,
  type AutomationRunOutcome,
  type AutomationTrigger,
  type AutomationTarget,
  type AutomationTargetOutcome,
  decodeBroadcastsFileJson,
  parseAutomationFile,
  parseAutomationTarget,
  scheduledRunId,
  validateAutomationId,
} from "../domain/automation";
import type { ProfileSpecialistError } from "../domain/agent";
import type { ProfileTarget } from "../domain/profile";
import { ZiggyAgent, type ZiggyAgentApi } from "./agent";
import { discordMessageChunks, loadDiscordGatewayConfig } from "./discord-gateway";
import { loadGatewayConfig, telegramMessageChunks } from "./gateway";
import { loadSlackGatewayConfig, slackMessageChunks } from "./slack-gateway";

export type AutomationError =
  | AutomationInvalid
  | AutomationNotFound
  | AutomationPaused
  | AutomationFileSystemError
  | AutomationGateFailed
  | AutomationDatabaseError
  | ProfileSpecialistError;

export interface AutomationsApi {
  readonly run: (
    target: ProfileTarget,
    automationId: string,
    trigger: AutomationTrigger,
  ) => Effect.Effect<AutomationRunOutcome, AutomationError>;
}
export class Automations extends Context.Service<Automations, AutomationsApi>()(
  "ziggy/Automations",
) {}

export interface AutomationCapabilities {
  readonly gate: AutomationGate;
  readonly files: AutomationFileStore;
  readonly printReply: (reply: string) => Effect.Effect<void>;
  readonly loadTelegramConfig: typeof loadGatewayConfig;
  readonly loadDiscordConfig: typeof loadDiscordGatewayConfig;
  readonly loadSlackConfig: typeof loadSlackGatewayConfig;
  readonly sendTelegram: typeof sendMessage;
  readonly sendDiscord: typeof createMessage;
  readonly sendSlack: (
    token: string,
    channel: string,
    text: string,
    threadTs?: string,
  ) => Effect.Effect<void, SlackApiError>;
}

const liveCapabilities: AutomationCapabilities = {
  gate: liveAutomationGate,
  files: automationFileStore,
  printReply: (reply) => Effect.sync(() => console.log(reply)),
  loadTelegramConfig: loadGatewayConfig,
  loadDiscordConfig: loadDiscordGatewayConfig,
  loadSlackConfig: loadSlackGatewayConfig,
  sendTelegram: sendMessage,
  sendDiscord: createMessage,
  sendSlack: (token, channel, text, threadTs) =>
    postMessage(token, channel, text, threadTs).pipe(Effect.asVoid),
};

const readAutomation = (
  files: AutomationFileStore,
  target: ProfileTarget,
  idSource: string,
  allowPaused: boolean,
) =>
  Effect.gen(function* () {
    const id = yield* validateAutomationId(idSource);
    const loaded = yield* files.readDefinition(target, id, allowPaused);
    return yield* parseAutomationFile(id, loaded.path, loaded.source);
  });

type TargetResolution =
  | { readonly ok: true; readonly targets: ReadonlyArray<AutomationTarget> }
  | {
      readonly ok: false;
      readonly category: "broadcasts-unreadable" | "broadcasts-invalid" | "all-empty";
    };

const resolveTargets = (
  files: AutomationFileStore,
  target: ProfileTarget,
  automation: Automation,
): Effect.Effect<TargetResolution> =>
  Effect.gen(function* () {
    let homes: ReadonlyArray<AutomationTarget> | undefined;
    if (automation.broadcast.includes("all")) {
      const path = join(target.path, "broadcasts.json");
      const sourceResult = yield* files.readBroadcasts(target).pipe(Effect.result);
      if (Result.isFailure(sourceResult)) {
        return { ok: false, category: "broadcasts-unreadable" };
      }
      const source = sourceResult.success ?? '{"targets":[]}';
      const decoded = yield* decodeBroadcastsFileJson(source).pipe(Effect.option);
      if (Option.isNone(decoded)) return { ok: false, category: "broadcasts-invalid" };
      const parsed: Array<AutomationTarget> = [];
      for (const value of decoded.value.targets) {
        const item = yield* parseAutomationTarget(automation.id, path, value).pipe(Effect.option);
        if (Option.isNone(item)) return { ok: false, category: "broadcasts-invalid" };
        parsed.push(item.value);
      }
      homes = parsed;
      if (homes.length === 0) return { ok: false, category: "all-empty" };
    }
    const resolved: Array<AutomationTarget> = [];
    const seen = new Set<string>();
    for (const token of automation.broadcast) {
      const additions =
        token === "origin"
          ? automation.origin === undefined
            ? []
            : [automation.origin]
          : token === "all"
            ? (homes ?? [])
            : [token];
      for (const addition of additions) {
        if (!seen.has(addition.target)) {
          seen.add(addition.target);
          resolved.push(addition);
        }
      }
    }
    return { ok: true, targets: resolved };
  });

type DeliveryFailure = {
  readonly category: AutomationDeliveryFailureCategory;
  readonly retriable: boolean;
};
const apiFailure = (error: TelegramApiError | DiscordApiError | SlackApiError): DeliveryFailure => {
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

const deliver = (
  capabilities: AutomationCapabilities,
  profile: ProfileTarget,
  target: AutomationTarget,
  reply: string,
): Effect.Effect<AutomationTargetOutcome> => {
  const operation: Effect.Effect<void, DeliveryFailure> = Effect.gen(function* () {
    if (Predicate.isTagged("telegram")(target)) {
      const config = yield* capabilities
        .loadTelegramConfig(profile)
        .pipe(
          Effect.mapError((): DeliveryFailure => ({ category: "configuration", retriable: false })),
        );
      for (const chunk of telegramMessageChunks(reply))
        yield* capabilities
          .sendTelegram(config.botToken, target.chatId, chunk)
          .pipe(Effect.mapError(apiFailure));
      return;
    }
    if (Predicate.isTagged("discord")(target)) {
      const config = yield* capabilities
        .loadDiscordConfig(profile)
        .pipe(
          Effect.mapError((): DeliveryFailure => ({ category: "configuration", retriable: false })),
        );
      for (const chunk of discordMessageChunks(reply))
        yield* capabilities
          .sendDiscord(config.botToken, target.channelId, chunk)
          .pipe(Effect.mapError(apiFailure));
      return;
    }
    const config = yield* capabilities
      .loadSlackConfig(profile)
      .pipe(
        Effect.mapError((): DeliveryFailure => ({ category: "configuration", retriable: false })),
      );
    for (const chunk of slackMessageChunks(reply))
      yield* capabilities
        .sendSlack(config.botToken, target.channelId, chunk, target.threadTs)
        .pipe(Effect.mapError(apiFailure));
  });
  return operation.pipe(
    Effect.as<AutomationTargetOutcome>({ target: target.target, status: "delivered" }),
    Effect.catch((failure) =>
      Effect.succeed({ target: target.target, status: "failed", ...failure } as const),
    ),
  );
};

// oxfmt-ignore
export interface AutomationRunRuntime { readonly store: AutomationRunStore; readonly now: Effect.Effect<number>; readonly makeManualRunId: () => string }
const liveRunRuntime: AutomationRunRuntime = {
  store: automationRunStore,
  now: Clock.currentTimeMillis,
  makeManualRunId: makeLiveManualRunId,
};

interface TerminalIntent {
  readonly outcome: AutomationRunOutcome;
  readonly terminal: Omit<RunTerminal, "atMs">;
  readonly targets: ReadonlyArray<AutomationTargetOutcome>;
}

const gateFailureCategory = (
  reason: AutomationGateFailed["reason"],
): "AutomationGateFailed:spawn" | "AutomationGateFailed:wait" | "AutomationGateFailed:timeout" => {
  switch (reason) {
    case "spawn":
      return "AutomationGateFailed:spawn";
    case "wait":
      return "AutomationGateFailed:wait";
    case "timeout":
      return "AutomationGateFailed:timeout";
  }
};

// oxfmt-ignore
const failedCategory = (error: AutomationError): NonNullable<RunTerminal["failureCategory"]> => Match.value(error).pipe(Match.tagsExhaustive({ AutomationInvalid: () => "AutomationInvalid" as const, AutomationNotFound: () => "AutomationNotFound" as const, AutomationPaused: () => "AutomationPaused" as const, AutomationFileSystemError: () => "AutomationFileSystemError" as const, AutomationGateFailed: (failure) => gateFailureCategory(failure.reason), AutomationDatabaseError: () => "AutomationDatabaseError" as const, ProfileNotInitialized: () => "ProfileNotInitialized" as const, ProviderConfigError: () => "ProviderConfigError" as const, ProviderCallError: () => "ProviderCallError" as const, MemoryIdInvalid: () => "MemoryIdInvalid" as const, ProfileExtensionInvalid: () => "ProfileExtensionInvalid" as const, ProfileFileSystemError: () => "ProfileFileSystemError" as const, ProfileAgentInvalid: () => "ProfileAgentInvalid" as const, ProfileAgentMentionInvalid: () => "ProfileAgentMentionInvalid" as const, SpecialistAgentNotFound: () => "SpecialistAgentNotFound" as const, SpecialistProviderUnsupported: () => "SpecialistProviderUnsupported" as const, SpecialistModelUnsupported: () => "SpecialistModelUnsupported" as const, SpecialistAuthUnavailable: () => "SpecialistAuthUnavailable" as const, SpecialistThinkingUnsupported: () => "SpecialistThinkingUnsupported" as const, SpecialistToolUnsupported: () => "SpecialistToolUnsupported" as const, SpecialistRunFailed: () => "SpecialistRunFailed" as const }))

export const makeAutomations = (
  agent: ZiggyAgentApi,
  capabilities: AutomationCapabilities = liveCapabilities,
  runtime: AutomationRunRuntime = liveRunRuntime,
): AutomationsApi => ({
  run: (target, automationIdSource, trigger) =>
    Effect.gen(function* () {
      const automationId = yield* validateAutomationId(automationIdSource);
      const admittedAt = yield* runtime.now;
      const runId =
        trigger.kind === "manual-force"
          ? runtime.makeManualRunId()
          : scheduledRunId(automationId, Date.parse(trigger.scheduledFor));
      if (trigger.kind === "manual-force") {
        yield* runtime.store.recover(target.path, admittedAt);
        const admission = yield* runtime.store.admitManual(
          target.path,
          automationId,
          runId,
          admittedAt,
        );
        if (admission === "skipped-busy") return { kind: "skipped-busy" };
      }
      const fingerprint = trigger.kind === "scheduled" ? trigger.scheduleFingerprint : null;
      const owner =
        trigger.kind === "scheduled"
          ? { kind: "resident" as const, id: trigger.residentOwnerId }
          : undefined;
      yield* runtime.store.start(target.path, runId, yield* runtime.now, fingerprint, owner);

      const finish = (
        terminal: Omit<RunTerminal, "atMs">,
        targets: ReadonlyArray<AutomationTargetOutcome> = [],
      ) =>
        Effect.flatMap(runtime.now, (atMs) =>
          runtime.store.finish(target.path, runId, { ...terminal, atMs }, targets, owner),
        );

      const execute: Effect.Effect<TerminalIntent, AutomationError> = Effect.gen(function* () {
        const automation = yield* readAutomation(
          capabilities.files,
          target,
          automationId,
          trigger.kind === "scheduled",
        );
        if (trigger.kind === "scheduled" && automation.gate === undefined) {
          return {
            outcome: { kind: "declined", reason: "gate-nonzero", exitCode: 1 },
            terminal: {
              state: "skipped-gate",
              localCompleted: false,
              failureCategory: "gate-missing",
              gateExitCode: null,
            },
            targets: [],
          };
        }
        if (automation.gate !== undefined) {
          const gate = yield* capabilities.gate.run(target.path, automation.id, automation.gate);
          if (gate.kind === "declined") {
            return {
              outcome: { kind: "declined", reason: "gate-nonzero", exitCode: gate.exitCode },
              terminal: {
                state: "skipped-gate",
                localCompleted: false,
                failureCategory: "gate-nonzero",
                gateExitCode: gate.exitCode,
              },
              targets: [],
            };
          }
        }
        const reply =
          automation.specialist === undefined
            ? yield* Effect.acquireUseRelease(
                agent.openChat(
                  target,
                  { kind: "local" },
                  join(target.path, "sessions", "automations", automation.id),
                  "fresh",
                ),
                (handle) => handle.prompt(automation.prompt),
                (handle) =>
                  handle.dispose.pipe(
                    Effect.catch((failure) =>
                      Effect.sync(() =>
                        console.error(
                          `[wake] ${automation.id}: session dispose failed — ${failure.message}`,
                        ),
                      ),
                    ),
                  ),
              )
            : (yield* agent.runSpecialist(
                target,
                automation.specialist.agentId,
                automation.specialist.task,
                {
                  sessionDirectory: join(
                    target.path,
                    "sessions",
                    "automations",
                    automation.id,
                    runId,
                  ),
                },
              )).answer;
        yield* capabilities.printReply(reply);
        const resolution = yield* resolveTargets(capabilities.files, target, automation);
        if (!resolution.ok) {
          return {
            outcome: {
              kind: "executed",
              delivery: { kind: "resolution-failed", category: resolution.category },
            },
            terminal: {
              state: "failed",
              localCompleted: true,
              failureCategory: resolution.category,
              gateExitCode: null,
            },
            targets: [],
          };
        }
        const outcomes: Array<AutomationTargetOutcome> = [];
        for (const destination of resolution.targets)
          outcomes.push(yield* deliver(capabilities, target, destination, reply));
        const firstFailure = outcomes.find((outcome) => outcome.status === "failed");
        return {
          outcome: { kind: "executed", delivery: { kind: "resolved", targets: outcomes } },
          terminal:
            firstFailure === undefined
              ? {
                  state: "completed",
                  localCompleted: true,
                  failureCategory: null,
                  gateExitCode: null,
                }
              : {
                  state: "failed",
                  localCompleted: true,
                  failureCategory: firstFailure.category,
                  gateExitCode: null,
                },
          targets: outcomes,
        };
      });

      return yield* Effect.uninterruptibleMask((restore) =>
        restore(execute).pipe(
          Effect.catch((error) =>
            finish({
              state: "failed",
              localCompleted: false,
              failureCategory: failedCategory(error),
              gateExitCode: null,
            }).pipe(Effect.andThen(Effect.fail(error))),
          ),
          Effect.flatMap((intent) =>
            finish(intent.terminal, intent.targets).pipe(Effect.as(intent.outcome)),
          ),
          Effect.onInterrupt(() =>
            finish({
              state: "failed",
              localCompleted: false,
              failureCategory: "interrupted",
              gateExitCode: null,
            }),
          ),
        ),
      );
    }),
});

export const AutomationsLive = Layer.effect(
  Automations,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    return makeAutomations(agent);
  }),
);
