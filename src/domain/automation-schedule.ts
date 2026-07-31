import { Cron, Effect, Result, Schema } from "effect";

export type AutomationSchedule =
  | {
      readonly kind: "cron";
      readonly expression: string;
      readonly timezone: string;
    }
  | {
      readonly kind: "at";
      readonly instant: string;
    }
  | {
      readonly kind: "every";
      readonly seconds: number;
    };

export interface AutomationScheduleFields {
  readonly schedule?: string;
  readonly timezone?: string;
}

export class AutomationScheduleInvalid extends Schema.TaggedErrorClass<AutomationScheduleInvalid>()(
  "AutomationScheduleInvalid",
  {
    schedule: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const invalid = (schedule: string, message: string, cause?: unknown) =>
  new AutomationScheduleInvalid({
    schedule,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const requireIsoInstant = (source: string): Effect.Effect<string, AutomationScheduleInvalid> => {
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== source) {
    return Effect.fail(
      invalid(source, `invalid automation schedule ${source}: expected a canonical ISO instant`),
    );
  }
  return Effect.succeed(source);
};

export const validateAutomationSchedule = (
  schedule: AutomationSchedule,
): Effect.Effect<AutomationSchedule, AutomationScheduleInvalid> => {
  switch (schedule.kind) {
    case "cron": {
      const expression = schedule.expression.trim();
      const timezone = schedule.timezone.trim();
      const parsed = Cron.parse(expression, timezone);
      return Result.isSuccess(parsed)
        ? Effect.succeed({ kind: "cron", expression, timezone })
        : Effect.fail(
            invalid(
              `cron:${expression}`,
              `invalid cron automation schedule for timezone ${timezone}`,
              parsed.failure,
            ),
          );
    }
    case "at":
      return requireIsoInstant(schedule.instant).pipe(
        Effect.map((instant) => ({ kind: "at" as const, instant })),
      );
    case "every":
      return Number.isSafeInteger(schedule.seconds) && schedule.seconds > 0
        ? Effect.succeed(schedule)
        : Effect.fail(
            invalid(
              `every:${schedule.seconds}`,
              "invalid every automation schedule: seconds must be a positive safe integer",
            ),
          );
  }
};

export const parseAutomationScheduleFields = ({
  schedule,
  timezone,
}: AutomationScheduleFields): Effect.Effect<
  AutomationSchedule | undefined,
  AutomationScheduleInvalid
> => {
  if (schedule === undefined) {
    return timezone === undefined
      ? Effect.sync(() => undefined)
      : Effect.fail(invalid("", "automation timezone requires a schedule"));
  }

  const separator = schedule.indexOf(":");
  if (separator < 1) {
    return Effect.fail(
      invalid(schedule, "invalid automation schedule: expected cron:, at:, or every:"),
    );
  }
  const kind = schedule.slice(0, separator);
  const value = schedule.slice(separator + 1).trim();
  if (value.length === 0) {
    return Effect.fail(invalid(schedule, "invalid automation schedule: value is empty"));
  }

  if (kind === "cron") {
    if (timezone === undefined || timezone.trim().length === 0) {
      return Effect.fail(invalid(schedule, "cron automation schedule requires timezone"));
    }
    return validateAutomationSchedule({ kind: "cron", expression: value, timezone });
  }
  if (timezone !== undefined) {
    return Effect.fail(invalid(schedule, "timezone is only valid for a cron automation schedule"));
  }
  if (kind === "at") {
    return validateAutomationSchedule({ kind: "at", instant: value });
  }
  if (kind === "every") {
    return validateAutomationSchedule({ kind: "every", seconds: Number(value) });
  }
  return Effect.fail(
    invalid(schedule, "invalid automation schedule: expected cron:, at:, or every:"),
  );
};

export const renderAutomationScheduleFields = (
  schedule: AutomationSchedule,
): ReadonlyArray<string> => {
  switch (schedule.kind) {
    case "cron":
      return [`schedule: cron:${schedule.expression}`, `timezone: ${schedule.timezone}`];
    case "at":
      return [`schedule: at:${schedule.instant}`];
    case "every":
      return [`schedule: every:${schedule.seconds}`];
  }
};

export const nextAutomationScheduleInstant = (
  schedule: AutomationSchedule,
  after: Date,
): Date | undefined => {
  switch (schedule.kind) {
    case "cron": {
      const parsed = Cron.parse(schedule.expression, schedule.timezone);
      return Result.isSuccess(parsed) ? Cron.next(parsed.success, after) : undefined;
    }
    case "at": {
      const instant = new Date(schedule.instant);
      return instant.getTime() > after.getTime() ? instant : undefined;
    }
    case "every": {
      const interval = schedule.seconds * 1_000;
      return new Date((Math.floor(after.getTime() / interval) + 1) * interval);
    }
  }
};

const latestAutomationScheduleInstant = (
  schedule: AutomationSchedule,
  now: Date,
): Date | undefined => {
  switch (schedule.kind) {
    case "cron": {
      const parsed = Cron.parse(schedule.expression, schedule.timezone);
      return Result.isSuccess(parsed)
        ? Cron.prev(parsed.success, new Date(now.getTime() + 1))
        : undefined;
    }
    case "at":
      return new Date(schedule.instant);
    case "every": {
      const interval = schedule.seconds * 1_000;
      return new Date(Math.floor(now.getTime() / interval) * interval);
    }
  }
};

export const canonicalAutomationFiringId = (automationId: string, scheduledInstant: Date): string =>
  `${automationId}@${scheduledInstant.toISOString()}`;

export type AutomationDueDecision =
  | { readonly kind: "not-due"; readonly next: Date | undefined }
  | { readonly kind: "due"; readonly instant: Date; readonly firingId: string }
  | { readonly kind: "missed"; readonly instant: Date };

export const decideAutomationDue = (
  automationId: string,
  schedule: AutomationSchedule,
  previousInstant: Date | undefined,
  now: Date,
  graceSeconds: number,
): AutomationDueDecision => {
  const candidate =
    previousInstant === undefined
      ? latestAutomationScheduleInstant(schedule, now)
      : nextAutomationScheduleInstant(schedule, previousInstant);
  if (candidate === undefined || candidate.getTime() > now.getTime()) {
    return { kind: "not-due", next: candidate };
  }
  if (now.getTime() - candidate.getTime() > graceSeconds * 1_000) {
    return {
      kind: "missed",
      instant: latestAutomationScheduleInstant(schedule, now) ?? candidate,
    };
  }
  return {
    kind: "due",
    instant: candidate,
    firingId: canonicalAutomationFiringId(automationId, candidate),
  };
};
