import { Schema } from "effect";
import { AutomationRunOutcome } from "../automation";
import { ProfileId } from "../profile-directory";
import {
  boundedString,
  boundedCodePointString,
  resultWithinWireBudget,
  UiAutomationId,
  UiExtensionId,
  UiGroupRecord,
  UiPin,
  UiGatewayMessage,
} from "./fields";

export const UiAutomationDefinition = Schema.Struct({
  id: UiAutomationId,
  valid: Schema.Boolean,
  lifecycle: Schema.Literals(["active", "paused", "conflict"]),
  schedule: Schema.optionalKey(boundedString("automation schedule", 256)),
  timezone: Schema.optionalKey(boundedString("automation timezone", 128)),
  gateState: Schema.optionalKey(Schema.Literals(["scheduled", "manual-only"])),
  message: Schema.optionalKey(UiGatewayMessage),
});

export type UiAutomationDefinition = typeof UiAutomationDefinition.Type;

export const UiAutomationListResult = Schema.Struct({
  profileId: ProfileId,
  automations: Schema.Array(UiAutomationDefinition).check(Schema.isMaxLength(8)),
}).check(resultWithinWireBudget);

export type UiAutomationListResult = typeof UiAutomationListResult.Type;

export const UiAutomationShowResult = Schema.Struct({
  profileId: ProfileId,
  id: UiAutomationId,
  lifecycle: Schema.Literals(["active", "paused"]),
  source: boundedCodePointString("automation definition source", 8_000, 0),
});

export type UiAutomationShowResult = typeof UiAutomationShowResult.Type;

export const UiAutomationSaveResult = UiAutomationShowResult;

export type UiAutomationSaveResult = typeof UiAutomationSaveResult.Type;

export const UiAutomationCreateResult = Schema.Struct({
  profileId: ProfileId,
  id: UiAutomationId,
  valid: Schema.Boolean,
  lifecycle: Schema.Literals(["active", "paused", "conflict"]),
  schedule: Schema.optionalKey(boundedString("automation schedule", 256)),
  timezone: Schema.optionalKey(boundedString("automation timezone", 128)),
  gateState: Schema.optionalKey(Schema.Literals(["scheduled", "manual-only"])),
  message: Schema.optionalKey(UiGatewayMessage),
});

export type UiAutomationCreateResult = typeof UiAutomationCreateResult.Type;

export const UiAutomationValidateResult = Schema.Struct({
  profileId: ProfileId,
  validations: Schema.Array(UiAutomationDefinition).check(Schema.isMaxLength(8)),
}).check(resultWithinWireBudget);

export type UiAutomationValidateResult = typeof UiAutomationValidateResult.Type;

export const UiAutomationPauseResult = Schema.Struct({
  profileId: ProfileId,
  id: UiAutomationId,
  lifecycle: Schema.Literals(["active", "paused"]),
});

export type UiAutomationPauseResult = typeof UiAutomationPauseResult.Type;

export const UiAutomationResumeResult = UiAutomationPauseResult;

export type UiAutomationResumeResult = typeof UiAutomationResumeResult.Type;

const UiMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const UiAutomationRun = Schema.Struct({
  runId: boundedString("automation run id", 256),
  automationId: UiAutomationId,
  trigger: Schema.Literals(["manual-force", "scheduled"]),
  state: Schema.Literals([
    "claimed",
    "running",
    "completed",
    "failed",
    "skipped-gate",
    "skipped-busy",
    "missed",
    "unknown",
  ]),
  scheduledForMs: Schema.NullOr(UiMillis),
  recordedAtMs: UiMillis,
  startedAtMs: Schema.NullOr(UiMillis),
  finishedAtMs: Schema.NullOr(UiMillis),
  failureCategory: Schema.NullOr(boundedString("automation failure category", 128)),
  targets: Schema.Array(
    Schema.Struct({
      target: boundedString("automation target", 256),
      status: Schema.Literals(["delivered", "failed"]),
      failureCategory: Schema.NullOr(boundedString("target failure category", 64)),
      retriable: Schema.NullOr(Schema.Boolean),
    }),
  ).check(Schema.isMaxLength(8)),
}).check(resultWithinWireBudget);

export type UiAutomationRun = typeof UiAutomationRun.Type;

export const UiAutomationStatusResult = Schema.Struct({
  profileId: ProfileId,
  observedAtMs: UiMillis,
  heartbeatAtMs: Schema.NullOr(UiMillis),
  lastTickAtMs: Schema.NullOr(UiMillis),
  lastTickStatus: Schema.NullOr(Schema.Literals(["ok", "error"])),
  lastTickError: Schema.NullOr(UiGatewayMessage),
  schedules: Schema.Array(
    Schema.Struct({
      automationId: UiAutomationId,
      definitionState: Schema.Literals(["valid", "invalid", "deleted"]),
      nextScheduledAtMs: Schema.NullOr(UiMillis),
      definitionObservedAtMs: UiMillis,
      definitionError: Schema.NullOr(UiGatewayMessage),
    }),
  ).check(Schema.isMaxLength(4)),
  activeRunCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  latestRun: Schema.NullOr(UiAutomationRun),
  latestErrorRun: Schema.NullOr(UiAutomationRun),
}).check(resultWithinWireBudget);

export type UiAutomationStatusResult = typeof UiAutomationStatusResult.Type;

export const UiAutomationRunsResult = Schema.Struct({
  profileId: ProfileId,
  runs: Schema.Array(UiAutomationRun).check(Schema.isMaxLength(3)),
}).check(resultWithinWireBudget);

export type UiAutomationRunsResult = typeof UiAutomationRunsResult.Type;

export const UiAutomationRunCommandResult = Schema.Struct({
  profileId: ProfileId,
  automationId: UiAutomationId,
  accepted: Schema.Boolean,
  outcome: boundedString("automation outcome", 64),
  runOutcome: AutomationRunOutcome,
}).check(resultWithinWireBudget);

export type UiAutomationRunCommandResult = typeof UiAutomationRunCommandResult.Type;

const UiExtensionDescription = boundedString("extension description", 512, 0);

const UiExtensionChoiceKind = Schema.Literals(["skill", "code", "skill+code", "remote"]);

const UiExtensionChoiceSource = Schema.Literals(["bundled", "remote-approved", "profile"]);

const UiNonNegativeCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000),
);

export const UiExtensionChoice = Schema.Struct({
  id: UiExtensionId,
  description: UiExtensionDescription,
  kind: UiExtensionChoiceKind,
  source: UiExtensionChoiceSource,
});

export type UiExtensionChoice = typeof UiExtensionChoice.Type;

export const UiExtensionListForProfileResult = Schema.Struct({
  profileId: ProfileId,
  available: Schema.Array(UiExtensionChoice).check(Schema.isMaxLength(64)),
  selected: Schema.Array(UiExtensionId).check(Schema.isMaxLength(64)),
  skipped: Schema.Array(
    Schema.Struct({
      id: boundedString("skipped package id", 128),
      diagnostics: Schema.Array(
        Schema.Struct({
          source: boundedString("diagnostic source", 240),
          message: boundedString("diagnostic message", 360),
        }),
      ).check(Schema.isMaxLength(8)),
    }),
  ).check(Schema.isMaxLength(16)),
  truncated: Schema.Boolean,
}).check(resultWithinWireBudget);

export type UiExtensionListForProfileResult = typeof UiExtensionListForProfileResult.Type;

/** Deliberately no filesystem path: Profile identity is carried by the request/result. */
export const UiExtensionMutationResult = Schema.Struct({
  profileId: ProfileId,
  id: UiExtensionId,
  changed: Schema.Boolean,
  selected: Schema.Boolean,
  restartRequired: Schema.Boolean,
});

export type UiExtensionMutationResult = typeof UiExtensionMutationResult.Type;

export const UiExtensionValidationResult = Schema.Struct({
  profileId: ProfileId,
  selected: Schema.Array(UiExtensionId).check(Schema.isMaxLength(128)),
  preflight: Schema.Struct({
    extensionPathCount: UiNonNegativeCount,
    skillPathCount: UiNonNegativeCount,
    extensionFactoryCount: UiNonNegativeCount,
  }),
});

export type UiExtensionValidationResult = typeof UiExtensionValidationResult.Type;

export const UiExtensionListing = UiExtensionListForProfileResult;

export type UiExtensionListing = UiExtensionListForProfileResult;

export const UiExtensionMutation = UiExtensionMutationResult;

export type UiExtensionMutation = UiExtensionMutationResult;

export const UiExtensionValidation = UiExtensionValidationResult;

export type UiExtensionValidation = UiExtensionValidationResult;

export const UiPinListResult = Schema.Struct({
  profileId: ProfileId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pins: Schema.Array(UiPin).check(Schema.isMaxLength(16)),
}).check(resultWithinWireBudget);

export type UiPinListResult = typeof UiPinListResult.Type;

export const UiPinMutationResult = UiPinListResult;

export type UiPinMutationResult = typeof UiPinMutationResult.Type;

export const UiGroupListResult = Schema.Struct({
  profileId: ProfileId,
  groups: Schema.Array(UiGroupRecord).check(Schema.isMaxLength(16)),
}).check(resultWithinWireBudget);

export type UiGroupListResult = typeof UiGroupListResult.Type;
