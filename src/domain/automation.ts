import { Cron, DateTime, Effect, Option, Result, Schema } from "effect";

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

export const Automation = Schema.Struct({
  id: AutomationIdSchema,
  version: Schema.Literal(1),
  schedule: Schema.Struct({ cronSource: NonEmpty, timezone: NonEmpty, cron: CronValue }),
  gate: Schema.optional(NonEmpty),
  broadcast: Schema.Array(Schema.Union([Schema.Literals(["origin", "all"]), AutomationTarget])),
  origin: Schema.optional(AutomationTarget),
  prompt: NonEmpty,
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
  const slack = /^slack:channel:([CDG][A-Z0-9]{8,})(?::thread:([1-9][0-9]*\.[0-9]{6}))?$/.exec(source);
  return slack?.[1] === undefined
    ? undefined
    : {
        _tag: "slack",
        target: source,
        channelId: slack[1],
        ...(slack[2] === undefined ? {} : { threadTs: slack[2] }),
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

export type AutomationResolutionCategory =
  | "broadcasts-unreadable"
  | "broadcasts-invalid"
  | "all-empty";
export type AutomationDeliveryFailureCategory =
  | "configuration"
  | "authentication"
  | "rate-limited"
  | "transport"
  | "remote"
  | "invalid-response";
export type AutomationTargetOutcome =
  | { readonly target: string; readonly status: "delivered" }
  | {
      readonly target: string;
      readonly status: "failed";
      readonly category: AutomationDeliveryFailureCategory;
      readonly retriable: boolean;
    };
export type AutomationRunOutcome =
  | { readonly kind: "declined"; readonly reason: "gate-nonzero"; readonly exitCode: number }
  | {
      readonly kind: "executed";
      readonly delivery:
        | { readonly kind: "resolved"; readonly targets: ReadonlyArray<AutomationTargetOutcome> }
        | { readonly kind: "resolution-failed"; readonly category: AutomationResolutionCategory };
    };

const invalid = (path: string, message: string, cause?: unknown) =>
  new AutomationInvalid({ path, message, cause: cause ?? message });

export const validateAutomationId = (id: string): Effect.Effect<AutomationId, AutomationInvalid> =>
  decodeAutomationId(id).pipe(
    Effect.mapError((cause) =>
      invalid(id, `invalid automation id ${id}: use 1-80 lowercase kebab-case characters from [a-z0-9-]`, cause),
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
        return yield* invalid(path, `invalid automation ${id}: none must be the whole broadcast value`);
      }
      tokens.push(token === "origin" || token === "all" ? token : yield* parseAutomationTarget(id, path, token));
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
    if (lines[0] !== "---") return yield* invalid(filePath, `invalid automation ${id}: frontmatter must start with ---`);
    const end = lines.indexOf("---", 1);
    if (end === -1) return yield* invalid(filePath, `invalid automation ${id}: frontmatter must end with ---`);

    const entries: Array<readonly [string, unknown]> = [];
    const keys = new Set<string>();
    for (const line of lines.slice(1, end)) {
      const separator = line.indexOf(":");
      if (separator <= 0) return yield* invalid(filePath, `invalid automation ${id}: expected one key: value per line`);
      const key = line.slice(0, separator);
      const rawValue = line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (key !== key.trim() || keys.has(key)) return yield* invalid(filePath, `invalid automation ${id}: invalid or duplicate key ${key.trim()}`);
      if (key === "telegram-chat") return yield* invalid(filePath, `invalid automation ${id}: telegram-chat is no longer supported; use broadcast: telegram:chat:<chat-id>`);
      if (key === "prompt") return yield* invalid(filePath, `invalid automation ${id}: prompt belongs in the Markdown body`);
      keys.add(key);
      entries.push([key, key === "version" && value.trim() === "1" ? 1 : value]);
    }
    const prompt = lines.slice(end + 1).join("\n").trim();
    const decoded = yield* decodeAutomationFile(Object.fromEntries([...entries, ["prompt", prompt]])).pipe(
      Effect.mapError((cause) => invalid(filePath, `invalid automation ${id}: frontmatter or body failed validation`, cause)),
    );
    if ([decoded.cron, decoded.timezone, decoded.broadcast, decoded.gate, decoded.origin].some((value) => value !== undefined && value !== value.trim())) {
      return yield* invalid(filePath, `invalid automation ${id}: frontmatter values must not have leading or trailing whitespace`);
    }
    if (/^[+-]\d{2}:\d{2}$/.test(decoded.timezone) || Option.isNone(DateTime.zoneMakeNamed(decoded.timezone))) {
      return yield* invalid(filePath, `invalid automation ${id}: timezone must be a named IANA timezone`);
    }
    const cron = Cron.parse(decoded.cron, decoded.timezone);
    if (Result.isFailure(cron)) return yield* invalid(filePath, `invalid automation ${id}: invalid cron`, cron.failure);
    const broadcast = yield* parseBroadcast(id, filePath, decoded.broadcast);
    const origin = decoded.origin === undefined ? undefined : yield* parseAutomationTarget(id, filePath, decoded.origin);
    if (broadcast.includes("origin") && origin === undefined) return yield* invalid(filePath, `invalid automation ${id}: broadcast origin requires an origin field`);
    return {
      id, version: 1, schedule: { cronSource: decoded.cron, timezone: decoded.timezone, cron: cron.success },
      broadcast, prompt: decoded.prompt,
      ...(decoded.gate === undefined ? {} : { gate: decoded.gate }),
      ...(origin === undefined ? {} : { origin }),
    };
  });
