import { join, relative } from "node:path";
import { Context, Effect, Layer, Result } from "effect";
import {
  automationDefinitionTemplate,
  createAutomationDefinition,
  discoverAutomationSources,
} from "../adapters/fs/automation-files";
import {
  type Automation,
  type AutomationFileSystemError,
  type AutomationInvalid,
  AutomationNotFound,
  type AutomationProjectionError,
  parseAutomationFile,
  validateAutomationId,
} from "../domain/automation";
import type { ProfileTarget } from "../domain/profile";

export interface AutomationDefinitionProjection {
  readonly id: string;
  readonly path: string;
  readonly valid: boolean;
  readonly schedule?: string;
  readonly timezone?: string;
  readonly gateState?: "scheduled" | "manual-only";
  readonly message?: string;
}

export type AutomationDefinitionsError =
  | AutomationFileSystemError
  | AutomationInvalid
  | AutomationProjectionError
  | AutomationNotFound;

export interface AutomationDefinitionsShape {
  readonly create: (
    target: ProfileTarget,
    id: string,
  ) => Effect.Effect<AutomationDefinitionProjection, AutomationDefinitionsError>;
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
): AutomationDefinitionProjection => ({
  id: automation.id,
  path: relative(profilePath, path),
  valid: true,
  schedule: automation.schedule.cronSource,
  timezone: automation.schedule.timezone,
  gateState: automation.gate === undefined ? "manual-only" : "scheduled",
});

const catalog = (target: ProfileTarget) =>
  Effect.gen(function* () {
    const sources = yield* discoverAutomationSources(target);
    const rows: Array<AutomationDefinitionProjection> = [];
    for (const source of sources) {
      const sourceText = source.source;
      if (sourceText === null) {
        rows.push({
          id: source.idSource,
          path: relative(target.path, source.path),
          valid: false,
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
          ? validProjection(target.path, source.path, parsed.success)
          : {
              id: source.idSource,
              path: relative(target.path, source.path),
              valid: false,
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
      return validProjection(target.path, created.path, automation);
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
