import { Effect, Schema } from "effect";

import {
  UiExtensionAddParams,
  UiExtensionListForProfileParams,
  UiExtensionListForProfileResult,
  UiExtensionRemoveParams,
  UiExtensionValidationResult,
  UiExtensionValidateParams,
  UiGatewayError,
  UI_METHODS,
  type UiExtensionFailure as UiExtensionFailureValue,
  type UiExtensionFailureStage,
  type UiExtensionOperation,
  type UiGatewayResult,
  type UiRequestEnvelope,
} from "../../domain/ui-gateway";

import type { ProfileExtensionError } from "../../domain/profile-extension";
import type { ProfileId } from "../../domain/profile-directory";
import type { UiGatewayBranch, UiGatewayDependencies } from "./types";
import { badParams, boundedText, protocolFailure, safeFailureMessage } from "./errors";

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

const decodeExtensionListResult = Schema.decodeUnknownEffect(UiExtensionListForProfileResult);

const decodeExtensionValidationResult = Schema.decodeUnknownEffect(UiExtensionValidationResult);

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

const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));

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
