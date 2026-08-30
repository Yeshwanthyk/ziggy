import { Effect, Schema } from "effect";
import type { ProviderAuthStatus } from "../../adapters/pi/auth";
import type { KnownModel } from "../../adapters/pi/models";
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
  UiAuthStatusParams,
  UiExtensionAddParams,
  UiExtensionListForProfileParams,
  UiExtensionListForProfileResult,
  UiExtensionRemoveParams,
  UiExtensionValidationResult,
  UiExtensionValidateParams,
  UiGatewayError,
  UiMemoryListParams,
  UiMemoryPath,
  UiMemoryShowParams,
  UiModelAvailableParams,
  UiModelListParams,
  UiModelSetParams,
  UiModelStatusParams,
  UiPinListParams,
  UiPinRemoveParams,
  UiPinSetParams,
  UI_METHODS,
  type UiExtensionFailure as UiExtensionFailureValue,
  type UiExtensionFailureStage,
  type UiExtensionOperation,
  type UiGatewayResult,
  type UiRequestEnvelope,
} from "../../domain/ui-gateway";
import type { AutomationRunProjection } from "../../domain/automation";
import { validateAutomationId } from "../../domain/automation";
import { memoryDocumentFromRelativePath } from "../../domain/memory";
import type { ProfileExtensionError } from "../../domain/profile-extension";
import type { ProfileId } from "../../domain/profile-directory";
import type { UiGatewayBranch, UiGatewayDependencies } from "./types";
import {
  badParams,
  boundedText,
  noService,
  protocolFailure,
  safeFailureMessage,
  toGatewayError,
} from "./errors";

const decodeModelStatus = Schema.decodeUnknownEffect(UiModelStatusParams, {
  onExcessProperty: "error",
});
const decodeModelList = Schema.decodeUnknownEffect(UiModelListParams, {
  onExcessProperty: "error",
});
const decodeModelAvailable = Schema.decodeUnknownEffect(UiModelAvailableParams, {
  onExcessProperty: "error",
});
const decodeModelSet = Schema.decodeUnknownEffect(UiModelSetParams, { onExcessProperty: "error" });
const decodeAuthStatus = Schema.decodeUnknownEffect(UiAuthStatusParams, {
  onExcessProperty: "error",
});
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
const decodeMemoryList = Schema.decodeUnknownEffect(UiMemoryListParams, {
  onExcessProperty: "error",
});
const decodeMemoryShow = Schema.decodeUnknownEffect(UiMemoryShowParams, {
  onExcessProperty: "error",
});
const decodeUiMemoryPath = Schema.decodeUnknownEffect(UiMemoryPath);
const decodeExtensionList = Schema.decodeUnknownEffect(UiExtensionListForProfileParams, {
  onExcessProperty: "error",
});
const decodeExtensionAdd = Schema.decodeUnknownEffect(UiExtensionAddParams, {
  onExcessProperty: "error",
});
const decodeExtensionRemove = Schema.decodeUnknownEffect(UiExtensionRemoveParams, {
  onExcessProperty: "error",
});
const decodeExtensionValidate = Schema.decodeUnknownEffect(UiExtensionValidateParams, {
  onExcessProperty: "error",
});
const decodePinList = Schema.decodeUnknownEffect(UiPinListParams, { onExcessProperty: "error" });
const decodePinSet = Schema.decodeUnknownEffect(UiPinSetParams, { onExcessProperty: "error" });
const decodePinRemove = Schema.decodeUnknownEffect(UiPinRemoveParams, {
  onExcessProperty: "error",
});
const decodeExtensionListResult = Schema.decodeUnknownEffect(UiExtensionListForProfileResult);
const decodeExtensionValidationResult = Schema.decodeUnknownEffect(UiExtensionValidationResult);
const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));

const mapModel = (model: KnownModel) => ({
  providerId: model.providerId,
  modelId: model.modelId,
  name: model.name,
  thinkingLevels: [...model.thinkingLevels],
});

const MODEL_RESULT_BUDGET_BYTES = 48 * 1_024;

const fairModelOrder = (models: ReadonlyArray<KnownModel>): ReadonlyArray<KnownModel> => {
  const byProvider = new Map<string, KnownModel[]>();
  for (const model of models) {
    const group = byProvider.get(model.providerId);
    if (group === undefined) byProvider.set(model.providerId, [model]);
    else group.push(model);
  }
  const providers = [...byProvider.keys()].sort((left, right) => left.localeCompare(right));
  const ordered: KnownModel[] = [];
  for (let index = 0; ; index += 1) {
    let added = false;
    for (const provider of providers) {
      const model = byProvider.get(provider)?.[index];
      if (model === undefined) continue;
      ordered.push(model);
      added = true;
    }
    if (!added) return ordered;
  }
};

const projectModels = (profileId: ProfileId, models: ReadonlyArray<KnownModel>) => {
  const projected: ReturnType<typeof mapModel>[] = [];
  for (const model of fairModelOrder(models)) {
    if (projected.length >= 256) break;
    const mapped = mapModel(model);
    const candidate = [...projected, mapped];
    const bytes = new TextEncoder().encode(
      JSON.stringify({ profileId, models: candidate, truncated: true }),
    ).byteLength;
    if (bytes > MODEL_RESULT_BUDGET_BYTES) break;
    projected.push(mapped);
  }
  return { profileId, models: projected, truncated: projected.length < models.length };
};

const mapAuth = (provider: ProviderAuthStatus) => {
  const result = {
    id: boundedText(provider.id, 128, "provider"),
    name: boundedText(provider.name, 256, "Provider"),
    configured: provider.configured !== undefined,
    supportsApiKeyLogin: provider.supportsApiKeyLogin,
    supportsOauth: provider.supportsOauth,
  };
  if (provider.configured === undefined) return result;
  return { ...result, type: provider.configured.type };
};

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

const extensionFailure = (
  operation: UiExtensionOperation,
  cause: ProfileExtensionError,
  requestedId?: string,
): UiExtensionFailureValue => {
  const tag = cause._tag;
  const stage: UiExtensionFailureStage =
    tag === "ExtensionCatalogInstallFailed"
      ? cause.reason
      : tag === "ProfileExtensionPreflightFailed"
        ? cause.stage
        : tag === "ProfileExtensionLockFailed"
          ? "lock"
          : tag === "ProfileExtensionRollbackFailed"
            ? "rollback"
            : tag === "ExtensionCatalogInvalid" || tag === "ExtensionCatalogUnavailable"
              ? "catalog"
              : tag === "ProfileFileSystemError" || tag === "ProfileExtensionInvalid"
                ? "filesystem"
                : "response";
  const code =
    tag === "ExtensionCatalogInstallFailed"
      ? "catalog_install_failed"
      : tag === "ProfileExtensionPreflightFailed"
        ? "preflight_failed"
        : tag === "ProfileExtensionLockFailed"
          ? "lock_failed"
          : tag === "ProfileExtensionRollbackFailed"
            ? "rollback_failed"
            : tag.toLowerCase();
  const result = {
    operation,
    stage,
    code: boundedText(code, 64, "extension_operation_failed"),
    message: safeFailureMessage(cause, "Profile extension operation failed"),
    selectionChanged: tag === "ProfileExtensionRollbackFailed",
  };
  if (requestedId === undefined) return result;
  return { ...result, id: boundedText(requestedId, 128, "extension") };
};

export const dispatchSettings = (
  request: UiRequestEnvelope,
  route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
  config: UiGatewayDependencies,
): Effect.Effect<UiGatewayResult, UiGatewayError> => {
  switch (isKnownMethod(request.method) ? request.method : undefined) {
    case "model.status":
      return decodeModelStatus(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) => route(params.profileId)),
        Effect.flatMap((branch) =>
          config.models === undefined
            ? Effect.fail(noService(request.method))
            : config.models.readOnlyStatus(branch.target).pipe(
                Effect.map((status) => ({
                  profileId: branch.profileId,
                  providerId: status.providerId ?? null,
                  modelId: status.modelId ?? null,
                  thinking: status.thinking,
                  authConfigured: status.authConfigured,
                })),
                Effect.mapError((cause) => toGatewayError(request.method, cause)),
              ),
        ),
      );
    case "model.list":
      return Effect.gen(function* () {
        const params = yield* decodeModelList(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );
        const branch = yield* route(params.profileId);
        if (config.models === undefined) return yield* Effect.fail(noService(request.method));
        const models = yield* config.models
          .list(branch.target, params.providerId)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));
        return projectModels(branch.profileId, models);
      });
    case "model.available":
      return decodeModelAvailable(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) => route(params.profileId)),
        Effect.flatMap((branch) =>
          config.models === undefined
            ? Effect.fail(noService(request.method))
            : config.models.available(branch.target).pipe(
                Effect.map((models) => projectModels(branch.profileId, models)),
                Effect.mapError((cause) => toGatewayError(request.method, cause)),
              ),
        ),
      );
    case "model.set":
      return Effect.gen(function* () {
        const params = yield* decodeModelSet(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );
        const branch = yield* route(params.profileId);
        if (config.models === undefined) return yield* Effect.fail(noService(request.method));
        const selection = yield* config.models
          .set(branch.target, params.providerId, params.modelId, params.thinking)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));
        return {
          profileId: branch.profileId,
          providerId: selection.providerId,
          modelId: selection.modelId,
          thinking: selection.thinking ?? null,
        };
      });
    case "auth.status":
      return decodeAuthStatus(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) => route(params.profileId)),
        Effect.flatMap((branch) =>
          config.auth === undefined
            ? Effect.fail(noService(request.method))
            : config.auth.readOnlyStatus(branch.target).pipe(
                Effect.map((providers) => ({
                  profileId: branch.profileId,
                  providers: providers.slice(0, 16).map(mapAuth),
                })),
                Effect.mapError((cause) => toGatewayError(request.method, cause)),
              ),
        ),
      );
    default:
      return Effect.fail(
        protocolFailure("unknown_method", `unknown settings method ${request.method}`),
      );
  }
};

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
          .run(branch.target, params.automationId, { kind: "manual-force" })
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));
        return {
          profileId: branch.profileId,
          automationId: params.automationId,
          accepted: true,
          outcome: outcome.kind,
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

export const dispatchMemory = (
  request: UiRequestEnvelope,
  route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
  config: UiGatewayDependencies,
): Effect.Effect<UiGatewayResult, UiGatewayError> => {
  switch (isKnownMethod(request.method) ? request.method : undefined) {
    case "memory.list":
      return decodeMemoryList(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) => route(params.profileId)),
        Effect.flatMap((branch) =>
          config.memory === undefined
            ? Effect.fail(noService(request.method))
            : config.memory.list(branch.target).pipe(
                Effect.map((documents) => ({
                  profileId: branch.profileId,
                  documents: documents
                    .slice(0, 16)
                    .map(({ document, state, entries, codePoints, cap }) => ({
                      path: document.relativePath,
                      scope: document.scope,
                      state,
                      entryCount: entries.length,
                      codePoints,
                      cap,
                    })),
                })),
                Effect.mapError((cause) => toGatewayError(request.method, cause)),
              ),
        ),
      );
    case "memory.show":
      return decodeMemoryShow(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) =>
          route(params.profileId).pipe(
            Effect.flatMap((branch) => {
              const document = memoryDocumentFromRelativePath(branch.target.path, params.path);
              return document === undefined
                ? Effect.fail(badParams(request.method, "unknown logical memory path"))
                : config.memory === undefined
                  ? Effect.fail(noService(request.method))
                  : config.memory
                      .show(
                        branch.target,
                        document.scope === "shared"
                          ? { scope: "shared" }
                          : {
                              scope: document.scope,
                              id:
                                document.relativePath.split("/").at(-1)?.replace(/\.md$/u, "") ??
                                "",
                            },
                      )
                      .pipe(
                        Effect.flatMap(
                          ({ document: loaded, state, entries, codePoints, cap, content }) =>
                            decodeUiMemoryPath(loaded.relativePath).pipe(
                              Effect.mapError((cause) =>
                                protocolFailure("internal", "invalid memory document path", cause),
                              ),
                              Effect.map((path) => ({
                                profileId: branch.profileId,
                                path,
                                scope: loaded.scope,
                                state,
                                content,
                                entries,
                                codePoints,
                                cap,
                              })),
                            ),
                        ),
                        Effect.mapError((cause) => toGatewayError(request.method, cause)),
                      );
            }),
          ),
        ),
      );
    default:
      return Effect.fail(
        protocolFailure("unknown_method", `unknown memory method ${request.method}`),
      );
  }
};

export const dispatchExtensions = (
  request: UiRequestEnvelope,
  route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
  config: UiGatewayDependencies,
): Effect.Effect<UiGatewayResult, UiGatewayError> => {
  const operation =
    request.method === "extension.add"
      ? "add"
      : request.method === "extension.remove"
        ? "remove"
        : request.method === "extension.validate"
          ? "validate"
          : "list";
  switch (isKnownMethod(request.method) ? request.method : undefined) {
    case "extension.list-for-profile":
      return decodeExtensionList(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) => route(params.profileId)),
        Effect.flatMap((branch) =>
          config.profileExtensions.listForProfile(branch.target.path, config.repositoryRoot).pipe(
            Effect.mapError((cause) =>
              protocolFailure(
                "internal",
                `could not ${operation} Profile extensions`,
                cause,
                extensionFailure(operation, cause),
              ),
            ),
            Effect.flatMap((result) =>
              decodeExtensionListResult({
                profileId: branch.profileId,
                available: result.available.slice(0, 12).map((choice) => ({
                  ...choice,
                  description: boundedText(choice.description, 512, "Extension"),
                })),
                selected: result.selected.slice(0, 32),
              }).pipe(
                Effect.mapError((cause) =>
                  protocolFailure("internal", "invalid Profile extension response", cause),
                ),
              ),
            ),
          ),
        ),
      );
    case "extension.add":
      return decodeExtensionAdd(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) =>
          route(params.profileId).pipe(
            Effect.flatMap((branch) =>
              config.profileExtensions.add(branch.target, config.repositoryRoot, params.id).pipe(
                Effect.map((result) => ({
                  profileId: branch.profileId,
                  id: result.id,
                  changed: result.changed,
                  selected: result.selected,
                })),
                Effect.mapError((cause) =>
                  protocolFailure(
                    "internal",
                    "could not add Profile extensions",
                    cause,
                    extensionFailure(operation, cause, params.id),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    case "extension.remove":
      return decodeExtensionRemove(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) =>
          route(params.profileId).pipe(
            Effect.flatMap((branch) =>
              config.profileExtensions.remove(branch.target, config.repositoryRoot, params.id).pipe(
                Effect.map((result) => ({
                  profileId: branch.profileId,
                  id: result.id,
                  changed: result.changed,
                  selected: result.selected,
                })),
                Effect.mapError((cause) =>
                  protocolFailure(
                    "internal",
                    "could not remove Profile extensions",
                    cause,
                    extensionFailure(operation, cause, params.id),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    case "extension.validate":
      return decodeExtensionValidate(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) => route(params.profileId)),
        Effect.flatMap((branch) =>
          config.profileExtensions.validate(branch.target, config.repositoryRoot).pipe(
            Effect.mapError((cause) =>
              protocolFailure(
                "internal",
                "could not validate Profile extensions",
                cause,
                extensionFailure(operation, cause),
              ),
            ),
            Effect.flatMap((result) =>
              decodeExtensionValidationResult({
                profileId: branch.profileId,
                ...result,
                selected: result.selected.slice(0, 32),
              }).pipe(
                Effect.mapError((cause) =>
                  protocolFailure("internal", "invalid Profile extension response", cause),
                ),
              ),
            ),
          ),
        ),
      );
    default:
      return Effect.fail(
        protocolFailure("unknown_method", `unknown extension method ${request.method}`),
      );
  }
};

export const dispatchPins = (
  request: UiRequestEnvelope,
  route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
  pins: import("../../adapters/fs/ui-state").UiPinStore,
): Effect.Effect<UiGatewayResult, UiGatewayError> => {
  switch (isKnownMethod(request.method) ? request.method : undefined) {
    case "pin.list":
      return decodePinList(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) => route(params.profileId)),
        Effect.flatMap((branch) =>
          pins.read(branch.target.path).pipe(
            Effect.map((state) => ({
              profileId: branch.profileId,
              revision: state.revision,
              pins: state.pins.slice(0, 16),
            })),
            Effect.mapError((cause) => toGatewayError(request.method, cause)),
          ),
        ),
      );
    case "pin.set":
      return decodePinSet(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) =>
          route(params.profileId).pipe(
            Effect.flatMap((branch) =>
              params.pin.ref.profileId !== branch.profileId
                ? Effect.fail(
                    protocolFailure("bad_params", "pin session belongs to another Profile"),
                  )
                : pins
                    .set(branch.target.path, params.pin, params.expectedRevision, params.commandId)
                    .pipe(
                      Effect.map((state) => ({
                        profileId: branch.profileId,
                        revision: state.revision,
                        pins: state.pins.slice(0, 16),
                      })),
                      Effect.mapError((cause) => toGatewayError(request.method, cause)),
                    ),
            ),
          ),
        ),
      );
    case "pin.remove":
      return decodePinRemove(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) =>
          route(params.profileId).pipe(
            Effect.flatMap((branch) =>
              pins
                .remove(branch.target.path, params.pinId, params.expectedRevision, params.commandId)
                .pipe(
                  Effect.map((state) => ({
                    profileId: branch.profileId,
                    revision: state.revision,
                    pins: state.pins.slice(0, 16),
                  })),
                  Effect.mapError((cause) => toGatewayError(request.method, cause)),
                ),
            ),
          ),
        ),
      );
    default:
      return Effect.fail(protocolFailure("unknown_method", `unknown pin method ${request.method}`));
  }
};
