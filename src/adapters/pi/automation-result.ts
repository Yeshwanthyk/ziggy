import { dirname, join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import {
  AUTOMATION_RESULT_CUSTOM_TYPE,
  AutomationConversationDeliveryFailed,
  AutomationResultDetails,
  type AutomationConversationResult,
} from "../../domain/automation";
import { SessionHeld } from "../../domain/agent";
import { locateValidSession, SessionNotFound, takeSessionLease } from "../../session";

const isAutomationResultDetails = Schema.is(AutomationResultDetails);

export const automationResultContent = (result: AutomationConversationResult): string =>
  `Automation ${result.automationId} result (run ${result.runId}):\n${result.text}`;

export const isAutomationReceipt = (
  entry: SessionEntry,
  result: AutomationConversationResult,
): boolean => {
  if (entry.type !== "custom_message" || entry.customType !== AUTOMATION_RESULT_CUSTOM_TYPE) {
    return false;
  }

  if (!isAutomationResultDetails(entry.details)) return false;

  return (
    entry.details.automationId === result.automationId &&
    entry.details.runId === result.runId &&
    entry.details.targetSessionId === result.targetSessionId
  );
};

const failure = (
  category: AutomationConversationDeliveryFailed["category"],
  retriable: boolean,
  message: string,
  cause?: unknown,
): AutomationConversationDeliveryFailed =>
  cause === undefined
    ? new AutomationConversationDeliveryFailed({ category, retriable, message })
    : new AutomationConversationDeliveryFailed({ category, retriable, message, cause });

const hasReceipt = (manager: SessionManager, result: AutomationConversationResult): boolean =>
  manager.getEntries().some((entry) => isAutomationReceipt(entry, result));

export const appendStoredAutomationResult = (
  profilePath: string,
  result: AutomationConversationResult,
): Effect.Effect<void, AutomationConversationDeliveryFailed> =>
  locateValidSession(profilePath, result.targetSessionId).pipe(
    Effect.mapError((cause) =>
      cause instanceof SessionNotFound
        ? failure("destination-missing", false, cause.message, cause)
        : failure(
            "destination-invalid",
            false,
            "could not safely resolve the destination conversation",
            cause,
          ),
    ),
    Effect.flatMap((location) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.fromResult(takeSessionLease(profilePath, result.targetSessionId)).pipe(
              Effect.mapError((cause) =>
                failure(
                  cause instanceof SessionHeld ? "session-held" : "write",
                  true,
                  cause instanceof SessionHeld ? cause.message : "could not acquire session lease",
                  cause,
                ),
              ),
            ),
            (lease) => Effect.sync(lease.release),
          );

          return yield* Effect.try({
            try: () => {
              const file = location.file;
              const manager = SessionManager.open(file, dirname(file), profilePath);

              if (manager.getSessionId() !== result.targetSessionId) {
                throw failure(
                  "destination-invalid",
                  false,
                  "resolved conversation identity did not match the requested session",
                );
              }

              if (hasReceipt(manager, result)) return;

              manager.appendCustomMessageEntry(
                AUTOMATION_RESULT_CUSTOM_TYPE,
                automationResultContent(result),
                true,
                {
                  automationId: result.automationId,
                  runId: result.runId,
                  targetSessionId: result.targetSessionId,
                },
              );

              const persisted = SessionManager.open(file, dirname(file), profilePath);

              if (!hasReceipt(persisted, result)) {
                throw new Error("Pi transcript did not contain the appended automation receipt");
              }
            },
            catch: (cause) =>
              cause instanceof AutomationConversationDeliveryFailed
                ? cause
                : failure(
                    "write",
                    true,
                    "could not durably append automation result to the conversation",
                    cause,
                  ),
          });
        }),
      ),
    ),
  );
