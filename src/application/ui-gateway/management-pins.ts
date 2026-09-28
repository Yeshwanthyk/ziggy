import { Effect, Schema } from "effect";

import {
  UiGatewayError,
  UiPinListParams,
  UiPinRemoveParams,
  UiPinSetParams,
  UI_METHODS,
  type UiGatewayResult,
  type UiRequestEnvelope,
} from "../../domain/ui-gateway";

import type { ProfileId } from "../../domain/profile-directory";
import type { UiGatewayBranch } from "./types";
import { badParams, protocolFailure, toGatewayError } from "./errors";

const decodePinList = Schema.decodeUnknownEffect(UiPinListParams, { onExcessProperty: "error" });

const decodePinSet = Schema.decodeUnknownEffect(UiPinSetParams, { onExcessProperty: "error" });

const decodePinRemove = Schema.decodeUnknownEffect(UiPinRemoveParams, {
  onExcessProperty: "error",
});

const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));

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
