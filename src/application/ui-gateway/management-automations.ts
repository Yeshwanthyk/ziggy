import { Effect, Schema } from "effect";

import {
  UiAutomationCreateParams,
  UiAutomationId,
  UiAutomationListParams,
  UiAutomationPauseParams,
  UiAutomationResumeParams,
  UiAutomationRunParams,
  UiAutomationRunsParams,
  UiAutomationSaveParams,
  UiAutomationShowParams,
  UiAutomationStatusParams,
  UiAutomationValidateParams,
  UiGatewayError,
  UI_METHODS,
  type UiGatewayResult,
  type UiRequestEnvelope,
} from "../../domain/ui-gateway";
import type { AutomationRunProjection } from "../../domain/automation";
import { validateAutomationId } from "../../domain/automation";

import type { ProfileId } from "../../domain/profile-directory";
import type { UiGatewayBranch, UiGatewayDependencies } from "./types";
import { badParams, boundedText, noService, protocolFailure, toGatewayError } from "./errors";

const decodeAutomationList = Schema.decodeUnknownEffect(UiAutomationListParams, {
  onExcessProperty: "error",
});

const decodeAutomationShow = Schema.decodeUnknownEffect(UiAutomationShowParams, {
  onExcessProperty: "error",
});

const decodeAutomationCreate = Schema.decodeUnknownEffect(UiAutomationCreateParams, {
  onExcessProperty: "error",
});

const decodeAutomationSave = Schema.decodeUnknownEffect(UiAutomationSaveParams, {
  onExcessProperty: "error",
});

const decodeAutomationValidate = Schema.decodeUnknownEffect(UiAutomationValidateParams, {
  onExcessProperty: "error",
});

const decodeAutomationPause = Schema.decodeUnknownEffect(UiAutomationPauseParams, {
  onExcessProperty: "error",
});

const decodeAutomationResume = Schema.decodeUnknownEffect(UiAutomationResumeParams, {
  onExcessProperty: "error",
});

const decodeAutomationRun = Schema.decodeUnknownEffect(UiAutomationRunParams, {
  onExcessProperty: "error",
});

const decodeAutomationStatus = Schema.decodeUnknownEffect(UiAutomationStatusParams, {
  onExcessProperty: "error",
});

const decodeAutomationRuns = Schema.decodeUnknownEffect(UiAutomationRunsParams, {
  onExcessProperty: "error",
});

const decodeUiAutomationId = Schema.decodeUnknownEffect(UiAutomationId);

const mapAutomationRun = (run: AutomationRunProjection) => ({
  runId: boundedText(run.runId, 256, "run"),
  automationId: run.automationId,
  trigger: run.trigger,
  state: run.state,
  scheduledForMs: run.scheduledForMs,
  recordedAtMs: run.recordedAtMs,
  startedAtMs: run.startedAtMs,
  finishedAtMs: run.finishedAtMs,
  failureCategory:
    run.failureCategory === null ? null : boundedText(run.failureCategory, 128, "failure"),
  targets: run.targets.slice(0, 8).map((target) => ({
    target: boundedText(target.target, 256, "target"),
    status: target.status,
    failureCategory:
      target.failureCategory === null ? null : boundedText(target.failureCategory, 64, "failure"),
    retriable: target.retriable,
  })),
});

const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));

export const dispatchAutomation = (
  request: UiRequestEnvelope,
  route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
  config: UiGatewayDependencies,
): Effect.Effect<UiGatewayResult, UiGatewayError> => {
  switch (isKnownMethod(request.method) ? request.method : undefined) {
    case "automation.list":
      return Effect.gen(function* () {
        const params = yield* decodeAutomationList(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.automationDefinitions === undefined)
          return yield* Effect.fail(noService(request.method));

        const automations = yield* config.automationDefinitions
          .list(branch.target)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        return {
          profileId: branch.profileId,
          automations: automations.slice(0, 8).map(({ path: _path, ...automation }) => automation),
        };
      });
    case "automation.show":
      return Effect.gen(function* () {
        const params = yield* decodeAutomationShow(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.automationDefinitions === undefined)
          return yield* Effect.fail(noService(request.method));

        const automation = yield* config.automationDefinitions
          .show(branch.target, params.automationId)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        const { path: _path, ...withoutPath } = automation;

        return { profileId: branch.profileId, ...withoutPath };
      });
    case "automation.create":
      return Effect.gen(function* () {
        const params = yield* decodeAutomationCreate(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.automationDefinitions === undefined)
          return yield* Effect.fail(noService(request.method));

        const automation = yield* config.automationDefinitions
          .create(branch.target, params.automationId)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        const { path: _path, ...withoutPath } = automation;

        return { profileId: branch.profileId, ...withoutPath };
      });
    case "automation.save":
      return Effect.gen(function* () {
        const params = yield* decodeAutomationSave(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.automationDefinitions === undefined)
          return yield* Effect.fail(noService(request.method));

        const automation = yield* config.automationDefinitions
          .save(branch.target, params.automationId, params.expectedSource, params.source)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        const { path: _path, ...withoutPath } = automation;

        return { profileId: branch.profileId, ...withoutPath };
      });
    case "automation.validate":
      return Effect.gen(function* () {
        const params = yield* decodeAutomationValidate(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.automationDefinitions === undefined)
          return yield* Effect.fail(noService(request.method));

        const validations = yield* config.automationDefinitions
          .validate(branch.target, params.automationId)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        return {
          profileId: branch.profileId,
          validations: validations.slice(0, 8).map(({ path: _path, ...validation }) => validation),
        };
      });
    case "automation.pause":
      return Effect.gen(function* () {
        const params = yield* decodeAutomationPause(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.automationDefinitions === undefined)
          return yield* Effect.fail(noService(request.method));

        const transition = yield* config.automationDefinitions
          .pause(branch.target, params.automationId)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        return {
          profileId: branch.profileId,
          id: transition.id,
          lifecycle: transition.lifecycle,
        };
      });
    case "automation.resume":
      return Effect.gen(function* () {
        const params = yield* decodeAutomationResume(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.automationDefinitions === undefined)
          return yield* Effect.fail(noService(request.method));

        const transition = yield* config.automationDefinitions
          .resume(branch.target, params.automationId)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        return {
          profileId: branch.profileId,
          id: transition.id,
          lifecycle: transition.lifecycle,
        };
      });
    case "automation.run":
      return Effect.gen(function* () {
        const params = yield* decodeAutomationRun(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.automations === undefined) return yield* Effect.fail(noService(request.method));

        const outcome = yield* config.automations
          .run(
            branch.target,
            params.automationId,
            { kind: "manual-force" },
            {
              live: branch.live,
            },
          )
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        return {
          profileId: branch.profileId,
          automationId: params.automationId,
          accepted: true,
          outcome: outcome.kind,
          runOutcome: outcome,
        };
      });
    case "automation.status":
      return decodeAutomationStatus(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) => route(params.profileId)),
        Effect.flatMap((branch) =>
          config.automationScheduler === undefined
            ? Effect.fail(noService(request.method))
            : config.automationScheduler.status(branch.target).pipe(
                Effect.flatMap((status) =>
                  Effect.forEach(status.schedules.slice(0, 4), (schedule) =>
                    decodeUiAutomationId(schedule.automationId).pipe(
                      Effect.mapError((cause) =>
                        protocolFailure("internal", "invalid automation schedule", cause),
                      ),
                      Effect.map((automationId) => ({
                        automationId,
                        definitionState: schedule.definitionState,
                        nextScheduledAtMs: schedule.nextScheduledAtMs,
                        definitionObservedAtMs: schedule.definitionObservedAtMs,
                        definitionError:
                          schedule.definitionError === null
                            ? null
                            : boundedText(schedule.definitionError),
                      })),
                    ),
                  ).pipe(
                    Effect.map((schedules) => ({
                      profileId: branch.profileId,
                      observedAtMs: status.observedAtMs,
                      heartbeatAtMs: status.heartbeatAtMs,
                      lastTickAtMs: status.lastTickAtMs,
                      lastTickStatus: status.lastTickStatus,
                      lastTickError:
                        status.lastTickError === null ? null : boundedText(status.lastTickError),
                      schedules,
                      activeRunCount: status.activeRunCount,
                      latestRun:
                        status.latestRun === null ? null : mapAutomationRun(status.latestRun),
                      latestErrorRun:
                        status.latestErrorRun === null
                          ? null
                          : mapAutomationRun(status.latestErrorRun),
                    })),
                  ),
                ),
                Effect.mapError((cause) => toGatewayError(request.method, cause)),
              ),
        ),
      );
    case "automation.runs":
      return Effect.gen(function* () {
        const params = yield* decodeAutomationRuns(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.automationScheduler === undefined)
          return yield* Effect.fail(noService(request.method));

        const automationId =
          params.automationId === undefined
            ? undefined
            : yield* validateAutomationId(params.automationId).pipe(
                Effect.mapError((cause) => badParams(request.method, cause)),
              );

        const runs = yield* config.automationScheduler
          .runs(branch.target, automationId)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        return { profileId: branch.profileId, runs: runs.slice(0, 3).map(mapAutomationRun) };
      });
    default:
      return Effect.fail(
        protocolFailure("unknown_method", `unknown automation method ${request.method}`),
      );
  }
};
