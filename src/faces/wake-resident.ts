import { Effect } from "effect";
import { createZiggyConnection } from "../../packages/ui-sdk/src/connection";
import { isProfileId } from "../../packages/ui-sdk/src/protocol/common";
import type { UiServerProjection } from "../adapters/bun/ui-server";
import { UiGatewayError } from "../domain/ui-gateway";
import { stableProfileId } from "../application/profile-directory";
import type { ProfileTarget } from "../domain/profile";

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
            message:
              "resident automation request failed; inspect ziggy serve status and logs (do not retry blindly if the request was sent)",
            cause,
          }),
      }),
    (connection) => Effect.sync(() => connection.close()),
  );
};
