import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, Inspectable, Option, Result, Schema } from "effect";
import { withAutomationRunLease } from "../adapters/bun/automation-run-lease";
import { killProcess } from "../adapters/bun/process";
import { createMessage } from "../adapters/discord/api";
import { postMessage } from "../adapters/slack/api";
import { sendMessage } from "../adapters/telegram/api";
import type {
  Automation,
  AutomationFileSystemError,
  AutomationInvalid,
  AutomationNotFound,
} from "../domain/automation";
import type {
  AutomationDeliveryOutcome,
  AutomationRunReceipt,
} from "../domain/automation-run";
import type { ProfileTarget } from "../domain/profile";
import type { ZiggyAgentShape } from "./agent";
import {
  type AutomationReceiptError,
  claimAutomationReceipt,
  recoverRunningAutomationReceipts,
  writeAutomationReceipt,
} from "./automation-receipts";
import {
  loadDiscordGatewayConfig,
  discordMessageChunks,
} from "./discord-gateway";
import { loadGatewayConfig, telegramMessageChunks } from "./gateway";
import { loadSlackGatewayConfig, slackMessageChunks } from "./slack-gateway";

const GATE_TIMEOUT = "30 seconds";
const RUN_TIMEOUT = "30 minutes";

class AutomationGateError extends Schema.TaggedErrorClass<AutomationGateError>()(
  "AutomationGateError",
  {
    operation: Schema.Literals(["spawn", "wait"]),
    cause: Schema.Defect(),
  },
) {}

export type AutomationRunTrigger =
  | { readonly kind: "manual" }
  | {
      readonly kind: "scheduled";
      readonly scheduledInstant: string;
      readonly firingId: string;
      readonly skipReason?: string;
    };

export type AutomationRunError =
  | AutomationInvalid
  | AutomationNotFound
  | AutomationFileSystemError
  | AutomationReceiptError;

export interface AutomationDefinitionLoader {
  readonly read: (
    target: ProfileTarget,
    automationId: string,
  ) => Effect.Effect<
    Automation,
    AutomationInvalid | AutomationNotFound | AutomationFileSystemError
  >;
}

export interface AutomationRunDelivery {
  readonly loadTelegramConfig: typeof loadGatewayConfig;
  readonly sendTelegramMessage: typeof sendMessage;
  readonly loadDiscordConfig: typeof loadDiscordGatewayConfig;
  readonly sendDiscordMessage: typeof createMessage;
  readonly loadSlackConfig: typeof loadSlackGatewayConfig;
  readonly sendSlackMessage: typeof postMessage;
}

export interface AutomationRunOutput {
  readonly printReply: (reply: string) => Effect.Effect<void>;
  readonly info: (message: string) => Effect.Effect<void>;
  readonly warn: (message: string) => Effect.Effect<void>;
}

export interface AutomationRunnerShape {
  readonly run: (
    target: ProfileTarget,
    automationId: string,
    trigger: AutomationRunTrigger,
  ) => Effect.Effect<AutomationRunReceipt, AutomationRunError>;
}

const liveDelivery: AutomationRunDelivery = {
  loadTelegramConfig: loadGatewayConfig,
  sendTelegramMessage: sendMessage,
  loadDiscordConfig: loadDiscordGatewayConfig,
  sendDiscordMessage: createMessage,
  loadSlackConfig: loadSlackGatewayConfig,
  sendSlackMessage: postMessage,
};

const liveOutput: AutomationRunOutput = {
  printReply: () => Effect.void,
  info: (message) => Effect.sync(() => console.error(message)),
  warn: (message) => Effect.sync(() => console.error(message)),
};

const causeMessage = (cause: unknown): string =>
  Inspectable.toStringUnknown(cause).replace(/\s+/g, " ").trim();

type GateResult =
  | { readonly kind: "exit"; readonly exitCode: number }
  | { readonly kind: "failed"; readonly cause: unknown }
  | { readonly kind: "timeout" };

const runGate = (profilePath: string, command: string): Effect.Effect<GateResult> =>
  Effect.gen(function* () {
    const spawned = yield* Effect.try({
      try: () =>
        Bun.spawn(["/bin/sh", "-c", command], {
          cwd: profilePath,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "",
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      catch: (cause) => new AutomationGateError({ operation: "spawn", cause }),
    }).pipe(
      Effect.map((process) => ({ ok: true as const, process })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
    );
    if (!spawned.ok) return { kind: "failed", cause: spawned.cause };

    return yield* Effect.tryPromise({
      try: (signal) => {
        const kill = () => killProcess(spawned.process);
        signal.addEventListener("abort", kill, { once: true });
        return spawned.process.exited.finally(() => signal.removeEventListener("abort", kill));
      },
      catch: (cause) => new AutomationGateError({ operation: "wait", cause }),
    }).pipe(
      Effect.timeoutOption(GATE_TIMEOUT),
      Effect.map(
        Option.match({
          onNone: (): GateResult => ({ kind: "timeout" }),
          onSome: (exitCode): GateResult => ({ kind: "exit", exitCode }),
        }),
      ),
      Effect.catch((cause) => Effect.succeed<GateResult>({ kind: "failed", cause })),
    );
  });

const runIdFor = (trigger: AutomationRunTrigger): string =>
  trigger.kind === "manual"
    ? crypto.randomUUID()
    : `scheduled-${createHash("sha256").update(trigger.firingId).digest("hex").slice(0, 32)}`;

const deliveryTargets = (automation: Automation): ReadonlyArray<AutomationDeliveryOutcome> => [
  ...(automation.telegramChat === undefined
    ? []
    : [{ target: `telegram:${automation.telegramChat}`, status: "pending" as const }]),
  ...(automation.discordChannel === undefined
    ? []
    : [{ target: `discord:${automation.discordChannel}`, status: "pending" as const }]),
  ...(automation.slackChannel === undefined
    ? []
    : [{ target: `slack:${automation.slackChannel}`, status: "pending" as const }]),
];

const initialReceipt = (
  automation: Automation,
  trigger: AutomationRunTrigger,
  now: string,
): AutomationRunReceipt => ({
  version: 1,
  runId: runIdFor(trigger),
  automationId: automation.id,
  trigger: trigger.kind,
  ...(trigger.kind === "scheduled"
    ? {
        scheduledInstant: trigger.scheduledInstant,
        firingId: trigger.firingId,
      }
    : {}),
  status: "running",
  claimedAt: now,
  deliveries: deliveryTargets(automation),
});

const terminal = (
  receipt: AutomationRunReceipt,
  status: Extract<AutomationRunReceipt["status"], "failed" | "skipped">,
  finishedAt: string,
  error: string,
): AutomationRunReceipt => ({
  ...receipt,
  status,
  finishedAt,
  error,
});

const deliveryFailure = (
  receipt: AutomationRunReceipt,
  target: string,
  finishedAt: string,
  cause: unknown,
): AutomationRunReceipt => ({
  ...receipt,
  deliveries: receipt.deliveries.map((outcome) =>
    outcome.target === target
      ? {
          ...outcome,
          status: "failed",
          finishedAt,
          error: causeMessage(cause),
        }
      : outcome,
  ),
});

const deliverySuccess = (
  receipt: AutomationRunReceipt,
  target: string,
  finishedAt: string,
): AutomationRunReceipt => ({
  ...receipt,
  deliveries: receipt.deliveries.map((outcome) =>
    outcome.target === target
      ? { ...outcome, status: "succeeded", finishedAt }
      : outcome,
  ),
});

const deliverOne = (
  delivery: AutomationRunDelivery,
  target: ProfileTarget,
  destination: string,
  reply: string,
): Effect.Effect<void, unknown> => {
  if (destination.startsWith("telegram:")) {
    const chatId = Number(destination.slice("telegram:".length));
    return delivery.loadTelegramConfig(target).pipe(
      Effect.flatMap((config) =>
        Effect.forEach(
          telegramMessageChunks(reply),
          (chunk) => delivery.sendTelegramMessage(config.botToken, chatId, chunk),
          { discard: true },
        ),
      ),
    );
  }
  if (destination.startsWith("discord:")) {
    const channelId = destination.slice("discord:".length);
    return delivery.loadDiscordConfig(target).pipe(
      Effect.flatMap((config) =>
        Effect.forEach(
          discordMessageChunks(reply),
          (chunk) => delivery.sendDiscordMessage(config.botToken, channelId, chunk),
          { discard: true },
        ),
      ),
    );
  }
  const channel = destination.slice("slack:".length);
  return delivery.loadSlackConfig(target).pipe(
    Effect.flatMap((config) =>
      Effect.forEach(
        slackMessageChunks(reply),
        (chunk) => delivery.sendSlackMessage(config.botToken, channel, chunk),
        { discard: true },
      ),
    ),
  );
};

export const makeAutomationRunner = (
  loader: AutomationDefinitionLoader,
  agent: ZiggyAgentShape,
  delivery: AutomationRunDelivery = liveDelivery,
  output: AutomationRunOutput = liveOutput,
  now: () => Date = () => new Date(),
): AutomationRunnerShape => ({
  run: (target, automationId, trigger) =>
    Effect.gen(function* () {
      const automation = yield* loader.read(target, automationId);
      const claimedAt = now();
      yield* recoverRunningAutomationReceipts(
        target,
        automation.id,
        claimedAt.toISOString(),
        "unknown",
        new Date(claimedAt.getTime() - 31 * 60_000).toISOString(),
      );
      let receipt = initialReceipt(automation, trigger, claimedAt.toISOString());
      yield* claimAutomationReceipt(target, receipt);
      if (trigger.kind === "scheduled" && trigger.skipReason !== undefined) {
        receipt = terminal(
          receipt,
          "skipped",
          now().toISOString(),
          trigger.skipReason,
        );
        yield* writeAutomationReceipt(target, receipt);
        return receipt;
      }

      const leased = yield* withAutomationRunLease(
        target,
        automation.id,
        Effect.gen(function* () {
          if (!automation.enabled) {
            receipt = terminal(
              receipt,
              "skipped",
              now().toISOString(),
              "Automation is disabled.",
            );
            yield* writeAutomationReceipt(target, receipt);
            yield* output.info(`[automation] ${automation.id}: disabled — skipped`);
            return receipt;
          }

          if (automation.gate !== undefined) {
            const gate = yield* runGate(target.path, automation.gate);
            if (gate.kind === "exit" && gate.exitCode !== 0) {
              receipt = terminal(
                receipt,
                "skipped",
                now().toISOString(),
                `Gate declined with exit code ${gate.exitCode}.`,
              );
              yield* writeAutomationReceipt(target, receipt);
              yield* output.info(`[automation] ${automation.id}: gate declined — skipped`);
              return receipt;
            }
            if (gate.kind !== "exit") {
              const detail =
                gate.kind === "timeout"
                  ? `timed out after ${GATE_TIMEOUT}`
                  : causeMessage(gate.cause);
              yield* output.warn(
                `[automation] ${automation.id}: gate failed (${detail}) — proceeding`,
              );
            }
          }

          const startedAt = now().toISOString();
          const sessionPath = join(
            target.path,
            "sessions",
            "automations",
            automation.id,
            receipt.runId,
          );
          receipt = { ...receipt, startedAt, sessionPath };
          yield* writeAutomationReceipt(target, receipt);

          const execution = yield* agent
            .openChat(target, { kind: "local" }, sessionPath, "fresh")
            .pipe(
              Effect.flatMap((handle) =>
                handle.prompt(automation.prompt).pipe(
                  Effect.ensuring(
                    handle.dispose.pipe(
                      Effect.catch((failure) =>
                        output.warn(
                          `[automation] ${automation.id}: session dispose failed — ${failure.message}`,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              Effect.timeoutOption(RUN_TIMEOUT),
              Effect.result,
            );

          if (Result.isFailure(execution)) {
            receipt = terminal(
              receipt,
              "failed",
              now().toISOString(),
              causeMessage(execution.failure),
            );
            yield* writeAutomationReceipt(target, receipt);
            return receipt;
          }
          if (Option.isNone(execution.success)) {
            receipt = terminal(
              receipt,
              "failed",
              now().toISOString(),
              `Run timed out after ${RUN_TIMEOUT}.`,
            );
            yield* writeAutomationReceipt(target, receipt);
            return receipt;
          }

          const reply = execution.success.value;
          receipt = {
            ...receipt,
            status: "succeeded",
            finishedAt: now().toISOString(),
            localOutput: reply,
          };
          yield* writeAutomationReceipt(target, receipt);
          yield* output.printReply(reply);

          for (const outcome of receipt.deliveries) {
            const delivered = yield* deliverOne(
              delivery,
              target,
              outcome.target,
              reply,
            ).pipe(Effect.result);
            const finishedAt = now().toISOString();
            receipt = Result.isSuccess(delivered)
              ? deliverySuccess(receipt, outcome.target, finishedAt)
              : deliveryFailure(receipt, outcome.target, finishedAt, delivered.failure);
            yield* writeAutomationReceipt(target, receipt);
          }
          return receipt;
        }),
      ).pipe(
        Effect.catchTag("AutomationRunLeaseError", (failure) =>
          Effect.gen(function* () {
            receipt = terminal(
              receipt,
              failure.busy ? "skipped" : "failed",
              now().toISOString(),
              failure.message,
            );
            yield* writeAutomationReceipt(target, receipt);
            return receipt;
          }),
        ),
      );
      return leased;
    }),
});
