import { Effect, Schema } from "effect";
import type { ProviderAuthStatus } from "../../adapters/pi/auth";
import type { KnownModel } from "../../adapters/pi/models";
import {
  UiAuthStatusParams,
  UiGatewayError,
  UiModelAvailableParams,
  UiModelListParams,
  UiModelSetParams,
  UiModelStatusParams,
  UI_METHODS,
  type UiGatewayResult,
  type UiRequestEnvelope,
} from "../../domain/ui-gateway";

import type { ProfileId } from "../../domain/profile-directory";
import type { UiGatewayBranch, UiGatewayDependencies } from "./types";
import { badParams, boundedText, noService, protocolFailure, toGatewayError } from "./errors";

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

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const authProviderOrder = (
  providers: ReadonlyArray<ProviderAuthStatus>,
): ReadonlyArray<ProviderAuthStatus> =>
  [...providers].sort((left, right) => {
    const configured =
      Number(right.configured !== undefined) - Number(left.configured !== undefined);

    if (configured !== 0) return configured;
    const byName = compareText(left.name, right.name);

    return byName !== 0 ? byName : compareText(left.id, right.id);
  });

const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));

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
                  providers: authProviderOrder(providers).slice(0, 16).map(mapAuth),
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
