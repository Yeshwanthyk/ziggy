import { Effect, Schema } from "effect";
import {
  UiGatewayError,
  UiPluginSecretSetParams,
  UiPluginSecretSetResult,
  type UiGatewayResult,
  type UiRequestEnvelope,
} from "../../domain/ui-gateway";
import type { ProfileId } from "../../domain/profile-directory";
import type { UiGatewayBranch, UiGatewayDependencies } from "./types";
import { noService, protocolFailure } from "./errors";

const decodeParams = Schema.decodeUnknownEffect(UiPluginSecretSetParams, {
  onExcessProperty: "error",
});

const decodeResult = Schema.decodeUnknownEffect(UiPluginSecretSetResult);

/**
 * `plugin.secret.set`: store one plugin `${NAME}` in the Keychain. Decode failures carry no
 * cause, so a rejected value never reaches an error frame or log.
 */
export const dispatchPluginSecret = (
  request: UiRequestEnvelope,
  route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
  config: UiGatewayDependencies,
): Effect.Effect<UiGatewayResult, UiGatewayError> => {
  const secrets = config.pluginSecrets;

  if (secrets === undefined) return Effect.fail(noService(request.method));

  return decodeParams(request.params).pipe(
    Effect.mapError(() =>
      protocolFailure(
        "bad_params",
        "invalid params for plugin.secret.set: name must match [A-Za-z_][A-Za-z0-9_]* and value must be 1-1024 printable ASCII characters",
      ),
    ),
    Effect.flatMap((params) =>
      route(params.profileId).pipe(
        Effect.flatMap((branch) =>
          secrets.set(params.name, params.value).pipe(
            Effect.mapError((cause) =>
              protocolFailure("internal", `could not store ${params.name}: ${cause.message}`),
            ),
            Effect.flatMap(() =>
              decodeResult({ profileId: branch.profileId, name: params.name, stored: true }).pipe(
                Effect.mapError(() =>
                  protocolFailure("internal", "invalid plugin secret response"),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
};
