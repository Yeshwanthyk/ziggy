import { dirname, join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import {
  AutomationConversationDeliveryFailed,
  type AutomationConversationResult,
} from "../../domain/automation";
import { SessionNotFound } from "../../domain/session";
import { showProfileSession } from "./sessions";

export const AUTOMATION_RESULT_CUSTOM_TYPE = "ziggy.automation-result";

export const AutomationResultDetails = Schema.Struct({
  automationId: Schema.String.check(
    Schema.makeFilter((value) => /^[a-z0-9-]{1,80}$/u.test(value), {
      expected: "a bounded lowercase kebab-case automation id",
    }),
  ),
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  targetSessionId: Schema.String.check(
    Schema.makeFilter(
      (value) => value.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value),
      { expected: "a canonical 1-128 character Pi session id" },
    ),
  ),
});

export type AutomationResultDetails = typeof AutomationResultDetails.Type;

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
  showProfileSession(profilePath, result.targetSessionId).pipe(
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
    Effect.flatMap((metadata) =>
      Effect.try({
        try: () => {
          const file = join(profilePath, "sessions", metadata.path);
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
      }),
    ),
  );
