import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Inspectable, Layer, Option } from "effect";
import { killProcess } from "../adapters/bun/process";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import { sendMessage, type TelegramApiError } from "../adapters/telegram/api";
import {
  AutomationDeliveryUnavailable,
  AutomationFileSystemError,
  AutomationInvalid,
  AutomationNotFound,
  parseAutomationFile,
  validateAutomationId,
} from "../domain/automation";
import type { ZiggyAgentError } from "../domain/agent";
import type { ProfileTarget } from "../domain/profile";
import { ZiggyAgent, type ZiggyAgentShape } from "./agent";
import { loadGatewayConfig, telegramMessageChunks } from "./gateway";

const GATE_TIMEOUT = "30 seconds";

export type AutomationError =
  | AutomationInvalid
  | AutomationNotFound
  | AutomationFileSystemError
  | AutomationDeliveryUnavailable
  | ZiggyAgentError
  | TelegramApiError;

export interface AutomationsShape {
  readonly wake: (
    target: ProfileTarget,
    automationId: string,
  ) => Effect.Effect<void, AutomationError>;
}

export class Automations extends Context.Service<Automations, AutomationsShape>()(
  "ziggy/Automations",
) {}

export interface AutomationDelivery {
  readonly loadTelegramConfig: typeof loadGatewayConfig;
  readonly sendTelegramMessage: typeof sendMessage;
}

export interface AutomationOutput {
  readonly printReply: (reply: string) => Effect.Effect<void>;
}

const liveDelivery: AutomationDelivery = {
  loadTelegramConfig: loadGatewayConfig,
  sendTelegramMessage: sendMessage,
};

const liveOutput: AutomationOutput = {
  printReply: (reply) => Effect.sync(() => console.log(reply)),
};

const causeMessage = (cause: unknown): string =>
  Inspectable.toStringUnknown(cause).replace(/\s+/g, " ").trim();

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
      catch: (cause) => cause,
    }).pipe(
      Effect.map((process) => ({ ok: true as const, process })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
    );

    if (!spawned.ok) {
      return { kind: "failed", cause: spawned.cause };
    }

    const exit = yield* Effect.tryPromise({
      try: (signal) => {
        const kill = () => {
          killProcess(spawned.process);
        };
        signal.addEventListener("abort", kill, { once: true });
        return spawned.process.exited.finally(() => signal.removeEventListener("abort", kill));
      },
      catch: (cause) => cause,
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

    return exit;
  });

const warnGateFailure = (id: string, result: Exclude<GateResult, { readonly kind: "exit" }>) =>
  Effect.sync(() => {
    const detail =
      result.kind === "timeout" ? `timed out after ${GATE_TIMEOUT}` : causeMessage(result.cause);
    console.error(`[wake] ${id}: gate failed (${detail}) — proceeding`);
  });

const deliverTelegram = (
  delivery: AutomationDelivery,
  target: ProfileTarget,
  id: string,
  chatId: number,
  text: string,
): Effect.Effect<void, AutomationDeliveryUnavailable | TelegramApiError> =>
  Effect.gen(function* () {
    const configPath = join(target.path, "telegram.json");
    const config = yield* delivery.loadTelegramConfig(target).pipe(
      Effect.mapError(
        (cause) =>
          new AutomationDeliveryUnavailable({
            automationId: id,
            channel: "telegram",
            path: configPath,
            message: `automation ${id} requested Telegram delivery, but ${configPath} is unavailable`,
            cause,
          }),
      ),
    );

    for (const chunk of telegramMessageChunks(text)) {
      yield* delivery.sendTelegramMessage(config.botToken, chatId, chunk);
    }
  });

const makeWake =
  (
    agent: ZiggyAgentShape,
    delivery: AutomationDelivery,
    output: AutomationOutput,
  ): AutomationsShape["wake"] =>
  (target, automationId) =>
    Effect.gen(function* () {
      const automation = yield* readAutomation(target, automationId);

      if (automation.gate !== undefined) {
        const gate = yield* runGate(target.path, automation.gate);
        if (gate.kind === "exit" && gate.exitCode !== 0) {
          console.log(`[wake] ${automation.id}: gate declined — no model call`);
          return;
        }
        if (gate.kind !== "exit") {
          yield* warnGateFailure(automation.id, gate);
        }
      }

      const handle = yield* agent.openChat(
        target,
        { kind: "local" },
        join(target.path, "sessions", "automations", automation.id),
        "fresh",
      );
      const reply = yield* handle.prompt(automation.prompt).pipe(
        Effect.ensuring(
          handle.dispose.pipe(
            Effect.catch((failure) =>
              Effect.sync(() => {
                console.error(
                  `[wake] ${automation.id}: session dispose failed — ${failure.message}`,
                );
              }),
            ),
          ),
        ),
      );

      yield* output.printReply(reply);
      if (automation.telegramChat !== undefined) {
        yield* deliverTelegram(delivery, target, automation.id, automation.telegramChat, reply);
      }
    });

export const makeAutomations = (
  agent: ZiggyAgentShape,
  delivery: AutomationDelivery = liveDelivery,
  output: AutomationOutput = liveOutput,
): AutomationsShape => ({ wake: makeWake(agent, delivery, output) });

export const AutomationsLive = Layer.effect(
  Automations,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    return makeAutomations(agent);
  }),
);
