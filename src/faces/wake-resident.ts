/* oxlint-disable ziggy-effect/no-instanceof-tagged-error -- SDK client errors are class-identified at this face boundary */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- bridge the SDK's connection-state event into an interruptible Effect with explicit timer/listener cleanup */
import { Effect } from "effect";
import {
  createZiggyConnection,
  ZiggyInvalidResponseError,
  ZiggyRequestNotSentError,
  ZiggyRequestOutcomeUnknownError,
  type ZiggyConnection,
} from "../../packages/ui-sdk/src/connection";
import { isProfileId } from "../../packages/ui-sdk/src/protocol/common";
import type { UiServerProjection } from "../adapters/bun/ui-server";
import { UiGatewayError } from "../domain/ui-gateway";
import { stableProfileId } from "../application/profile-directory";
import type { ProfileTarget } from "../domain/profile";

// Automation sessions and specialist tasks have no overall run deadline. This generous
// response wait is not a run limit; after a sent request times out, its result is unknown.
const WAKE_REQUEST_TIMEOUT_MS = 30 * 60_000;

const WAKE_CONNECT_TIMEOUT_MS = 10_000;

const wakeFailureMessage = (cause: unknown): string => {
  if (
    cause instanceof ZiggyRequestOutcomeUnknownError ||
    cause instanceof ZiggyInvalidResponseError
  )
    return "resident wake outcome unknown; check `ziggy automations runs` before retrying";

  if (cause instanceof ZiggyRequestNotSentError)
    return "resident wake timed out before send; safe to retry";

  return "resident automation request failed; inspect ziggy serve status and logs";
};

const waitForConnection = (connection: ZiggyConnection, deadlineMs: number) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;

        const onAbort = () => finish(new ZiggyRequestNotSentError("automation.run"));

        const finish = (failure?: ZiggyRequestNotSentError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          signal.removeEventListener("abort", onAbort);

          if (failure === undefined) resolve();
          else reject(failure);
        };

        const unsubscribe = connection.on("connection-state", (event) => {
          if (event.state === "open") finish();
        });

        timer = setTimeout(
          () => finish(new ZiggyRequestNotSentError("automation.run")),
          deadlineMs,
        );
        signal.addEventListener("abort", onAbort, { once: true });

        if (connection.state === "open") finish();
      }),
    catch: (cause) =>
      new UiGatewayError({ code: "internal", message: wakeFailureMessage(cause), cause }),
  });

/** The owner was inspected before calling this face. A failed request must never run locally. */
export const wakeInResident = (
  target: ProfileTarget,
  automationId: string,
  projection: UiServerProjection,
  options: {
    readonly connect?: typeof createZiggyConnection;
    readonly connectTimeoutMs?: number;
  } = {},
) => {
  const profileId = stableProfileId(target.path);

  if (!isProfileId(profileId)) {
    return Effect.fail(
      new UiGatewayError({ code: "internal", message: "invalid Profile identity" }),
    );
  }

  return Effect.acquireUseRelease(
    Effect.sync(() =>
      (options.connect ?? createZiggyConnection)({
        url: `ws://127.0.0.1:${projection.port}/ws`,
        token: projection.token,
        requestTimeoutMs: WAKE_REQUEST_TIMEOUT_MS,
      }),
    ),
    (connection) =>
      waitForConnection(connection, options.connectTimeoutMs ?? WAKE_CONNECT_TIMEOUT_MS).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => connection.request("automation.run", { profileId, automationId }),
            catch: (cause) =>
              new UiGatewayError({
                code: "internal",
                message: wakeFailureMessage(cause),
                cause,
              }),
          }),
        ),
      ),
    (connection) => Effect.sync(() => connection.close()),
  );
};
