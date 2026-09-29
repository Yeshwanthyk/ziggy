import { Effect, Schema } from "effect";
import {
  UiGatewayError,
  UiResponseFrame,
  type UiGatewayResult,
  type UiRequestId,
} from "../../domain/ui-gateway";
import { boundedText } from "./errors";

const encodeResponse = Schema.encodeSync(Schema.fromJsonString(UiResponseFrame));

export const resultFrame = (id: UiRequestId, result: UiGatewayResult): UiResponseFrame => ({
  id,
  ok: true,
  result,
});

export const failureFrame = (id: UiRequestId, error: UiGatewayError): UiResponseFrame => ({
  id,
  ok: false,
  error:
    error.details === undefined
      ? { code: error.code, message: boundedText(error.message) }
      : { code: error.code, message: boundedText(error.message), details: error.details },
});

const encodeResponseForTransport = (frame: UiResponseFrame): Effect.Effect<string> =>
  Effect.try({
    try: () => encodeResponse(frame),
    catch: (cause) =>
      new UiGatewayError({
        code: "internal",
        message: "response could not be encoded",
        cause,
      }),
  }).pipe(Effect.catch((error) => Effect.succeed(JSON.stringify(failureFrame(frame.id, error)))));

export const sendResponse = (
  send: (frame: string) => void,
  frame: UiResponseFrame,
): Effect.Effect<void> =>
  encodeResponseForTransport(frame).pipe(
    Effect.tap((encoded) => Effect.sync(() => send(encoded))),
    Effect.asVoid,
  );
