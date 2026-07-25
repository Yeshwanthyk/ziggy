import { Effect, Schema } from "effect";

const AutomationIdSchema = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9-]+$/.test(value) && value.length <= 80, {
    expected: "1-80 lowercase kebab-case characters from [a-z0-9-]",
  }),
);

const TelegramChatId = Schema.Number.check(
  Schema.makeFilter(Number.isSafeInteger, { expected: "a safe integer Telegram chat ID" }),
);

const AutomationFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  gate: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  "telegram-chat": Schema.optional(TelegramChatId),
  prompt: Schema.String.check(Schema.isMinLength(1)),
});

const decodeAutomationId = Schema.decodeUnknownEffect(AutomationIdSchema);
const decodeAutomationFile = Schema.decodeUnknownEffect(AutomationFileSchema, {
  onExcessProperty: "error",
});

export type AutomationId = typeof AutomationIdSchema.Type;

export interface Automation {
  readonly id: AutomationId;
  readonly version: 1;
  readonly gate?: string | undefined;
  readonly telegramChat?: number | undefined;
  readonly prompt: string;
}

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

export class AutomationFileSystemError extends Schema.TaggedErrorClass<AutomationFileSystemError>()(
  "AutomationFileSystemError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const invalid = (path: string, message: string, cause: unknown = new Error(message)) =>
  new AutomationInvalid({ path, message, cause });

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

    return {
      id,
      version: decoded.version,
      prompt: decoded.prompt,
      ...(decoded.gate === undefined ? {} : { gate: decoded.gate }),
      ...(decoded["telegram-chat"] === undefined ? {} : { telegramChat: decoded["telegram-chat"] }),
    };
  });
