import { createHash } from "node:crypto";
import { Cron, DateTime, Effect, Option, Result, Schema } from "effect";
import { parseLeadingProfileAgentMention } from "./profile";

const AutomationIdSchema = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9-]+$/.test(value) && value.length <= 80, {
    expected: "1-80 lowercase kebab-case characters from [a-z0-9-]",
  }),
);
const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const CronValue = Schema.declare(Cron.isCron, { expected: "a parsed cron expression" });

const TelegramTarget = Schema.TaggedStruct("telegram", {
  target: Schema.String,
  chatId: Schema.Finite,
});
const DiscordTarget = Schema.TaggedStruct("discord", {
  target: Schema.String,
  channelId: Schema.String,
});
const SlackTarget = Schema.TaggedStruct("slack", {
  target: Schema.String,
  channelId: Schema.String,
  threadTs: Schema.optional(Schema.String),
});
export const AutomationTarget = Schema.Union([TelegramTarget, DiscordTarget, SlackTarget]);
export type AutomationTarget = typeof AutomationTarget.Type;
export type AutomationBroadcastToken = "origin" | "all" | AutomationTarget;

const AutomationSpecialist = Schema.Struct({
  agentId: NonEmpty,
  task: NonEmpty,
});

export const Automation = Schema.Struct({
  id: AutomationIdSchema,
  version: Schema.Literal(1),
  schedule: Schema.Struct({ cronSource: NonEmpty, timezone: NonEmpty, cron: CronValue }),
  gate: Schema.optional(NonEmpty),
  broadcast: Schema.Array(Schema.Union([Schema.Literals(["origin", "all"]), AutomationTarget])),
  origin: Schema.optional(AutomationTarget),
  prompt: NonEmpty,
  specialist: Schema.optional(AutomationSpecialist),
});
export type Automation = typeof Automation.Type;

const AutomationFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  cron: NonEmpty,
  timezone: NonEmpty,
  gate: Schema.optional(NonEmpty),
  broadcast: NonEmpty,
  origin: Schema.optional(NonEmpty),
  prompt: NonEmpty,
});

const targetFromSource = (source: string): AutomationTarget | undefined => {
  const telegram = /^telegram:chat:(-?[1-9][0-9]*)$/.exec(source);
  if (telegram?.[1] !== undefined) {
    const chatId = Number(telegram[1]);
    if (Number.isSafeInteger(chatId) && chatId !== 0 && String(chatId) === telegram[1]) {
      return { _tag: "telegram", target: source, chatId };
    }
  }
  const discord = /^discord:channel:([1-9][0-9]*)$/.exec(source);
  if (discord?.[1] !== undefined) return { _tag: "discord", target: source, channelId: discord[1] };
  const slack = /^slack:channel:([CDG][A-Z0-9]{8,})(?::thread:([1-9][0-9]*\.[0-9]{6}))?$/.exec(
    source,
  );
  return slack?.[1] === undefined
    ? undefined
    : {
        _tag: "slack",
        target: source,
        channelId: slack[1],
        ...Object.fromEntries(slack[2] === undefined ? [] : ([["threadTs", slack[2]]] as const)),
      };
};

const CanonicalTargetString = Schema.String.check(
  Schema.makeFilter((value) => targetFromSource(value) !== undefined, {
    expected: "a canonical automation target",
  }),
);
export const BroadcastsFile = Schema.Struct({ targets: Schema.Array(CanonicalTargetString) });
export const decodeBroadcastsFileJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(BroadcastsFile),
  { onExcessProperty: "error" },
);

const decodeAutomationId = Schema.decodeUnknownEffect(AutomationIdSchema);
const decodeAutomationFile = Schema.decodeUnknownEffect(AutomationFileSchema, {
  onExcessProperty: "error",
});

export class AutomationInvalid extends Schema.TaggedErrorClass<AutomationInvalid>()(
  "AutomationInvalid",
  { path: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}
export class AutomationNotFound extends Schema.TaggedErrorClass<AutomationNotFound>()(
  "AutomationNotFound",
  { id: Schema.String, path: Schema.String, message: Schema.String },
) {}
export class AutomationPaused extends Schema.TaggedErrorClass<AutomationPaused>()(
  "AutomationPaused",
  { id: Schema.String, path: Schema.String, message: Schema.String },
) {}
export class AutomationEditConflict extends Schema.TaggedErrorClass<AutomationEditConflict>()(
  "AutomationEditConflict",
  { id: Schema.String, path: Schema.String, message: Schema.String },
) {}
export class AutomationFileSystemError extends Schema.TaggedErrorClass<AutomationFileSystemError>()(
  "AutomationFileSystemError",
  { path: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}
export class AutomationGateFailed extends Schema.TaggedErrorClass<AutomationGateFailed>()(
  "AutomationGateFailed",
  {
    automationId: Schema.String,
    command: Schema.String,
    reason: Schema.Literals(["spawn", "wait", "timeout"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const AutomationResolutionCategorySchema = Schema.Literals([
  "broadcasts-unreadable",
  "broadcasts-invalid",
  "all-empty",
]);
export type AutomationResolutionCategory = typeof AutomationResolutionCategorySchema.Type;
const AutomationDeliveryFailureCategorySchema = Schema.Literals([
  "configuration",
  "authentication",
  "rate-limited",
  "transport",
  "remote",
  "invalid-response",
]);
export type AutomationDeliveryFailureCategory = typeof AutomationDeliveryFailureCategorySchema.Type;
export const AutomationTargetOutcome = Schema.Union([
  Schema.Struct({ target: CanonicalTargetString, status: Schema.Literal("delivered") }),
  Schema.Struct({
    target: CanonicalTargetString,
    status: Schema.Literal("failed"),
    category: AutomationDeliveryFailureCategorySchema,
    retriable: Schema.Boolean,
  }),
]);
export type AutomationTargetOutcome = typeof AutomationTargetOutcome.Type;
export type AutomationTrigger =
  | { readonly kind: "manual-force" }
  | {
      readonly kind: "scheduled";
      readonly scheduledFor: string;
      readonly scheduleFingerprint: string;
      readonly residentOwnerId: string;
    };

export type AutomationRunOutcome =
  | { readonly kind: "skipped-busy" }
  | { readonly kind: "declined"; readonly reason: "gate-nonzero"; readonly exitCode: number }
  | {
      readonly kind: "executed";
      readonly delivery:
        | { readonly kind: "resolved"; readonly targets: ReadonlyArray<AutomationTargetOutcome> }
        | { readonly kind: "resolution-failed"; readonly category: AutomationResolutionCategory };
    };

const Millis = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Integer = Schema.Finite.check(Schema.isInt());
const Ordinal = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const ScheduleFingerprint = Schema.String.check(
  Schema.makeFilter((value) => /^[0-9a-f]{64}$/.test(value), {
    expected: "a 64-character lowercase hexadecimal schedule fingerprint",
  }),
);
// oxfmt-ignore
export const AutomationScheduleRecord = Schema.Struct({ automationId: Schema.String, definitionState: Schema.Literals(["valid", "invalid", "deleted"]), scheduleFingerprint: Schema.NullOr(ScheduleFingerprint), nextScheduledAtMs: Schema.NullOr(Millis), definitionObservedAtMs: Millis, definitionError: Schema.NullOr(Schema.String) }).check(Schema.makeFilter((value) => (value.definitionState === "valid" && value.scheduleFingerprint !== null && value.nextScheduledAtMs !== null && value.definitionError === null) || (value.definitionState === "invalid" && value.definitionError !== null) || (value.definitionState === "deleted" && value.nextScheduledAtMs === null && value.definitionError === null), { expected: "a structurally consistent automation schedule record" }));
export type AutomationScheduleRecord = typeof AutomationScheduleRecord.Type;
const AutomationScheduleOccurrence = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("due"),
    runId: NonEmpty,
    scheduledForMs: Millis,
    missedThroughMs: Schema.Null,
    scheduleFingerprint: ScheduleFingerprint,
  }),
  Schema.Struct({
    kind: Schema.Literal("missed"),
    runId: NonEmpty,
    scheduledForMs: Millis,
    missedThroughMs: Millis,
    scheduleFingerprint: ScheduleFingerprint,
  }),
]);
// oxfmt-ignore
export const AutomationScheduleMutation = Schema.Struct({ expected: Schema.NullOr(AutomationScheduleRecord), next: AutomationScheduleRecord, occurrence: Schema.optional(AutomationScheduleOccurrence) }).check(Schema.makeFilter((value) => value.occurrence === undefined || (value.next.definitionState === "valid" && value.next.automationId.length > 0 && value.next.scheduleFingerprint === value.occurrence.scheduleFingerprint && (value.occurrence.kind === "due" || value.occurrence.missedThroughMs >= value.occurrence.scheduledForMs)), { expected: "a schedule mutation whose occurrence matches its valid schedule" }));
export type AutomationScheduleMutation = typeof AutomationScheduleMutation.Type;
// oxfmt-ignore
export const AutomationTargetProjection = Schema.Struct({ ordinal: Ordinal, target: CanonicalTargetString, status: Schema.Literals(["delivered", "failed"]), failureCategory: Schema.NullOr(AutomationDeliveryFailureCategorySchema), retriable: Schema.NullOr(Schema.Boolean) }).check(Schema.makeFilter((value) => (value.status === "delivered" && value.failureCategory === null && value.retriable === null) || (value.status === "failed" && value.failureCategory !== null && value.retriable !== null), { expected: "a structurally consistent automation target outcome" }));
export type AutomationTargetProjection = typeof AutomationTargetProjection.Type;
const AutomationRunFailureCategory = Schema.Literals([
  "broadcasts-unreadable",
  "broadcasts-invalid",
  "all-empty",
  "configuration",
  "authentication",
  "rate-limited",
  "transport",
  "remote",
  "invalid-response",
  "AutomationInvalid",
  "AutomationNotFound",
  "AutomationPaused",
  "AutomationFileSystemError",
  "AutomationGateFailed:spawn",
  "AutomationGateFailed:wait",
  "AutomationGateFailed:timeout",
  "AutomationDatabaseError",
  "ProfileNotInitialized",
  "ProviderConfigError",
  "ProviderCallError",
  "MemoryIdInvalid",
  "ProfileExtensionInvalid",
  "ProfileFileSystemError",
  "ProfileAgentInvalid",
  "ProfileAgentMentionInvalid",
  "SpecialistAgentNotFound",
  "SpecialistProviderUnsupported",
  "SpecialistModelUnsupported",
  "SpecialistAuthUnavailable",
  "SpecialistThinkingUnsupported",
  "SpecialistToolUnsupported",
  "SpecialistRunFailed",
  "interrupted",
  "gate-missing",
  "gate-nonzero",
  "process-start",
]);
const resolutionFailureCategories: ReadonlySet<string> = new Set([
  "broadcasts-unreadable",
  "broadcasts-invalid",
  "all-empty",
]);
const deliveryFailureCategories: ReadonlySet<string> = new Set([
  "configuration",
  "authentication",
  "rate-limited",
  "transport",
  "remote",
  "invalid-response",
]);
const executionFailureCategories: ReadonlySet<string> = new Set([
  "AutomationInvalid",
  "AutomationNotFound",
  "AutomationPaused",
  "AutomationFileSystemError",
  "AutomationGateFailed:spawn",
  "AutomationGateFailed:wait",
  "AutomationGateFailed:timeout",
  "AutomationDatabaseError",
  "ProfileNotInitialized",
  "ProviderConfigError",
  "ProviderCallError",
  "MemoryIdInvalid",
  "ProfileExtensionInvalid",
  "ProfileFileSystemError",
  "ProfileAgentInvalid",
  "ProfileAgentMentionInvalid",
  "SpecialistAgentNotFound",
  "SpecialistProviderUnsupported",
  "SpecialistModelUnsupported",
  "SpecialistAuthUnavailable",
  "SpecialistThinkingUnsupported",
  "SpecialistToolUnsupported",
  "SpecialistRunFailed",
  "interrupted",
]);
// oxfmt-ignore
export const AutomationRunTerminal = Schema.Struct({ state: Schema.Literals(["completed", "failed", "skipped-gate"]), atMs: Millis, localCompleted: Schema.Boolean, failureCategory: Schema.NullOr(AutomationRunFailureCategory), gateExitCode: Schema.NullOr(Integer) }).check(Schema.makeFilter((value) => {
  const stateValid = value.state === "completed" ? value.localCompleted && value.failureCategory === null : value.state === "failed" ? value.failureCategory !== null && (value.localCompleted ? resolutionFailureCategories.has(value.failureCategory) || deliveryFailureCategories.has(value.failureCategory) : executionFailureCategories.has(value.failureCategory)) : !value.localCompleted && (value.failureCategory === "gate-missing" || value.failureCategory === "gate-nonzero");
  const gateValid = value.failureCategory === "gate-nonzero" ? value.gateExitCode !== null && value.gateExitCode !== 0 : value.gateExitCode === null;
  return stateValid && gateValid;
}, { expected: "a structurally consistent automation run terminal" }));
export type AutomationRunTerminal = typeof AutomationRunTerminal.Type;
// oxfmt-ignore
export const AutomationRunCompletion = Schema.Struct({ terminal: AutomationRunTerminal, targets: Schema.Array(AutomationTargetOutcome) }).check(Schema.makeFilter((value) => {
  const firstFailedTarget = value.targets.find((target) => target.status === "failed");
  return value.terminal.state === "completed" ? value.targets.every((target) => target.status === "delivered") : value.terminal.state !== "failed" ? value.targets.length === 0 : value.terminal.localCompleted ? value.terminal.failureCategory !== null && (resolutionFailureCategories.has(value.terminal.failureCategory) ? value.targets.length === 0 : deliveryFailureCategories.has(value.terminal.failureCategory) && firstFailedTarget?.category === value.terminal.failureCategory) : value.targets.length === 0;
}, { expected: "terminal state and target outcomes from the same valid run transition" }));
export type AutomationRunCompletion = typeof AutomationRunCompletion.Type;
// oxfmt-ignore
export const AutomationRunProjection = Schema.Struct({ runId: Schema.String, automationId: Schema.String, trigger: Schema.Literals(["manual-force", "scheduled"]), state: Schema.Literals(["claimed", "running", "completed", "failed", "skipped-gate", "skipped-busy", "missed", "unknown"]), scheduleFingerprint: Schema.NullOr(ScheduleFingerprint), scheduledForMs: Schema.NullOr(Millis), missedThroughMs: Schema.NullOr(Millis), recordedAtMs: Millis, startedAtMs: Schema.NullOr(Millis), finishedAtMs: Schema.NullOr(Millis), localCompleted: Schema.Boolean, failureCategory: Schema.NullOr(AutomationRunFailureCategory), gateExitCode: Schema.NullOr(Integer), targets: Schema.Array(AutomationTargetProjection) }).check(Schema.makeFilter((value) => {
  const triggerValid = value.trigger === "manual-force" ? value.scheduleFingerprint === null && value.scheduledForMs === null : value.scheduleFingerprint !== null && value.scheduledForMs !== null;
  const lifecycleValid = value.state === "claimed" ? value.startedAtMs === null && value.finishedAtMs === null : value.state === "running" ? value.startedAtMs !== null && value.finishedAtMs === null : value.finishedAtMs !== null;
  const missedValid = value.state === "missed" ? value.trigger === "scheduled" && value.missedThroughMs !== null && value.scheduledForMs !== null && value.missedThroughMs >= value.scheduledForMs : value.missedThroughMs === null;
  const failureValid = value.state === "completed" ? value.localCompleted && value.failureCategory === null : value.state === "failed" ? value.failureCategory !== null : value.state === "skipped-gate" ? !value.localCompleted && (value.failureCategory === "gate-missing" || value.failureCategory === "gate-nonzero") : value.state === "unknown" ? !value.localCompleted && value.failureCategory === "process-start" : !value.localCompleted && value.failureCategory === null;
  const gateValid = value.failureCategory === "gate-nonzero" ? value.gateExitCode !== null && value.gateExitCode !== 0 : value.gateExitCode === null;
  const firstFailedTarget = value.targets.find((target) => target.status === "failed");
  const targetsValid = value.state === "completed" ? value.targets.every((target) => target.status === "delivered") : value.state !== "failed" ? value.targets.length === 0 : value.localCompleted ? value.failureCategory !== null && (resolutionFailureCategories.has(value.failureCategory) ? value.targets.length === 0 : deliveryFailureCategories.has(value.failureCategory) && firstFailedTarget?.failureCategory === value.failureCategory) : value.failureCategory !== null && executionFailureCategories.has(value.failureCategory) && value.targets.length === 0;
  return triggerValid && lifecycleValid && missedValid && failureValid && gateValid && targetsValid;
}, { expected: "a structurally consistent automation run" }));
export type AutomationRunProjection = typeof AutomationRunProjection.Type;
// oxfmt-ignore
export interface AutomationStatusProjection { readonly profilePath: string; readonly observedAtMs: number; readonly heartbeatAtMs: number | null; readonly lastTickAtMs: number | null; readonly lastTickStatus: "ok" | "error" | null; readonly lastTickError: string | null; readonly schedules: ReadonlyArray<AutomationScheduleRecord>; readonly activeRunCount: number; readonly latestRun: AutomationRunProjection | null; readonly latestErrorRun: AutomationRunProjection | null }

// oxfmt-ignore
export class AutomationDatabaseError extends Schema.TaggedErrorClass<AutomationDatabaseError>()("AutomationDatabaseError", { operation: Schema.String, path: Schema.String, message: Schema.String, cause: Schema.Defect() }) {}
// oxfmt-ignore
export class AutomationSchedulerError extends Schema.TaggedErrorClass<AutomationSchedulerError>()("AutomationSchedulerError", { operation: Schema.String, message: Schema.String, cause: Schema.Defect() }) {}
// oxfmt-ignore
export class AutomationProjectionError extends Schema.TaggedErrorClass<AutomationProjectionError>()("AutomationProjectionError", { operation: Schema.String, path: Schema.String, message: Schema.String, cause: Schema.Defect() }) {}

const sorted = (values: ReadonlySet<number>) => [...values].sort((left, right) => left - right);
// oxfmt-ignore
export const automationScheduleFingerprint = (automation: Automation): string => {
  const fields = automation.schedule.cronSource.trim().split(/\s+/u);
  const day = fields[fields.length - 3] ?? "";
  const weekday = fields[fields.length - 1] ?? "";
  const cron = automation.schedule.cron;
  const and = (day.startsWith("*") || weekday.startsWith("*")) && cron.days.size !== 0 && cron.weekdays.size !== 0;
  return createHash("sha256").update(JSON.stringify({ version: automation.version, timezone: automation.schedule.timezone, seconds: sorted(cron.seconds), minutes: sorted(cron.minutes), hours: sorted(cron.hours), days: sorted(cron.days), months: sorted(cron.months), weekdays: sorted(cron.weekdays), and })).digest("hex");
};

export const scheduledRunId = (automationId: string, scheduledForMs: number): string =>
  `scheduled:${automationId}:${new Date(scheduledForMs).toISOString()}`;
export const manualRunId = (uuid: string): string => `manual:${uuid.toLowerCase()}`;
export const missedRunId = (
  automationId: string,
  fingerprint: string,
  firstMs: number,
  lastMs: number,
): string =>
  `missed:${automationId}:${fingerprint}:${new Date(firstMs).toISOString()}:${new Date(lastMs).toISOString()}`;
export const boundAutomationText = (value: string): string =>
  [
    ...value
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  ]
    .slice(0, 160)
    .join("");

const invalid = (path: string, message: string, cause?: unknown) =>
  new AutomationInvalid({ path, message, cause: cause ?? message });

export const validateAutomationId = (id: string): Effect.Effect<AutomationId, AutomationInvalid> =>
  decodeAutomationId(id).pipe(
    Effect.mapError((cause) =>
      invalid(
        id,
        `invalid automation id ${id}: use 1-80 lowercase kebab-case characters from [a-z0-9-]`,
        cause,
      ),
    ),
  );
export type AutomationId = typeof AutomationIdSchema.Type;

export const parseAutomationTarget = (
  id: string,
  path: string,
  source: string,
): Effect.Effect<AutomationTarget, AutomationInvalid> => {
  const target = targetFromSource(source);
  return target === undefined
    ? Effect.fail(invalid(path, `invalid automation ${id}: invalid broadcast target ${source}`))
    : Effect.succeed(target);
};

const parseBroadcast = (id: string, path: string, source: string) =>
  Effect.gen(function* () {
    if (source === "none") return [];
    if (!/^[^\s,]+(?:,[^\s,]+)*$/.test(source)) {
      return yield* invalid(path, `invalid automation ${id}: invalid broadcast policy`);
    }
    const tokens: Array<AutomationBroadcastToken> = [];
    for (const token of source.split(",")) {
      if (token === "none") {
        return yield* invalid(
          path,
          `invalid automation ${id}: none must be the whole broadcast value`,
        );
      }
      tokens.push(
        token === "origin" || token === "all"
          ? token
          : yield* parseAutomationTarget(id, path, token),
      );
    }
    return tokens;
  });

export const parseAutomationFile = (
  id: AutomationId,
  filePath: string,
  source: string,
): Effect.Effect<Automation, AutomationInvalid> =>
  Effect.gen(function* () {
    const lines = source.replaceAll("\r\n", "\n").split("\n");
    if (lines[0] !== "---")
      return yield* invalid(filePath, `invalid automation ${id}: frontmatter must start with ---`);
    const end = lines.indexOf("---", 1);
    if (end === -1)
      return yield* invalid(filePath, `invalid automation ${id}: frontmatter must end with ---`);

    const entries: Array<readonly [string, unknown]> = [];
    const keys = new Set<string>();
    for (const line of lines.slice(1, end)) {
      const separator = line.indexOf(":");
      if (separator <= 0)
        return yield* invalid(
          filePath,
          `invalid automation ${id}: expected one key: value per line`,
        );
      const key = line.slice(0, separator);
      const rawValue = line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (key !== key.trim() || keys.has(key))
        return yield* invalid(
          filePath,
          `invalid automation ${id}: invalid or duplicate key ${key.trim()}`,
        );
      if (key === "telegram-chat")
        return yield* invalid(
          filePath,
          `invalid automation ${id}: telegram-chat is no longer supported; use broadcast: telegram:chat:<chat-id>`,
        );
      if (key === "prompt")
        return yield* invalid(
          filePath,
          `invalid automation ${id}: prompt belongs in the Markdown body`,
        );
      keys.add(key);
      entries.push([key, key === "version" && value.trim() === "1" ? 1 : value]);
    }
    const rawBody = lines.slice(end + 1).join("\n");
    const body = rawBody.trim();
    const mention = parseLeadingProfileAgentMention(rawBody);
    if (mention.kind === "invalid") {
      return yield* invalid(filePath, `invalid automation ${id}: ${mention.message}`);
    }
    const prompt = mention.kind === "tagged" ? mention.task : body;
    const decoded = yield* decodeAutomationFile(
      Object.fromEntries([...entries, ["prompt", prompt]]),
    ).pipe(
      Effect.mapError((cause) =>
        invalid(filePath, `invalid automation ${id}: frontmatter or body failed validation`, cause),
      ),
    );
    if (
      [decoded.cron, decoded.timezone, decoded.broadcast, decoded.gate, decoded.origin].some(
        (value) => value !== undefined && value !== value.trim(),
      )
    ) {
      return yield* invalid(
        filePath,
        `invalid automation ${id}: frontmatter values must not have leading or trailing whitespace`,
      );
    }
    if (
      /^[+-]\d{2}:\d{2}$/.test(decoded.timezone) ||
      Option.isNone(DateTime.zoneMakeNamed(decoded.timezone))
    ) {
      return yield* invalid(
        filePath,
        `invalid automation ${id}: timezone must be a named IANA timezone`,
      );
    }
    const cron = Cron.parse(decoded.cron, decoded.timezone);
    if (Result.isFailure(cron))
      return yield* invalid(filePath, `invalid automation ${id}: invalid cron`, cron.failure);
    const broadcast = yield* parseBroadcast(id, filePath, decoded.broadcast);
    const origin =
      decoded.origin === undefined
        ? undefined
        : yield* parseAutomationTarget(id, filePath, decoded.origin);
    if (broadcast.includes("origin") && origin === undefined)
      return yield* invalid(
        filePath,
        `invalid automation ${id}: broadcast origin requires an origin field`,
      );
    return {
      id,
      version: 1 as const,
      schedule: { cronSource: decoded.cron, timezone: decoded.timezone, cron: cron.success },
      broadcast,
      prompt: decoded.prompt,
      ...Object.fromEntries(
        [
          mention.kind === "tagged"
            ? (["specialist", { agentId: mention.agentId, task: mention.task }] as const)
            : undefined,
          decoded.gate !== undefined ? (["gate", decoded.gate] as const) : undefined,
          origin !== undefined ? (["origin", origin] as const) : undefined,
        ].flatMap((entry) => (entry === undefined ? [] : [entry])),
      ),
    };
  });
