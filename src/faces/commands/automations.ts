import { Clock, Effect, Result } from "effect";
import { readUiServerProjection } from "../../adapters/bun/ui-server";
import { AutomationDefinitions } from "../../application/automation-definitions";
import { AutomationScheduler } from "../../application/automation-scheduler";
import { Automations } from "../../application/automations";
import { ResidentService } from "../../application/resident-service";
import { validateAutomationId, type AutomationRunOutcome } from "../../domain/automation";
import { fileSystemCauseDetails } from "../../platform/cause";
import { ZiggyPaths } from "../../platform/paths";
import { resolveProfileTarget } from "../../profile";
import {
  renderAutomationCreated,
  renderAutomationDefinitions,
  renderAutomationDefinitionsJson,
  renderAutomationOutcome,
  renderAutomationRuns,
  renderAutomationRunsJson,
  renderAutomationStatus,
  renderAutomationStatusJson,
  renderAutomationTransition,
  renderAutomationValidation,
  RESIDENT_SCHEDULE_HINT,
} from "../automation-cli";
import type { CliCommand } from "../cli-command";
import { CliCommandFailed } from "../cli-exit";
import { wakeInResident } from "../wake-resident";

export type AutomationsCommand = Extract<
  CliCommand,
  {
    readonly _tag:
      | "AutomationsCreate"
      | "AutomationsList"
      | "AutomationsPause"
      | "AutomationsResume"
      | "AutomationsValidate"
      | "AutomationsStatus"
      | "AutomationsRuns"
      | "Wake";
  }
>;

export const runAutomationsCommand = (command: AutomationsCommand) =>
  Effect.gen(function* () {
    const automationDefinitions = yield* AutomationDefinitions;
    const automationScheduler = yield* AutomationScheduler;
    const automations = yield* Automations;
    const residentService = yield* ResidentService;
    const paths = yield* ZiggyPaths;

    switch (command._tag) {
      case "AutomationsCreate": {
        const created = yield* automationDefinitions.create(
          resolveProfileTarget(command.target, paths),
          command.automationId,
        );

        console.log(renderAutomationCreated(created));

        return;
      }

      case "AutomationsList": {
        const listed = yield* automationDefinitions.list(
          resolveProfileTarget(command.target, paths),
        );

        console.log(
          command.json
            ? renderAutomationDefinitionsJson(listed)
            : renderAutomationDefinitions(listed),
        );

        return;
      }

      case "AutomationsPause":
      case "AutomationsResume": {
        const definition = yield* command._tag === "AutomationsPause"
          ? automationDefinitions.pause(
              resolveProfileTarget(command.target, paths),
              command.automationId,
            )
          : automationDefinitions.resume(
              resolveProfileTarget(command.target, paths),
              command.automationId,
            );

        console.log(
          renderAutomationTransition(
            command._tag === "AutomationsPause" ? "paused" : "resumed",
            definition,
          ),
        );

        return;
      }

      case "AutomationsValidate": {
        const validation = yield* automationDefinitions.validate(
          resolveProfileTarget(command.target, paths),
          command.automationId,
        );

        console.log(renderAutomationValidation(validation));

        return validation.some((item) => !item.valid) ? 1 : 0;
      }

      case "AutomationsStatus": {
        const target = resolveProfileTarget(command.target, paths);
        const status = yield* automationScheduler.status(target);

        console.log(
          command.json ? renderAutomationStatusJson(status) : renderAutomationStatus(status),
        );

        if (!command.json) {
          const service = yield* residentService.status(target);

          if (Result.isSuccess(service.managed) && service.managed.success._tag === "not-installed")
            console.log(
              RESIDENT_SCHEDULE_HINT(
                target.path,
                (yield* residentService.owner(target))._tag === "running",
              ),
            );
        }

        return;
      }

      case "AutomationsRuns": {
        const automationId =
          command.automationId === undefined
            ? undefined
            : yield* validateAutomationId(command.automationId);

        const runs = yield* automationScheduler.runs(
          resolveProfileTarget(command.target, paths),
          automationId,
        );

        console.log(
          command.json
            ? renderAutomationRunsJson(runs)
            : renderAutomationRuns(runs, yield* Clock.currentTimeMillis),
        );

        return;
      }

      case "Wake": {
        const target = resolveProfileTarget(command.target, paths);
        const owner = yield* residentService.owner(target);
        let outcome: AutomationRunOutcome;

        if (owner._tag === "running") {
          const projection = yield* readUiServerProjection(target.path).pipe(
            Effect.mapError((failure) =>
              fileSystemCauseDetails(failure.cause).code === "ENOENT"
                ? new CliCommandFailed({ message: "resident is starting; retry" })
                : failure,
            ),
          );

          const result = yield* wakeInResident(target, command.automationId, projection);
          outcome = result.runOutcome;
        } else {
          outcome = yield* automations.run(target, command.automationId, {
            kind: "manual-force",
          });
        }

        const rendered = renderAutomationOutcome(outcome);

        for (const line of rendered.stderr) console.error(line);

        return rendered.exitCode;
      }
    }
  });
