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

import type { ExtensionError, ExtensionHealth } from "../../extensions";
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
  cause: ExtensionError,
  requestedId?: string,
): UiExtensionFailureValue => {
  const { stage, code }: { stage: UiExtensionFailureStage; code: string } =
    cause._tag === "ExtensionLoadFailed"
      ? { stage: cause.stage, code: "preflight_failed" }
      : cause._tag === "ExtensionLockFailed"
        ? { stage: "lock", code: "lock_failed" }
        : { stage: "filesystem", code: cause._tag.toLowerCase() };

  const result = {
    operation,
    stage,
    code: boundedText(code, 64, "extension_operation_failed"),
    message: safeFailureMessage(cause, "Profile extension operation failed"),
    selectionChanged: false,
  };

  if (requestedId === undefined) return result;

  return { ...result, id: boundedText(requestedId, 128, "extension") };
};

const projectExtensionList = (profileId: ProfileId, result: ExtensionHealth) => {
  const selected = result.listing.selected.slice(0, 64);

  const skipped: Array<{ id: string; diagnostics: Array<{ source: string; message: string }> }> =
    [];

  let healthTruncated = false;

  for (const item of result.skipped.slice(0, 16)) {
    const id = boundedText(item.id, 64, "package");
    const diagnostics: Array<{ source: string; message: string }> = [];

    for (const diagnostic of item.diagnostics.slice(0, 8)) {
      const candidate = {
        source: boundedText(diagnostic.source, 120, "package"),
        message: boundedText(diagnostic.message, 180, "Package could not load"),
      };

      if (
        new TextEncoder().encode(
          JSON.stringify({
            profileId,
            selected,
            skipped: [...skipped, { id, diagnostics: [...diagnostics, candidate] }],
          }),
        ).byteLength > 20_000
      ) {
        healthTruncated = true;
        break;
      }

      diagnostics.push(candidate);
    }

    if (diagnostics.length < item.diagnostics.length) healthTruncated = true;
    skipped.push({ id, diagnostics });
  }

  const available: Array<(typeof result.listing.available)[number]> = [];

  for (const choice of result.listing.available.slice(0, 64)) {
    const description = [...boundedText(choice.description, 512, "Extension")];

    while (description.join("").length > 512) description.pop();

    const candidate = { ...choice, description: description.join("") };

    // Leave room for the response envelope and multi-byte descriptions.
    if (
      new TextEncoder().encode(
        JSON.stringify({
          profileId,
          selected,
          available: [...available, candidate],
          skipped,
          truncated: true,
        }),
      ).byteLength > 54_000
    )
      break;

    available.push(candidate);
  }

  return {
    profileId,
    available,
    selected,
    skipped,
    truncated:
      available.length < result.listing.available.length ||
      selected.length < result.listing.selected.length ||
      skipped.length < result.skipped.length ||
      healthTruncated,
  };
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
          config.profileExtensions.health(branch.target.path).pipe(
            Effect.catchTag("ExtensionLoadFailed", (cause) =>
              config.profileExtensions.listForProfile(branch.target.path).pipe(
                Effect.map((listing) => ({
                  listing,
                  skipped: [
                    {
                      id: "health-inspection",
                      diagnostics: [
                        {
                          source: "Profile extensions",
                          message: safeFailureMessage(cause, "Could not inspect extension health"),
                        },
                      ],
                    },
                  ],
                })),
              ),
            ),
            Effect.mapError((cause) =>
              protocolFailure(
                "internal",
                `could not ${operation} Profile extensions`,
                cause,
                extensionFailure(operation, cause),
              ),
            ),
            Effect.flatMap((result) =>
              decodeExtensionListResult(projectExtensionList(branch.profileId, result)).pipe(
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
              config.profileExtensions.add(branch.target, params.id).pipe(
                Effect.map((result) => ({
                  profileId: branch.profileId,
                  id: result.id,
                  changed: result.changed,
                  selected: result.selected,
                  restartRequired: result.changed,
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
              config.profileExtensions.remove(branch.target, params.id).pipe(
                Effect.map((result) => ({
                  profileId: branch.profileId,
                  id: result.id,
                  changed: result.changed,
                  selected: result.selected,
                  restartRequired: result.changed,
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
          config.profileExtensions.validate(branch.target).pipe(
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
