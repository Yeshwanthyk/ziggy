import { Predicate, Schema } from "effect";
import {
  UiGatewayError,
  type UiExtensionFailure as UiExtensionFailureValue,
} from "../../domain/ui-gateway";

export const boundedText = (
  value: string,
  maximum = 360,
  fallback = "UI gateway request failed",
): string => {
  const normalized = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const text = [...normalized].slice(0, maximum).join("");
  return text.length === 0 ? fallback : text;
};

const isUiGatewayError = Schema.is(UiGatewayError);

export const safeFailureMessage = (cause: unknown, fallback: string): string => {
  if (isUiGatewayError(cause)) return boundedText(cause.message, 360, fallback);
  if (
    Predicate.isTagged(cause, "SessionNotFound") ||
    Predicate.isTagged(cause, "UnknownProfile") ||
    Predicate.isTagged(cause, "ProfileUnavailable")
  )
    return "the requested resource was not found or is unavailable";
  if (Predicate.isTagged(cause, "AutomationNotFound"))
    return "the requested automation was not found";
  if (
    Predicate.isTagged(cause, "AutomationEditConflict") ||
    Predicate.isTagged(cause, "UiStateConflict")
  )
    return "the resource changed; reload before retrying";
  if (Predicate.isTagged(cause, "ChatNotStreaming")) return "the session is not streaming";
  if (Predicate.isTagged(cause, "ProfileNotInitialized")) return "the Profile is not initialized";
  return fallback;
};

export const protocolFailure = (
  code: UiGatewayError["code"],
  message: string,
  cause?: unknown,
  details?: UiExtensionFailureValue,
): UiGatewayError => {
  const bounded = boundedText(message);
  if (cause !== undefined && details !== undefined)
    return new UiGatewayError({ code, message: bounded, cause, details });
  if (cause !== undefined) return new UiGatewayError({ code, message: bounded, cause });
  if (details !== undefined) return new UiGatewayError({ code, message: bounded, details });
  return new UiGatewayError({ code, message: bounded });
};

export const badParams = (method: string, cause: unknown): UiGatewayError =>
  protocolFailure("bad_params", `invalid params for ${method}`, cause);
export const noService = (method: string): UiGatewayError =>
  protocolFailure("internal", `${method} is unavailable for this resident`, undefined);

export const errorCode = (cause: unknown): UiGatewayError["code"] => {
  if (isUiGatewayError(cause)) return cause.code;
  if (Predicate.isTagged(cause, "UnknownProfile")) return "unknown_profile";
  if (
    Predicate.isTagged(cause, "ProfileUnavailable") ||
    Predicate.isTagged(cause, "DefaultProfileUnavailable")
  )
    return "profile_unavailable";
  if (Predicate.isTagged(cause, "ProfileIdCollision")) return "profile_id_collision";
  if (Predicate.isTagged(cause, "UiStateConflict")) return "conflict";
  if (Predicate.isTagged(cause, "UiStateCommandConflict")) return "conflict";
  if (Predicate.isTagged(cause, "UiGroupNotFound")) return "unknown_session";
  if (Predicate.isTagged(cause, "SessionNotFound")) return "unknown_session";
  if (Predicate.isTagged(cause, "SessionHistoryCursorInvalid")) return "stale_cursor";
  if (Predicate.isTagged(cause, "ChatNotStreaming")) return "not_streaming";
  if (Predicate.isTagged(cause, "AutomationNotFound")) return "automation_not_found";
  if (Predicate.isTagged(cause, "AutomationEditConflict")) return "conflict";
  if (Predicate.isTagged(cause, "ProfileExtensionInvalid")) return "bad_params";
  return "internal";
};

export const toGatewayError = (method: string, cause: unknown): UiGatewayError => {
  if (isUiGatewayError(cause)) return cause;
  return protocolFailure(errorCode(cause), safeFailureMessage(cause, `${method} failed`), cause);
};
