import { Effect, Schema } from "effect";
import {
  parseAutomationScheduleFields,
  renderAutomationScheduleFields,
  validateAutomationSchedule,
} from "./automation-schedule";

const AutomationIdSchema = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9-]+$/.test(value) && value.length <= 80, {
    expected: "1-80 lowercase kebab-case characters from [a-z0-9-]",
  }),
);

const AutomationNameSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length >= 1 &&
      value.length <= 120 &&
      value === value.trim() &&
      !value.includes("\n") &&
      !value.includes("\r"),
    {
      expected: "1-120 trimmed characters on one line",
    },
  ),
);

const AutomationPromptSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64 * 1024),
);

const FrontmatterLineSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length >= 1 &&
      value === value.trim() &&
      !value.includes("\n") &&
      !value.includes("\r"),
    { expected: "a non-empty trimmed frontmatter line" },
  ),
);

const TelegramChatIdSchema = Schema.Finite.check(
  Schema.makeFilter(Number.isSafeInteger, { expected: "a safe integer Telegram chat ID" }),
);

const ChannelIdSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length >= 1 &&
      value.length <= 128 &&
      value === value.trim() &&
      !value.includes("\n") &&
      !value.includes("\r"),
    { expected: "a non-empty trimmed channel ID" },
  ),
);

const AutomationScheduleSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cron"),
    expression: FrontmatterLineSchema,
    timezone: FrontmatterLineSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("at"),
    instant: FrontmatterLineSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("every"),
    seconds: Schema.Finite.check(
      Schema.makeFilter(
        (value) => Number.isSafeInteger(value) && value > 0,
        { expected: "a positive safe integer number of seconds" },
      ),
    ),
  }),
]);

const AutomationFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.optional(AutomationNameSchema),
  enabled: Schema.optional(Schema.Boolean),
  gate: Schema.optional(FrontmatterLineSchema),
  "telegram-chat": Schema.optional(TelegramChatIdSchema),
  "discord-channel": Schema.optional(ChannelIdSchema),
  "slack-channel": Schema.optional(ChannelIdSchema),
  schedule: Schema.optional(FrontmatterLineSchema),
  timezone: Schema.optional(FrontmatterLineSchema),
  prompt: AutomationPromptSchema,
});

export const AutomationWriteInputSchema = Schema.Struct({
  id: AutomationIdSchema,
  name: AutomationNameSchema,
  enabled: Schema.Boolean,
  gate: Schema.optional(FrontmatterLineSchema),
  telegramChat: Schema.optional(TelegramChatIdSchema),
  discordChannel: Schema.optional(ChannelIdSchema),
  slackChannel: Schema.optional(ChannelIdSchema),
  schedule: Schema.optional(AutomationScheduleSchema),
  prompt: AutomationPromptSchema,
});

const decodeAutomationId = Schema.decodeUnknownEffect(AutomationIdSchema);
const decodeAutomationFile = Schema.decodeUnknownEffect(AutomationFileSchema, {
  onExcessProperty: "error",
});
const decodeAutomationWriteInputJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AutomationWriteInputSchema),
  { onExcessProperty: "error" },
);

export type AutomationId = typeof AutomationIdSchema.Type;
export type AutomationWriteInput = typeof AutomationWriteInputSchema.Type;

export const AutomationSchema = Schema.Struct({
  ...AutomationWriteInputSchema.fields,
  version: Schema.Literal(1),
});

export type Automation = typeof AutomationSchema.Type;

export class AutomationInvalid extends Schema.TaggedErrorClass<AutomationInvalid>()(
  "AutomationInvalid",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class AutomationNotFound extends Schema.TaggedErrorClass<AutomationNotFound>()(
  "AutomationNotFound",
  {
    id: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class AutomationExists extends Schema.TaggedErrorClass<AutomationExists>()(
  "AutomationExists",
  {
    id: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class AutomationFileSystemError extends Schema.TaggedErrorClass<AutomationFileSystemError>()(
  "AutomationFileSystemError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

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

export const defaultAutomationName = (id: AutomationId): string =>
  id
    .split("-")
    .filter((part) => part.length > 0)
    .map((part, index) =>
      index === 0 ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part,
    )
    .join(" ");

export const parseAutomationWriteInputJson = (
  source: string,
): Effect.Effect<AutomationWriteInput, AutomationInvalid> =>
  decodeAutomationWriteInputJson(source).pipe(
    Effect.mapError((cause) =>
      invalid(
        "automation input",
        "invalid automation input: expected id, name, enabled, prompt, and optional gate or telegramChat",
        cause,
      ),
    ),
  );

export const parseAutomationFile = (
  id: AutomationId,
  filePath: string,
  source: string,
): Effect.Effect<Automation, AutomationInvalid> =>
  Effect.gen(function* () {
    const lines = source.replaceAll("\r\n", "\n").split("\n");
    if (lines[0] !== "---") {
      return yield* invalid(filePath, `invalid automation ${id}: frontmatter must start with ---`);
    }

    const closingDelimiter = lines.indexOf("---", 1);
    if (closingDelimiter === -1) {
      return yield* invalid(filePath, `invalid automation ${id}: frontmatter must end with ---`);
    }

    const entries: Array<readonly [string, unknown]> = [];
    const keys = new Set<string>();
    for (const line of lines.slice(1, closingDelimiter)) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        return yield* invalid(
          filePath,
          `invalid automation ${id}: expected one key: value per line`,
        );
      }

      const key = line.slice(0, separator);
      const value = line.slice(separator + 1).trim();
      if (key !== key.trim() || keys.has(key)) {
        return yield* invalid(
          filePath,
          `invalid automation ${id}: invalid or duplicate key ${key.trim()}`,
        );
      }
      keys.add(key);

      if (key === "version") {
        entries.push([key, value === "1" ? 1 : value]);
      } else if (key === "enabled") {
        entries.push([key, value === "true" ? true : value === "false" ? false : value]);
      } else if (key === "telegram-chat") {
        entries.push([key, /^-?\d+$/.test(value) ? Number(value) : value]);
      } else {
        entries.push([key, value]);
      }
    }

    const prompt = lines
      .slice(closingDelimiter + 1)
      .join("\n")
      .trim();
    const decoded = yield* decodeAutomationFile(
      Object.fromEntries([...entries, ["prompt", prompt]]),
    ).pipe(
      Effect.mapError((cause) =>
        invalid(filePath, `invalid automation ${id}: frontmatter or body failed validation`, cause),
      ),
    );
    const schedule = yield* parseAutomationScheduleFields({
      ...(decoded.schedule === undefined ? {} : { schedule: decoded.schedule }),
      ...(decoded.timezone === undefined ? {} : { timezone: decoded.timezone }),
    }).pipe(
      Effect.mapError((cause) =>
        invalid(filePath, `invalid automation ${id}: schedule failed validation`, cause),
      ),
    );

    return {
      id,
      version: decoded.version,
      name: decoded.name ?? defaultAutomationName(id),
      enabled: decoded.enabled ?? true,
      prompt: decoded.prompt,
      ...(decoded.gate === undefined ? {} : { gate: decoded.gate }),
      ...(decoded["telegram-chat"] === undefined ? {} : { telegramChat: decoded["telegram-chat"] }),
      ...(decoded["discord-channel"] === undefined
        ? {}
        : { discordChannel: decoded["discord-channel"] }),
      ...(decoded["slack-channel"] === undefined
        ? {}
        : { slackChannel: decoded["slack-channel"] }),
      ...(schedule === undefined ? {} : { schedule }),
    };
  });

export const renderAutomationFile = (automation: Automation): string =>
  [
    "---",
    `version: ${automation.version}`,
    `name: ${automation.name}`,
    `enabled: ${automation.enabled ? "true" : "false"}`,
    ...(automation.gate === undefined ? [] : [`gate: ${automation.gate}`]),
    ...(automation.telegramChat === undefined
      ? []
      : [`telegram-chat: ${automation.telegramChat}`]),
    ...(automation.discordChannel === undefined
      ? []
      : [`discord-channel: ${automation.discordChannel}`]),
    ...(automation.slackChannel === undefined ? [] : [`slack-channel: ${automation.slackChannel}`]),
    ...(automation.schedule === undefined ? [] : renderAutomationScheduleFields(automation.schedule)),
    "---",
    "",
    automation.prompt.trim(),
    "",
  ].join("\n");

export const validateAutomationWriteInput = (
  input: AutomationWriteInput,
): Effect.Effect<AutomationWriteInput, AutomationInvalid> =>
  input.schedule === undefined
    ? Effect.succeed(input)
    : validateAutomationSchedule(input.schedule).pipe(
        Effect.map((schedule) => ({ ...input, schedule })),
        Effect.mapError((cause) =>
          invalid("automation input", "invalid automation schedule", cause),
        ),
      );
