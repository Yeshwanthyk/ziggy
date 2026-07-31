import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Result } from "effect";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import {
  AutomationExists,
  AutomationFileSystemError,
  AutomationInvalid,
  AutomationNotFound,
  type Automation,
  type AutomationWriteInput,
  parseAutomationFile,
  renderAutomationFile,
  validateAutomationId,
  validateAutomationWriteInput,
} from "../domain/automation";
import type { AutomationRunReceipt } from "../domain/automation-run";
import { nextAutomationScheduleInstant } from "../domain/automation-schedule";
import type { AutomationServiceFileSystemError } from "../domain/automation-service";
import type { ProfileTarget } from "../domain/profile";
import { ZiggyAgent, type ZiggyAgentShape } from "./agent";
import { schedulerHealthStatus } from "./automation-health";
import {
  type AutomationReceiptError,
  latestAutomationReceipt,
  listAutomationReceipts,
} from "./automation-receipts";
import {
  type AutomationRunDelivery,
  type AutomationRunError,
  type AutomationRunOutput,
  type AutomationRunTrigger,
  makeAutomationRunner,
} from "./automation-runner";

export type AutomationError =
  | AutomationInvalid
  | AutomationExists
  | AutomationNotFound
  | AutomationFileSystemError
  | AutomationRunError
  | AutomationReceiptError
  | AutomationServiceFileSystemError;

export interface AutomationsShape {
  readonly list: (
    target: ProfileTarget,
  ) => Effect.Effect<
    AutomationInventory,
    AutomationFileSystemError | AutomationReceiptError | AutomationServiceFileSystemError
  >;
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
  ) => Effect.Effect<AutomationRunReceipt, AutomationError>;
  readonly run: (
    target: ProfileTarget,
    automationId: string,
    trigger: AutomationRunTrigger,
  ) => Effect.Effect<AutomationRunReceipt, AutomationError>;
  readonly history: (
    target: ProfileTarget,
    automationId: string,
  ) => Effect.Effect<ReadonlyArray<AutomationRunReceipt>, AutomationError>;
}

export interface AutomationDiagnostic {
  readonly id: string;
  readonly path: string;
  readonly message: string;
}

export interface AutomationInventory {
  readonly automations: ReadonlyArray<Automation>;
  readonly latestRuns: ReadonlyArray<AutomationRunReceipt>;
  readonly nextRuns: ReadonlyArray<{
    readonly automationId: string;
    readonly instant: string;
  }>;
  readonly scheduler: {
    readonly online: boolean;
    readonly heartbeatAt?: string;
  };
  readonly diagnostics: ReadonlyArray<AutomationDiagnostic>;
}

export class Automations extends Context.Service<Automations, AutomationsShape>()(
  "ziggy/Automations",
) {}

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
    const latestRuns: Array<AutomationRunReceipt> = [];
    const nextRuns: Array<{ readonly automationId: string; readonly instant: string }> = [];
    const diagnostics: Array<AutomationDiagnostic> = [];
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of files) {
      const id = entry.name.slice(0, -3);
      const result = yield* readAutomation(target, id).pipe(Effect.result);
      if (Result.isSuccess(result)) {
        const automation = result.success;
        automations.push(automation);
        const latest = yield* latestAutomationReceipt(target, automation.id);
        if (latest !== undefined) {
          latestRuns.push(latest);
        }
        if (automation.schedule !== undefined) {
          const next = nextAutomationScheduleInstant(automation.schedule, new Date());
          if (next !== undefined) {
            nextRuns.push({ automationId: automation.id, instant: next.toISOString() });
          }
        }
      } else {
        diagnostics.push({
          id,
          path: automationPath(target, id),
          message: result.failure.message,
        });
      }
    }
    const schedulerHealth = yield* schedulerHealthStatus(target);
    return {
      automations,
      latestRuns,
      nextRuns,
      scheduler: {
        online: schedulerHealth.fresh,
        ...(schedulerHealth.heartbeatAt === undefined
          ? {}
          : { heartbeatAt: schedulerHealth.heartbeatAt }),
      },
      diagnostics,
    };
  });

const normalizeAutomation = (
  input: AutomationWriteInput,
): Effect.Effect<Automation, AutomationInvalid> =>
  validateAutomationWriteInput(input).pipe(
    Effect.map((validated) => ({ ...validated, version: 1 })),
  );

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
  Effect.gen(function* () {
    const automation = yield* normalizeAutomation(input);
    return yield* writeNewAutomation(target, automation);
  });

const makeUpdate = (): AutomationsShape["update"] => (target, input) =>
  Effect.gen(function* () {
    const automation = yield* normalizeAutomation(input);
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

export const makeAutomations = (
  agent: ZiggyAgentShape,
  delivery?: AutomationRunDelivery,
  output?: AutomationRunOutput,
): AutomationsShape => {
  const runner = makeAutomationRunner({ read: readAutomation }, agent, delivery, output);
  return {
    list: makeList(),
    create: makeCreate(),
    update: makeUpdate(),
    remove: makeRemove(),
    run: runner.run,
    wake: (target, automationId) => runner.run(target, automationId, { kind: "manual" }),
    history: listAutomationReceipts,
  };
};

export const AutomationsLive = Layer.effect(
  Automations,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    return makeAutomations(agent);
  }),
);
