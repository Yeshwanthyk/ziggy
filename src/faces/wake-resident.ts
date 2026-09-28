/* oxlint-disable ziggy-effect/no-instanceof-tagged-error, ziggy-effect/no-instanceof-error -- SDK rejects with a class for sent requests and a plain Error for the unsent timeout; classify only at this client boundary */
import { Effect } from "effect";
import {
  createZiggyConnection,
  ZiggyRequestOutcomeUnknownError,
} from "../../packages/ui-sdk/src/connection";
import { isProfileId } from "../../packages/ui-sdk/src/protocol/common";
import type { UiServerProjection } from "../adapters/bun/ui-server";
import { UiGatewayError } from "../domain/ui-gateway";
import { stableProfileId } from "../application/profile-directory";
import type { ProfileTarget } from "../domain/profile";

// Automation sessions and specialist tasks have no overall run deadline. This generous
// request wait is not a run limit; after a sent request times out, its result is unknown.
const WAKE_REQUEST_TIMEOUT_MS = 30 * 60_000;

const wakeFailureMessage = (cause: unknown): string => {
  if (cause instanceof ZiggyRequestOutcomeUnknownError)
    return "resident wake outcome unknown; check `ziggy automations runs` before retrying";

  if (
    cause instanceof Error &&
    cause.message === "Ziggy gateway request timed out before send: automation.run"
  )
    return "resident wake timed out before send; safe to retry";

  return "resident automation request failed; inspect ziggy serve status and logs";
};

/** The owner was inspected before calling this face. A failed request must never run locally. */
export const wakeInResident = (
  target: ProfileTarget,
  automationId: string,
  projection: UiServerProjection,
) => {
  const profileId = stableProfileId(target.path);

  if (!isProfileId(profileId)) {
    return Effect.fail(
      new UiGatewayError({ code: "internal", message: "invalid Profile identity" }),
    );
  }

  return Effect.acquireUseRelease(
    Effect.sync(() =>
      createZiggyConnection({
        url: `ws://127.0.0.1:${projection.port}/ws`,
        token: projection.token,
        requestTimeoutMs: WAKE_REQUEST_TIMEOUT_MS,
      }),
    ),
    (connection) =>
      Effect.tryPromise({
        try: () =>
          connection.request("automation.run", {
            profileId,
            automationId,
          }),
        catch: (cause) =>
          new UiGatewayError({
            code: "internal",
            message: wakeFailureMessage(cause),
            cause,
          }),
      }),
    (connection) => Effect.sync(() => connection.close()),
  );
};
