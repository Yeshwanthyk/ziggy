import {
  hasOnlyKeys,
  isBoundedCodePointString,
  isBoundedString,
  isCommandId,
  isProfileId,
  isRecord,
  isSafeInteger,
  type ZiggyProfileId,
} from "./common";

export type ZiggyAutomationId = string;

export type ZiggyAutomationDestinationKind = "conversation" | "telegram" | "discord" | "slack";
export type ZiggyAutomationDestinationCategory =
  | "agent"
  | "session"
  | "telegram"
  | "discord"
  | "slack";

export interface ZiggyAutomationDestination {
  readonly target: string;
  readonly kind: ZiggyAutomationDestinationKind;
  readonly label?: string;
  readonly category: ZiggyAutomationDestinationCategory;
  readonly pinned: boolean;
  readonly activityAt?: string;
  readonly agentId?: string;
}

export interface ZiggyDestinationListResult {
  readonly profileId: ZiggyProfileId;
  readonly entries: ReadonlyArray<ZiggyAutomationDestination>;
  readonly nextCursor?: string;
}

export type ZiggyAutomationLifecycle = "active" | "paused" | "conflict";

export interface ZiggyAutomationDefinition {
  readonly id: ZiggyAutomationId;
  readonly valid: boolean;
  readonly lifecycle: ZiggyAutomationLifecycle;
  readonly schedule?: string;
  readonly timezone?: string;
  readonly gateState?: "scheduled" | "manual-only";
  readonly message?: string;
}

export interface ZiggyAutomationDocument {
  readonly profileId: ZiggyProfileId;
  readonly id: ZiggyAutomationId;
  readonly lifecycle: "active" | "paused";
  readonly source: string;
}

export interface ZiggyAutomationListResult {
  readonly profileId: ZiggyProfileId;
  readonly automations: ReadonlyArray<ZiggyAutomationDefinition>;
}

export interface ZiggyAutomationCreateResult extends ZiggyAutomationDefinition {
  readonly profileId: ZiggyProfileId;
}

export interface ZiggyAutomationValidationResult {
  readonly profileId: ZiggyProfileId;
  readonly validations: ReadonlyArray<ZiggyAutomationDefinition>;
}

export interface ZiggyAutomationTransitionResult {
  readonly profileId: ZiggyProfileId;
  readonly id: ZiggyAutomationId;
  readonly lifecycle: "active" | "paused";
}

export interface ZiggyAutomationSchedule {
  readonly automationId: ZiggyAutomationId;
  readonly definitionState: "valid" | "invalid" | "deleted";
  readonly nextScheduledAtMs: number | null;
  readonly definitionObservedAtMs: number;
  readonly definitionError: string | null;
}

export interface ZiggyAutomationTargetOutcome {
  readonly target: string;
  readonly status: "delivered" | "failed";
  readonly failureCategory: string | null;
  readonly retriable: boolean | null;
}

export interface ZiggyAutomationRun {
  readonly runId: string;
  readonly automationId: ZiggyAutomationId;
  readonly trigger: "manual-force" | "scheduled";
  readonly state:
    | "claimed"
    | "running"
    | "completed"
    | "failed"
    | "skipped-gate"
    | "skipped-busy"
    | "missed"
    | "unknown";
  readonly scheduledForMs: number | null;
  readonly recordedAtMs: number;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly failureCategory: string | null;
  readonly targets: ReadonlyArray<ZiggyAutomationTargetOutcome>;
}

export interface ZiggyAutomationRunCommandResult {
  readonly profileId: ZiggyProfileId;
  readonly automationId: ZiggyAutomationId;
  readonly accepted: boolean;
  readonly outcome: string;
}

export interface ZiggyAutomationStatusResult {
  readonly profileId: ZiggyProfileId;
  readonly observedAtMs: number;
  readonly heartbeatAtMs: number | null;
  readonly lastTickAtMs: number | null;
  readonly lastTickStatus: "ok" | "error" | null;
  readonly lastTickError: string | null;
  readonly schedules: ReadonlyArray<ZiggyAutomationSchedule>;
  readonly activeRunCount: number;
  readonly latestRun: ZiggyAutomationRun | null;
  readonly latestErrorRun: ZiggyAutomationRun | null;
}

export interface ZiggyAutomationRunsResult {
  readonly profileId: ZiggyProfileId;
  readonly runs: ReadonlyArray<ZiggyAutomationRun>;
}

export interface ZiggyAutomationCreateParams {
  readonly profileId: ZiggyProfileId;
  readonly automationId: ZiggyAutomationId;
  readonly commandId?: string;
}

export interface ZiggyAutomationShowParams {
  readonly profileId: ZiggyProfileId;
  readonly automationId: ZiggyAutomationId;
}

export interface ZiggyAutomationSaveParams {
  readonly profileId: ZiggyProfileId;
  readonly automationId: ZiggyAutomationId;
  readonly source: string;
  readonly expectedSource: string;
  readonly commandId?: string;
}

export interface ZiggyAutomationCommandParams {
  readonly profileId: ZiggyProfileId;
  readonly automationId: ZiggyAutomationId;
  readonly commandId?: string;
}

export interface ZiggyAutomationRunsParams {
  readonly profileId: ZiggyProfileId;
  readonly automationId?: ZiggyAutomationId;
}

export interface ZiggyAutomationRequestMap {
  readonly "destination.list": { readonly profileId: ZiggyProfileId; readonly after?: string };
  readonly "automation.list": { readonly profileId: ZiggyProfileId };
  readonly "automation.show": ZiggyAutomationShowParams;
  readonly "automation.create": ZiggyAutomationCreateParams;
  readonly "automation.save": ZiggyAutomationSaveParams;
  readonly "automation.validate": ZiggyAutomationShowParams;
  readonly "automation.pause": ZiggyAutomationCommandParams;
  readonly "automation.resume": ZiggyAutomationCommandParams;
  readonly "automation.run": ZiggyAutomationCommandParams;
  readonly "automation.status": { readonly profileId: ZiggyProfileId };
  readonly "automation.runs": ZiggyAutomationRunsParams;
}

export interface ZiggyAutomationResultMap {
  readonly "destination.list": ZiggyDestinationListResult;
  readonly "automation.list": ZiggyAutomationListResult;
  readonly "automation.show": ZiggyAutomationDocument;
  readonly "automation.create": ZiggyAutomationCreateResult;
  readonly "automation.save": ZiggyAutomationDocument;
  readonly "automation.validate": ZiggyAutomationValidationResult;
  readonly "automation.pause": ZiggyAutomationTransitionResult;
  readonly "automation.resume": ZiggyAutomationTransitionResult;
  readonly "automation.run": ZiggyAutomationRunCommandResult;
  readonly "automation.status": ZiggyAutomationStatusResult;
  readonly "automation.runs": ZiggyAutomationRunsResult;
}

export const isAutomationId = (value: unknown): value is string =>
  isBoundedString(value, 80) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);

export const isAutomationTarget = (value: unknown): value is string =>
  typeof value === "string" &&
  (/^conversation:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value) ||
    /^telegram:chat:-?[1-9][0-9]*$/u.test(value) ||
    /^discord:channel:[1-9][0-9]*$/u.test(value) ||
    /^slack:channel:[CDG][A-Z0-9]{8,}(?::thread:[1-9][0-9]*\.[0-9]{6})?$/u.test(value));

export const isDestinationListResult = (value: unknown): value is ZiggyDestinationListResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "entries", "nextCursor"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.entries) &&
  value.entries.length <= 32 &&
  value.entries.every(
    (entry) =>
      isRecord(entry) &&
      hasOnlyKeys(entry, [
        "target",
        "kind",
        "label",
        "category",
        "pinned",
        "activityAt",
        "agentId",
      ]) &&
      isAutomationTarget(entry.target) &&
      (entry.kind === "conversation" ||
        entry.kind === "telegram" ||
        entry.kind === "discord" ||
        entry.kind === "slack") &&
      (entry.category === "agent" ||
        entry.category === "session" ||
        entry.category === "telegram" ||
        entry.category === "discord" ||
        entry.category === "slack") &&
      typeof entry.pinned === "boolean" &&
      (entry.label === undefined || isBoundedCodePointString(entry.label, 160)) &&
      (entry.activityAt === undefined || isBoundedString(entry.activityAt, 128)) &&
      (entry.agentId === undefined ||
        (isBoundedString(entry.agentId, 80) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.agentId))),
  ) &&
  (value.nextCursor === undefined || isAutomationTarget(value.nextCursor));

const isAutomationDefinition = (value: unknown): value is ZiggyAutomationDefinition =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "id",
    "valid",
    "lifecycle",
    "schedule",
    "timezone",
    "gateState",
    "message",
  ]) &&
  isAutomationId(value.id) &&
  typeof value.valid === "boolean" &&
  (value.lifecycle === "active" ||
    value.lifecycle === "paused" ||
    value.lifecycle === "conflict") &&
  (value.schedule === undefined || isBoundedString(value.schedule, 256)) &&
  (value.timezone === undefined || isBoundedString(value.timezone, 128)) &&
  (value.gateState === undefined ||
    value.gateState === "scheduled" ||
    value.gateState === "manual-only") &&
  (value.message === undefined || isBoundedString(value.message, 360));

const isAutomationDocument = (value: unknown): value is ZiggyAutomationDocument =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "id", "lifecycle", "source"]) &&
  isProfileId(value.profileId) &&
  isAutomationId(value.id) &&
  (value.lifecycle === "active" || value.lifecycle === "paused") &&
  isBoundedCodePointString(value.source, 8_000, 0);

const isAutomationCreateResult = (value: unknown): value is ZiggyAutomationCreateResult =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "profileId",
    "id",
    "valid",
    "lifecycle",
    "schedule",
    "timezone",
    "gateState",
    "message",
  ]) &&
  isProfileId(value.profileId) &&
  isAutomationId(value.id) &&
  typeof value.valid === "boolean" &&
  (value.lifecycle === "active" ||
    value.lifecycle === "paused" ||
    value.lifecycle === "conflict") &&
  (value.schedule === undefined || isBoundedString(value.schedule, 256)) &&
  (value.timezone === undefined || isBoundedString(value.timezone, 128)) &&
  (value.gateState === undefined ||
    value.gateState === "scheduled" ||
    value.gateState === "manual-only") &&
  (value.message === undefined || isBoundedString(value.message, 360));

const isAutomationValidationResult = (value: unknown): value is ZiggyAutomationValidationResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "validations"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.validations) &&
  value.validations.length <= 8 &&
  value.validations.every(isAutomationDefinition);

const isAutomationTransitionResult = (value: unknown): value is ZiggyAutomationTransitionResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "id", "lifecycle"]) &&
  isProfileId(value.profileId) &&
  isAutomationId(value.id) &&
  (value.lifecycle === "active" || value.lifecycle === "paused");

const isMillis = (value: unknown): value is number => isSafeInteger(value);
const isNullableMillis = (value: unknown): value is number | null =>
  value === null || isMillis(value);

const isAutomationSchedule = (value: unknown): value is ZiggyAutomationSchedule =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "automationId",
    "definitionState",
    "nextScheduledAtMs",
    "definitionObservedAtMs",
    "definitionError",
  ]) &&
  isAutomationId(value.automationId) &&
  (value.definitionState === "valid" ||
    value.definitionState === "invalid" ||
    value.definitionState === "deleted") &&
  isNullableMillis(value.nextScheduledAtMs) &&
  isMillis(value.definitionObservedAtMs) &&
  (value.definitionError === null || isBoundedString(value.definitionError, 360));

const isAutomationTargetOutcome = (value: unknown): value is ZiggyAutomationTargetOutcome =>
  isRecord(value) &&
  hasOnlyKeys(value, ["target", "status", "failureCategory", "retriable"]) &&
  isBoundedString(value.target, 256) &&
  (value.status === "delivered" || value.status === "failed") &&
  (value.failureCategory === null || isBoundedString(value.failureCategory, 64)) &&
  (value.retriable === null || typeof value.retriable === "boolean");

const isAutomationRun = (value: unknown): value is ZiggyAutomationRun =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "runId",
    "automationId",
    "trigger",
    "state",
    "scheduledForMs",
    "recordedAtMs",
    "startedAtMs",
    "finishedAtMs",
    "failureCategory",
    "targets",
  ]) &&
  isBoundedString(value.runId, 256) &&
  isAutomationId(value.automationId) &&
  (value.trigger === "manual-force" || value.trigger === "scheduled") &&
  (value.state === "claimed" ||
    value.state === "running" ||
    value.state === "completed" ||
    value.state === "failed" ||
    value.state === "skipped-gate" ||
    value.state === "skipped-busy" ||
    value.state === "missed" ||
    value.state === "unknown") &&
  isNullableMillis(value.scheduledForMs) &&
  isMillis(value.recordedAtMs) &&
  isNullableMillis(value.startedAtMs) &&
  isNullableMillis(value.finishedAtMs) &&
  (value.failureCategory === null || isBoundedString(value.failureCategory, 128)) &&
  Array.isArray(value.targets) &&
  value.targets.length <= 8 &&
  value.targets.every(isAutomationTargetOutcome);

export const isAutomationRunCommandResult = (
  value: unknown,
): value is ZiggyAutomationRunCommandResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "automationId", "accepted", "outcome"]) &&
  isProfileId(value.profileId) &&
  isAutomationId(value.automationId) &&
  typeof value.accepted === "boolean" &&
  isBoundedString(value.outcome, 64);

const isAutomationStatus = (value: unknown): value is ZiggyAutomationStatusResult =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "profileId",
    "observedAtMs",
    "heartbeatAtMs",
    "lastTickAtMs",
    "lastTickStatus",
    "lastTickError",
    "schedules",
    "activeRunCount",
    "latestRun",
    "latestErrorRun",
  ]) &&
  isProfileId(value.profileId) &&
  isMillis(value.observedAtMs) &&
  isNullableMillis(value.heartbeatAtMs) &&
  isNullableMillis(value.lastTickAtMs) &&
  (value.lastTickStatus === null ||
    value.lastTickStatus === "ok" ||
    value.lastTickStatus === "error") &&
  (value.lastTickError === null || isBoundedString(value.lastTickError, 360)) &&
  Array.isArray(value.schedules) &&
  value.schedules.length <= 4 &&
  value.schedules.every(isAutomationSchedule) &&
  isSafeInteger(value.activeRunCount) &&
  (value.latestRun === null || isAutomationRun(value.latestRun)) &&
  (value.latestErrorRun === null || isAutomationRun(value.latestErrorRun));

export const isAutomationListResult = (value: unknown): value is ZiggyAutomationListResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "automations"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.automations) &&
  value.automations.length <= 8 &&
  value.automations.every(isAutomationDefinition);

export const isAutomationDocumentResult = isAutomationDocument;
export { isAutomationCreateResult };
export { isAutomationValidationResult };
export { isAutomationTransitionResult };
export const isAutomationStatusResult = isAutomationStatus;

export const isAutomationRunsResult = (value: unknown): value is ZiggyAutomationRunsResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "runs"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.runs) &&
  value.runs.length <= 3 &&
  value.runs.every(isAutomationRun);

export const isAutomationCommandId = isCommandId;
