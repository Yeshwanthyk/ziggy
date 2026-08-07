import { readFile } from "node:fs/promises";
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
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import { postMessage, SlackApiError } from "../adapters/slack/api";
import { sendMessage, TelegramApiError } from "../adapters/telegram/api";
import {
  type Automation,
  AutomationDatabaseError,
  AutomationFileSystemError,
  AutomationGateFailed,
  AutomationInvalid,
  AutomationNotFound,
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
import type { ZiggyAgentError } from "../domain/agent";
import type { ProfileTarget } from "../domain/profile";
import { ZiggyAgent, type ZiggyAgentShape } from "./agent";
import { discordMessageChunks, loadDiscordGatewayConfig } from "./discord-gateway";
import { loadGatewayConfig, telegramMessageChunks } from "./gateway";
import { loadSlackGatewayConfig, slackMessageChunks } from "./slack-gateway";

export type AutomationError =
  | AutomationInvalid
  | AutomationNotFound
  | AutomationFileSystemError
  | AutomationGateFailed
  | AutomationDatabaseError
  | ZiggyAgentError;

export interface AutomationsShape {
  readonly run: (
    target: ProfileTarget,
    automationId: string,
    trigger: AutomationTrigger,
  ) => Effect.Effect<AutomationRunOutcome, AutomationError>;
}
export class Automations extends Context.Service<Automations, AutomationsShape>()(
  "ziggy/Automations",
) {}

export interface AutomationCapabilities {
  readonly gate: AutomationGate;
  readonly printReply: (reply: string) => Effect.Effect<void>;
  readonly loadTelegramConfig: typeof loadGatewayConfig;
  readonly loadDiscordConfig: typeof loadDiscordGatewayConfig;
  readonly loadSlackConfig: typeof loadSlackGatewayConfig;
  readonly sendTelegram: typeof sendMessage;
  readonly sendDiscord: typeof createMessage;
  readonly sendSlack: typeof postMessage;
}

const liveCapabilities: AutomationCapabilities = {
  gate: liveAutomationGate,
  printReply: (reply) => Effect.sync(() => console.log(reply)),
  loadTelegramConfig: loadGatewayConfig,
  loadDiscordConfig: loadDiscordGatewayConfig,
  loadSlackConfig: loadSlackGatewayConfig,
  sendTelegram: sendMessage,
  sendDiscord: createMessage,
  sendSlack: postMessage,
};

const readAutomation = (target: ProfileTarget, idSource: string) =>
  Effect.gen(function* () {
    const id = yield* validateAutomationId(idSource);
    const filePath = join(target.path, "automations", `${id}.md`);
    const source = yield* Effect.tryPromise({
      try: () => readFile(filePath, "utf8"),
      catch: (cause) =>
        fileSystemCauseDetails(cause).code === "ENOENT"
          ? new AutomationNotFound({
              id,
              path: filePath,
              message: `no automation ${id} at ${filePath}`,
            })
          : new AutomationFileSystemError({
              path: filePath,
              message: `could not read automation ${id} at ${filePath}`,
              cause,
            }),
    });
    return yield* parseAutomationFile(id, filePath, source);
  });

type TargetResolution =
  | { readonly ok: true; readonly targets: ReadonlyArray<AutomationTarget> }
  | {
      readonly ok: false;
      readonly category: "broadcasts-unreadable" | "broadcasts-invalid" | "all-empty";
    };

const resolveTargets = (
  target: ProfileTarget,
  automation: Automation,
): Effect.Effect<TargetResolution> =>
  Effect.gen(function* () {
    let homes: ReadonlyArray<AutomationTarget> | undefined;
    if (automation.broadcast.includes("all")) {
      const path = join(target.path, "broadcasts.json");
      const sourceResult = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: fileSystemCauseDetails,
      }).pipe(Effect.result);
      if (Result.isFailure(sourceResult) && sourceResult.failure.code !== "ENOENT") {
        return { ok: false, category: "broadcasts-unreadable" };
      }
      const source = Result.isSuccess(sourceResult) ? sourceResult.success : '{"targets":[]}';
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

// oxfmt-ignore
const failedCategory = (error: AutomationError): string => Match.value(error).pipe(Match.tagsExhaustive({ AutomationInvalid: () => "AutomationInvalid", AutomationNotFound: () => "AutomationNotFound", AutomationFileSystemError: () => "AutomationFileSystemError", AutomationGateFailed: (failure) => `AutomationGateFailed:${failure.reason}`, AutomationDatabaseError: () => "AutomationDatabaseError", ProfileNotInitialized: () => "ProfileNotInitialized", ProviderConfigError: () => "ProviderConfigError", ProviderCallError: () => "ProviderCallError", MemoryIdInvalid: () => "MemoryIdInvalid", ProfileExtensionInvalid: () => "ProfileExtensionInvalid", ProfileFileSystemError: () => "ProfileFileSystemError" }));

export const makeAutomations = (
  agent: ZiggyAgentShape,
  capabilities: AutomationCapabilities = liveCapabilities,
  runtime: AutomationRunRuntime = liveRunRuntime,
): AutomationsShape => ({
  run: (target, automationIdSource, trigger) =>
    Effect.gen(function* () {
      const automationId = yield* validateAutomationId(automationIdSource);
      const admittedAt = yield* runtime.now;
      const runId =
        trigger.kind === "manual-force"
          ? runtime.makeManualRunId()
          : scheduledRunId(automationId, Date.parse(trigger.scheduledFor));
      if (trigger.kind === "manual-force") {
        const admission = yield* runtime.store.admitManual(
          target.path,
          automationId,
          runId,
          admittedAt,
        );
        if (admission === "skipped-busy") return { kind: "skipped-busy" };
      }
      const fingerprint = trigger.kind === "scheduled" ? trigger.scheduleFingerprint : null;
      yield* runtime.store.start(target.path, runId, yield* runtime.now, fingerprint);

      const finish = (
        terminal: Omit<RunTerminal, "atMs">,
        targets: ReadonlyArray<AutomationTargetOutcome> = [],
      ) =>
        Effect.flatMap(runtime.now, (atMs) =>
          runtime.store.finish(target.path, runId, { ...terminal, atMs }, targets),
        );

      const execute: Effect.Effect<TerminalIntent, AutomationError> = Effect.gen(function* () {
        const automation = yield* readAutomation(target, automationId);
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
        const handle = yield* agent.openChat(
          target,
          { kind: "local" },
          join(target.path, "sessions", "automations", automation.id),
          "fresh",
        );
        const reply = yield* handle
          .prompt(automation.prompt)
          .pipe(
            Effect.ensuring(
              handle.dispose.pipe(
                Effect.catch((failure) =>
                  Effect.sync(() =>
                    console.error(
                      `[wake] ${automation.id}: session dispose failed — ${failure.message}`,
                    ),
                  ),
                ),
              ),
            ),
          );
        yield* capabilities.printReply(reply);
        const resolution = yield* resolveTargets(target, automation);
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

      const intent = yield* execute.pipe(
        Effect.catch((error) =>
          finish({
            state: "failed",
            localCompleted: false,
            failureCategory: failedCategory(error),
            gateExitCode: null,
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
        Effect.onInterrupt(() =>
          finish({
            state: "failed",
            localCompleted: false,
            failureCategory: "interrupted",
            gateExitCode: null,
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      yield* finish(intent.terminal, intent.targets);
      return intent.outcome;
    }),
});

export const AutomationsLive = Layer.effect(
  Automations,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    return makeAutomations(agent);
  }),
);
