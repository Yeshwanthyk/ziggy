import { join, relative } from "node:path";
import { Context, Effect, Layer, Result } from "effect";
import {
  automationDefinitionTemplate,
  automationFileStore,
  createAutomationDefinition,
  discoverAutomationSources,
  pauseAutomationDefinition,
  replaceAutomationDefinition,
  resumeAutomationDefinition,
  type AutomationLifecycle,
} from "../adapters/fs/automation-files";
import {
  type Automation,
  type AutomationEditConflict,
  type AutomationFileSystemError,
  type AutomationInvalid,
  AutomationNotFound,
  type AutomationPaused,
  type AutomationProjectionError,
  parseAutomationFile,
  validateAutomationId,
} from "../domain/automation";
import type { ProfileTarget } from "../domain/profile";

export interface AutomationDefinitionProjection {
  readonly id: string;
  readonly path: string;
  readonly valid: boolean;
  readonly lifecycle: AutomationLifecycle | "conflict";
  readonly schedule?: string;
  readonly timezone?: string;
  readonly gateState?: "scheduled" | "manual-only";
  readonly message?: string;
}

export interface AutomationDefinitionTransitionProjection {
  readonly id: string;
  readonly path: string;
  readonly lifecycle: AutomationLifecycle;
}

export interface AutomationDefinitionDocument {
  readonly id: string;
  readonly path: string;
  readonly lifecycle: AutomationLifecycle;
  readonly source: string;
}

export type AutomationDefinitionsError =
  | AutomationEditConflict
  | AutomationFileSystemError
  | AutomationInvalid
  | AutomationProjectionError
  | AutomationNotFound
  | AutomationPaused;

export interface AutomationDefinitionsShape {
  readonly create: (
    target: ProfileTarget,
    id: string,
  ) => Effect.Effect<AutomationDefinitionProjection, AutomationDefinitionsError>;
  readonly show: (
    target: ProfileTarget,
    id: string,
  ) => Effect.Effect<AutomationDefinitionDocument, AutomationDefinitionsError>;
  readonly save: (
    target: ProfileTarget,
    id: string,
    expectedSource: string,
    source: string,
  ) => Effect.Effect<AutomationDefinitionDocument, AutomationDefinitionsError>;
  readonly pause: (
    target: ProfileTarget,
    id: string,
  ) => Effect.Effect<AutomationDefinitionTransitionProjection, AutomationDefinitionsError>;
  readonly resume: (
    target: ProfileTarget,
    id: string,
  ) => Effect.Effect<AutomationDefinitionTransitionProjection, AutomationDefinitionsError>;
  readonly list: (
    target: ProfileTarget,
  ) => Effect.Effect<ReadonlyArray<AutomationDefinitionProjection>, AutomationProjectionError>;
  readonly validate: (
    target: ProfileTarget,
    id?: string,
  ) => Effect.Effect<ReadonlyArray<AutomationDefinitionProjection>, AutomationDefinitionsError>;
}

export class AutomationDefinitions extends Context.Service<
  AutomationDefinitions,
  AutomationDefinitionsShape
>()("ziggy/AutomationDefinitions") {}

const validProjection = (
  profilePath: string,
  path: string,
  automation: Automation,
  lifecycle: AutomationLifecycle,
): AutomationDefinitionProjection => ({
  id: automation.id,
  path: relative(profilePath, path),
  valid: true,
  lifecycle,
  schedule: automation.schedule.cronSource,
  timezone: automation.schedule.timezone,
  gateState: automation.gate === undefined ? "manual-only" : "scheduled",
});

const catalog = (target: ProfileTarget) =>
  Effect.gen(function* () {
    const sources = yield* discoverAutomationSources(target);
    const rows: Array<AutomationDefinitionProjection> = [];
    for (const source of sources) {
      if (source.lifecycle === "conflict") {
        rows.push({
          id: source.idSource,
          path: relative(target.path, source.path),
          valid: false,
          lifecycle: "conflict",
          message: source.error ?? "automation has conflicting active and paused definitions",
        });
        continue;
      }
      const sourceText = source.source;
      if (sourceText === null) {
        rows.push({
          id: source.idSource,
          path: relative(target.path, source.path),
          valid: false,
          lifecycle: source.lifecycle,
          message: source.error ?? "automation definition is unreadable",
        });
        continue;
      }
      const parsed = yield* Effect.gen(function* () {
        const id = yield* validateAutomationId(source.idSource);
        return yield* parseAutomationFile(id, source.path, sourceText);
      }).pipe(Effect.result);
      rows.push(
        Result.isSuccess(parsed)
          ? validProjection(target.path, source.path, parsed.success, source.lifecycle)
          : {
              id: source.idSource,
              path: relative(target.path, source.path),
              valid: false,
              lifecycle: source.lifecycle,
              message: parsed.failure.message,
            },
      );
    }
    return rows;
  });

export const makeAutomationDefinitions = (): AutomationDefinitionsShape => ({
  create: (target, idSource) =>
    Effect.gen(function* () {
      const id = yield* validateAutomationId(idSource);
      const source = automationDefinitionTemplate(id);
      const path = join(target.path, "automations", `${id}.md`);
      const automation = yield* parseAutomationFile(id, path, source);
      const created = yield* createAutomationDefinition(target, id);
      return validProjection(target.path, created.path, automation, created.lifecycle);
    }),
  show: (target, idSource) =>
    Effect.gen(function* () {
      const id = yield* validateAutomationId(idSource);
      const document = yield* automationFileStore.readDefinition(target, id, true);
      return {
        id,
        path: relative(target.path, document.path),
        lifecycle: document.lifecycle,
        source: document.source,
      };
    }),
  save: (target, idSource, expectedSource, source) =>
    Effect.gen(function* () {
      const id = yield* validateAutomationId(idSource);
      const current = yield* automationFileStore.readDefinition(target, id, true);
      yield* parseAutomationFile(id, current.path, source);
      const saved = yield* replaceAutomationDefinition(target, id, expectedSource, source);
      return {
        id,
        path: relative(target.path, saved.path),
        lifecycle: saved.lifecycle,
        source: saved.source,
      };
    }),
  pause: (target, idSource) =>
    Effect.gen(function* () {
      const id = yield* validateAutomationId(idSource);
      const transitioned = yield* pauseAutomationDefinition(target, id);
      return {
        id,
        path: relative(target.path, transitioned.path),
        lifecycle: transitioned.lifecycle,
      };
    }),
  resume: (target, idSource) =>
    Effect.gen(function* () {
      const id = yield* validateAutomationId(idSource);
      const transitioned = yield* resumeAutomationDefinition(target, id);
      return {
        id,
        path: relative(target.path, transitioned.path),
        lifecycle: transitioned.lifecycle,
      };
    }),
  list: catalog,
  validate: (target, idSource) =>
    Effect.gen(function* () {
      const id = idSource === undefined ? undefined : yield* validateAutomationId(idSource);
      const rows = yield* catalog(target);
      if (id === undefined) return rows;
      const selected = rows.filter((row) => row.id === id);
      if (selected.length === 0) {
        return yield* new AutomationNotFound({
          id,
          path: join(target.path, "automations", `${id}.md`),
          message: `no automation ${id} in ${target.path}`,
        });
      }
      return selected;
    }),
});

export const AutomationDefinitionsLive = Layer.succeed(
  AutomationDefinitions,
  makeAutomationDefinitions(),
);
