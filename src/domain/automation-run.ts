import { Effect, Schema } from "effect";

const IdentifierSchema = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(value), {
    expected: "1-80 lowercase kebab-case characters",
  }),
);

const TimestampSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
    },
    { expected: "an ISO 8601 UTC timestamp" },
  ),
);

const NonEmptyLineSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 && value === value.trim() && !value.includes("\n") && !value.includes("\r"),
    { expected: "a non-empty trimmed line" },
  ),
);

export const AutomationRunStatusSchema = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "unknown",
  "skipped",
]);

export const AutomationDeliveryStatusSchema = Schema.Literals([
  "pending",
  "succeeded",
  "failed",
  "unknown",
  "skipped",
]);

export const AutomationDeliveryOutcomeSchema = Schema.Struct({
  target: NonEmptyLineSchema,
  status: AutomationDeliveryStatusSchema,
  finishedAt: Schema.optional(TimestampSchema),
  error: Schema.optional(Schema.String),
});

const AutomationRunReceiptFields = Schema.Struct({
  version: Schema.Literal(1),
  runId: IdentifierSchema,
  automationId: IdentifierSchema,
  trigger: Schema.Literals(["manual", "scheduled"]),
  scheduledInstant: Schema.optional(TimestampSchema),
  firingId: Schema.optional(NonEmptyLineSchema),
  status: AutomationRunStatusSchema,
  claimedAt: TimestampSchema,
  startedAt: Schema.optional(TimestampSchema),
  finishedAt: Schema.optional(TimestampSchema),
  sessionPath: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  localOutput: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  deliveries: Schema.Array(AutomationDeliveryOutcomeSchema),
});

export const AutomationRunReceiptSchema = AutomationRunReceiptFields.check(
  Schema.makeFilter(
    (receipt) =>
      receipt.trigger === "scheduled"
        ? receipt.scheduledInstant !== undefined && receipt.firingId !== undefined
        : receipt.scheduledInstant === undefined && receipt.firingId === undefined,
    {
      expected:
        "scheduled receipts require scheduledInstant and firingId; manual receipts forbid them",
    },
  ),
  Schema.makeFilter(
    (receipt) =>
      receipt.status === "running"
        ? receipt.finishedAt === undefined
        : receipt.finishedAt !== undefined,
    { expected: "running receipts have no finishedAt; terminal receipts require finishedAt" },
  ),
);

export type AutomationRunStatus = typeof AutomationRunStatusSchema.Type;
export type AutomationDeliveryOutcome = typeof AutomationDeliveryOutcomeSchema.Type;
export type AutomationRunReceipt = typeof AutomationRunReceiptSchema.Type;

export class AutomationRunInvalid extends Schema.TaggedErrorClass<AutomationRunInvalid>()(
  "AutomationRunInvalid",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const decodeReceipt = Schema.decodeUnknownEffect(AutomationRunReceiptSchema, {
  onExcessProperty: "error",
});
const decodeDeliveries = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(AutomationDeliveryOutcomeSchema)),
  { onExcessProperty: "error" },
);
const decodeJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String));

const jsonField = (value: string): string => JSON.stringify(value);

export const parseAutomationRunReceipt = (
  path: string,
  source: string,
): Effect.Effect<AutomationRunReceipt, AutomationRunInvalid> =>
  Effect.gen(function* () {
    const normalized = source.replaceAll("\r\n", "\n");
    const lines = normalized.split("\n");
    if (lines[0] !== "---") {
      return yield* new AutomationRunInvalid({
        path,
        message: `invalid automation receipt at ${path}: frontmatter must start with ---`,
        cause: source,
      });
    }
    const closing = lines.indexOf("---", 1);
    if (closing === -1) {
      return yield* new AutomationRunInvalid({
        path,
        message: `invalid automation receipt at ${path}: frontmatter must end with ---`,
        cause: source,
      });
    }

    const fields = new Map<string, string>();
    for (const line of lines.slice(1, closing)) {
      const separator = line.indexOf(":");
      const key = line.slice(0, separator);
      if (separator <= 0 || key !== key.trim() || fields.has(key)) {
        return yield* new AutomationRunInvalid({
          path,
          message: `invalid automation receipt at ${path}: malformed or duplicate frontmatter`,
          cause: line,
        });
      }
      fields.set(key, line.slice(separator + 1).trim());
    }

    const required = (key: string): Effect.Effect<string, AutomationRunInvalid> => {
      const value = fields.get(key);
      return value === undefined
        ? Effect.fail(
            new AutomationRunInvalid({
              path,
              message: `invalid automation receipt at ${path}: missing ${key}`,
              cause: key,
            }),
          )
        : Effect.succeed(value);
    };
    const optionalJson = (key: string) => {
      const value = fields.get(key);
      return value === undefined
        ? Effect.sync((): undefined => undefined)
        : decodeJsonString(value).pipe(
            Effect.mapError(
              (cause) =>
                new AutomationRunInvalid({
                  path,
                  message: `invalid automation receipt at ${path}: invalid ${key}`,
                  cause,
                }),
            ),
          );
    };

    const knownKeys = new Set([
      "version",
      "run-id",
      "automation-id",
      "trigger",
      "scheduled-instant",
      "firing-id",
      "status",
      "claimed-at",
      "started-at",
      "finished-at",
      "session-path",
      "error",
      "deliveries",
    ]);
    const excess = [...fields.keys()].find((key) => !knownKeys.has(key));
    if (excess !== undefined) {
      return yield* new AutomationRunInvalid({
        path,
        message: `invalid automation receipt at ${path}: unknown field ${excess}`,
        cause: excess,
      });
    }

    const deliveriesSource = yield* required("deliveries");
    const deliveries = yield* decodeDeliveries(deliveriesSource).pipe(
      Effect.mapError(
        (cause) =>
          new AutomationRunInvalid({
            path,
            message: `invalid automation receipt at ${path}: invalid deliveries`,
            cause,
          }),
      ),
    );
    const body = lines
      .slice(closing + 1)
      .join("\n")
      .replace(/^\n/, "")
      .replace(/\n$/, "");
    const receipt = {
      version: (yield* required("version")) === "1" ? 1 : yield* required("version"),
      runId: yield* required("run-id"),
      automationId: yield* required("automation-id"),
      trigger: yield* required("trigger"),
      status: yield* required("status"),
      claimedAt: yield* required("claimed-at"),
      deliveries,
      ...(fields.has("scheduled-instant")
        ? { scheduledInstant: yield* required("scheduled-instant") }
        : {}),
      ...(fields.has("firing-id") ? { firingId: yield* optionalJson("firing-id") } : {}),
      ...(fields.has("started-at") ? { startedAt: yield* required("started-at") } : {}),
      ...(fields.has("finished-at") ? { finishedAt: yield* required("finished-at") } : {}),
      ...(fields.has("session-path") ? { sessionPath: yield* optionalJson("session-path") } : {}),
      ...(body.length === 0 ? {} : { localOutput: body }),
      ...(fields.has("error") ? { error: yield* optionalJson("error") } : {}),
    };
    return yield* decodeReceipt(receipt).pipe(
      Effect.mapError(
        (cause) =>
          new AutomationRunInvalid({
            path,
            message: `invalid automation receipt at ${path}: fields failed validation`,
            cause,
          }),
      ),
    );
  });

export const renderAutomationRunReceipt = (receipt: AutomationRunReceipt): string =>
  [
    "---",
    "version: 1",
    `run-id: ${receipt.runId}`,
    `automation-id: ${receipt.automationId}`,
    `trigger: ${receipt.trigger}`,
    ...(receipt.scheduledInstant === undefined
      ? []
      : [`scheduled-instant: ${receipt.scheduledInstant}`]),
    ...(receipt.firingId === undefined ? [] : [`firing-id: ${jsonField(receipt.firingId)}`]),
    `status: ${receipt.status}`,
    `claimed-at: ${receipt.claimedAt}`,
    ...(receipt.startedAt === undefined ? [] : [`started-at: ${receipt.startedAt}`]),
    ...(receipt.finishedAt === undefined ? [] : [`finished-at: ${receipt.finishedAt}`]),
    ...(receipt.sessionPath === undefined
      ? []
      : [`session-path: ${jsonField(receipt.sessionPath)}`]),
    ...(receipt.error === undefined ? [] : [`error: ${jsonField(receipt.error)}`]),
    `deliveries: ${JSON.stringify(receipt.deliveries)}`,
    "---",
    "",
    ...(receipt.localOutput === undefined ? [] : [receipt.localOutput]),
    "",
  ].join("\n");
