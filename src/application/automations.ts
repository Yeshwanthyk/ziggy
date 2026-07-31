import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Inspectable, Layer, Option, Result } from "effect";
import { killProcess } from "../adapters/bun/process";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import { sendMessage, type TelegramApiError } from "../adapters/telegram/api";
import {
  AutomationDeliveryUnavailable,
  AutomationExists,
  AutomationFileSystemError,
  AutomationInvalid,
  AutomationNotFound,
  type Automation,
  type AutomationWriteInput,
  parseAutomationFile,
  renderAutomationFile,
  validateAutomationId,
} from "../domain/automation";
import type { ZiggyAgentError } from "../domain/agent";
import type { ProfileTarget } from "../domain/profile";
import { ZiggyAgent, type ZiggyAgentShape } from "./agent";
import { loadGatewayConfig, telegramMessageChunks } from "./gateway";

const GATE_TIMEOUT = "30 seconds";

export type AutomationError =
  | AutomationInvalid
  | AutomationExists
  | AutomationNotFound
  | AutomationFileSystemError
  | AutomationDeliveryUnavailable
  | ZiggyAgentError
  | TelegramApiError;

export interface AutomationsShape {
  readonly list: (
    target: ProfileTarget,
  ) => Effect.Effect<AutomationInventory, AutomationFileSystemError>;
  readonly create: (
    target: ProfileTarget,
    input: AutomationWriteInput,
  ) => Effect.Effect<Automation, AutomationInvalid | AutomationExists | AutomationFileSystemError>;
  readonly update: (
    target: ProfileTarget,
    input: AutomationWriteInput,
  ) => Effect.Effect<Automation, AutomationInvalid | AutomationNotFound | AutomationFileSystemError>;
  readonly remove: (
    target: ProfileTarget,
    automationId: string,
  ) => Effect.Effect<void, AutomationInvalid | AutomationNotFound | AutomationFileSystemError>;
  readonly wake: (
    target: ProfileTarget,
    automationId: string,
  ) => Effect.Effect<void, AutomationError>;
}

export interface AutomationDiagnostic {
  readonly id: string;
  readonly path: string;
  readonly message: string;
}

export interface AutomationInventory {
  readonly automations: ReadonlyArray<Automation>;
  readonly diagnostics: ReadonlyArray<AutomationDiagnostic>;
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

export const readAutomation = (target: ProfileTarget, idSource: string) =>
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

const automationDirectory = (target: ProfileTarget) => join(target.path, "automations");
const automationPath = (target: ProfileTarget, id: string) =>
  join(automationDirectory(target), `${id}.md`);

const makeList = (): AutomationsShape["list"] => (target) =>
  Effect.gen(function* () {
    const directory = automationDirectory(target);
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) =>
        new AutomationFileSystemError({
          path: directory,
          message: `could not list automations at ${directory}`,
          cause,
        }),
    }).pipe(
      Effect.catchTag("AutomationFileSystemError", (failure) =>
        fileSystemCauseDetails(failure.cause).code === "ENOENT"
          ? Effect.succeed([])
          : Effect.fail(failure),
      ),
    );

    const automations: Array<Automation> = [];
    const diagnostics: Array<AutomationDiagnostic> = [];
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of files) {
      const id = entry.name.slice(0, -3);
      const result = yield* readAutomation(target, id).pipe(Effect.result);
      if (Result.isSuccess(result)) {
        automations.push(result.success);
      } else {
        diagnostics.push({
          id,
          path: automationPath(target, id),
          message: result.failure.message,
        });
      }
    }
    return { automations, diagnostics };
  });

const normalizeAutomation = (input: AutomationWriteInput): Automation => ({
  ...input,
  version: 1,
});

const writeNewAutomation = (target: ProfileTarget, automation: Automation) =>
  Effect.gen(function* () {
    const directory = automationDirectory(target);
    const filePath = automationPath(target, automation.id);
    const temporaryPath = join(directory, `.${automation.id}.${crypto.randomUUID()}.tmp`);
    yield* Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true }),
      catch: (cause) =>
        new AutomationFileSystemError({
          path: directory,
          message: `could not create ${directory}`,
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () => writeFile(temporaryPath, renderAutomationFile(automation), { mode: 0o600 }),
      catch: (cause) =>
        new AutomationFileSystemError({
          path: temporaryPath,
          message: `could not write ${temporaryPath}`,
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () => link(temporaryPath, filePath),
      catch: (cause) =>
        fileSystemCauseDetails(cause).code === "EEXIST"
          ? new AutomationExists({
              id: automation.id,
              path: filePath,
              message: `automation ${automation.id} already exists at ${filePath}`,
            })
          : new AutomationFileSystemError({
              path: filePath,
              message: `could not create ${filePath}`,
              cause,
            }),
    }).pipe(
      Effect.ensuring(
        Effect.tryPromise({
          try: () => rm(temporaryPath, { force: true }),
          catch: (cause) =>
            new AutomationFileSystemError({
              path: temporaryPath,
              message: `could not clean up ${temporaryPath}`,
              cause,
            }),
        }).pipe(
          Effect.catchTag("AutomationFileSystemError", (failure) =>
            Effect.sync(() => console.error(failure.message)),
          ),
        ),
      ),
    );
    return automation;
  });

const makeCreate = (): AutomationsShape["create"] => (target, input) =>
  writeNewAutomation(target, normalizeAutomation(input));

const makeUpdate = (): AutomationsShape["update"] => (target, input) =>
  Effect.gen(function* () {
    const automation = normalizeAutomation(input);
    const filePath = automationPath(target, automation.id);
    yield* readAutomation(target, automation.id);
    const temporaryPath = join(
      automationDirectory(target),
      `.${automation.id}.${crypto.randomUUID()}.tmp`,
    );
    yield* Effect.tryPromise({
      try: () => writeFile(temporaryPath, renderAutomationFile(automation), { mode: 0o600 }),
      catch: (cause) =>
        new AutomationFileSystemError({
          path: temporaryPath,
          message: `could not write ${temporaryPath}`,
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () => rename(temporaryPath, filePath),
      catch: (cause) =>
        new AutomationFileSystemError({
          path: filePath,
          message: `could not replace ${filePath}`,
          cause,
        }),
    }).pipe(
      Effect.ensuring(
        Effect.tryPromise({
          try: () => rm(temporaryPath, { force: true }),
          catch: (cause) =>
            new AutomationFileSystemError({
              path: temporaryPath,
              message: `could not clean up ${temporaryPath}`,
              cause,
            }),
        }).pipe(
          Effect.catchTag("AutomationFileSystemError", (failure) =>
            Effect.sync(() => console.error(failure.message)),
          ),
        ),
      ),
    );
    return automation;
  });

const makeRemove = (): AutomationsShape["remove"] => (target, idSource) =>
  Effect.gen(function* () {
    const id = yield* validateAutomationId(idSource);
    const filePath = automationPath(target, id);
    yield* Effect.tryPromise({
      try: () => rm(filePath),
      catch: (cause) =>
        fileSystemCauseDetails(cause).code === "ENOENT"
          ? new AutomationNotFound({
              id,
              path: filePath,
              message: `no automation ${id} at ${filePath}`,
            })
          : new AutomationFileSystemError({
              path: filePath,
              message: `could not remove ${filePath}`,
              cause,
            }),
    });
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
      if (!automation.enabled) {
        console.log(`[wake] ${automation.id}: disabled — no model call`);
        return;
      }

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
): AutomationsShape => ({
  list: makeList(),
  create: makeCreate(),
  update: makeUpdate(),
  remove: makeRemove(),
  wake: makeWake(agent, delivery, output),
});

export const AutomationsLive = Layer.effect(
  Automations,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    return makeAutomations(agent);
  }),
);
