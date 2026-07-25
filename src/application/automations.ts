import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Option } from "effect";
import { sendMessage, type TelegramApiError } from "../adapters/telegram/api";
import {
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

const causeCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const causeMessage = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").trim();

const readAutomation = (target: ProfileTarget, idSource: string) =>
  Effect.gen(function* () {
    const id = yield* validateAutomationId(idSource);
    const filePath = join(target.path, "automations", `${id}.md`);
    const source = yield* Effect.tryPromise({
      try: () => readFile(filePath, "utf8"),
      catch: (cause) =>
        causeCode(cause) === "ENOENT"
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
          try {
            spawned.process.kill();
          } catch {
            // The process may have exited between the timeout and interruption.
          }
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
  target: ProfileTarget,
  id: string,
  chatId: number,
  text: string,
): Effect.Effect<void, TelegramApiError> =>
  Effect.gen(function* () {
    const loaded = yield* loadGatewayConfig(target).pipe(
      Effect.map((config) => ({ ok: true as const, config })),
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(`[wake] ${id}: Telegram delivery skipped — ${error.message}`);
          return { ok: false as const };
        }),
      ),
    );
    if (!loaded.ok) {
      return;
    }

    for (const chunk of telegramMessageChunks(text)) {
      yield* sendMessage(loaded.config.botToken, chatId, chunk);
    }
  });

const makeWake =
  (agent: ZiggyAgentShape): AutomationsShape["wake"] =>
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
            Effect.catch((error) =>
              Effect.sync(() => {
                console.error(`[wake] ${automation.id}: session dispose failed — ${error.message}`);
              }),
            ),
          ),
        ),
      );

      console.log(reply);
      if (automation.telegramChat !== undefined) {
        yield* deliverTelegram(target, automation.id, automation.telegramChat, reply);
      }
    });

export const AutomationsLive = Layer.effect(
  Automations,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    return { wake: makeWake(agent) };
  }),
);
