import { Cron, Effect, Result, Schema } from "effect";
import { parse as parseYamlDocument } from "yaml";

const AUTOMATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AutomationIdSchema = Schema.String.check(
  Schema.makeFilter(isAutomationId, {
    expected: "a lowercase Automation id using single hyphens between segments",
  }),
);
const NonEmptyStringSchema = Schema.String.check(Schema.isNonEmpty());
const ScheduleSchema = NonEmptyStringSchema.check(
  Schema.makeFilter(isValidCronSchedule, {
    expected: "a valid Effect cron schedule",
  }),
);
const TriggerSchema = Schema.Union([
  Schema.Struct({ schedule: ScheduleSchema }),
  Schema.Struct({
    webhook: Schema.Struct({
      name: AutomationIdSchema,
      token: NonEmptyStringSchema,
    }),
  }),
]);
const AutomationFrontmatterSchema = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literals(["prompt", "no_agent"]),
  trigger: TriggerSchema,
});
const VersionProbeSchema = Schema.Struct({ version: Schema.Unknown });
const decodeVersionProbe = Schema.decodeUnknownResult(VersionProbeSchema);
const decodeFrontmatter = Schema.decodeUnknownEffect(AutomationFrontmatterSchema, {
  errors: "all",
  onExcessProperty: "error",
});

export type AutomationFrontmatter = typeof AutomationFrontmatterSchema.Type;

export interface AutomationDefinition {
  readonly id: string;
  readonly version: 1;
  readonly type: "prompt" | "no_agent";
  readonly trigger: AutomationFrontmatter["trigger"];
  readonly body: string;
}

export type AutomationDefinitionErrorCode =
  | "invalid-id"
  | "invalid-markdown"
  | "invalid-frontmatter"
  | "unsupported-version";

export class AutomationDefinitionError extends Schema.TaggedErrorClass<AutomationDefinitionError>(
  "@ziggy/core/automations/AutomationDefinitionError",
)("AutomationDefinitionError", {
  code: Schema.Literals([
    "invalid-id",
    "invalid-markdown",
    "invalid-frontmatter",
    "unsupported-version",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export function isAutomationId(id: string): boolean {
  return id.length <= 80 && AUTOMATION_ID_PATTERN.test(id);
}

export function parseAutomationDefinition(
  id: string,
  content: string,
): Effect.Effect<AutomationDefinition, AutomationDefinitionError> {
  if (!isAutomationId(id)) {
    return Effect.fail(
      new AutomationDefinitionError({
        code: "invalid-id",
        message: `Invalid Automation id: ${id}`,
      }),
    );
  }
  const sections = splitMarkdown(content);
  if (Result.isFailure(sections)) return Effect.fail(sections.failure);
  const parsed = Effect.try({
    try: () => parseYaml(sections.success.frontmatter),
    catch: (cause) =>
      new AutomationDefinitionError({
        code: "invalid-frontmatter",
        message: `Automation ${id} frontmatter is not valid YAML`,
        cause,
      }),
  });
  return parsed.pipe(
    Effect.flatMap((value) => requireSupportedVersion(id, value).pipe(Effect.as(value))),
    Effect.flatMap((value) =>
      decodeFrontmatter(value).pipe(
        Effect.mapError(
          (cause) =>
            new AutomationDefinitionError({
              code: "invalid-frontmatter",
              message: `Automation ${id} frontmatter does not match version 1`,
              cause,
            }),
        ),
      ),
    ),
    Effect.map((frontmatter) => ({
      id,
      version: frontmatter.version,
      type: frontmatter.type,
      trigger: frontmatter.trigger,
      body: sections.success.body,
    })),
  );
}

function parseYaml(source: string): unknown {
  return parseYamlDocument(source, { strict: true, uniqueKeys: true });
}

function splitMarkdown(
  content: string,
): Result.Result<
  { readonly frontmatter: string; readonly body: string },
  AutomationDefinitionError
> {
  if (!content.startsWith("---\n")) return Result.fail(invalidMarkdown("must start with ---"));
  const closing = content.indexOf("\n---\n", 4);
  if (closing === -1) return Result.fail(invalidMarkdown("must close frontmatter with ---"));
  const body = content.slice(closing + 5);
  if (body.trim().length === 0) {
    return Result.fail(invalidMarkdown("must have a non-empty prompt or no_agent body"));
  }
  return Result.succeed({ frontmatter: content.slice(4, closing), body });
}

function requireSupportedVersion(
  id: string,
  value: unknown,
): Effect.Effect<void, AutomationDefinitionError> {
  const probe = decodeVersionProbe(value);
  if (Result.isFailure(probe)) {
    return Effect.fail(
      new AutomationDefinitionError({
        code: "invalid-frontmatter",
        message: `Automation ${id} frontmatter must declare version`,
        cause: probe.failure,
      }),
    );
  }
  if (probe.success.version !== 1) {
    return Effect.fail(
      new AutomationDefinitionError({
        code: "unsupported-version",
        message: `Automation ${id} uses unsupported version ${String(probe.success.version)}`,
      }),
    );
  }
  return Effect.void;
}

function invalidMarkdown(detail: string): AutomationDefinitionError {
  return new AutomationDefinitionError({
    code: "invalid-markdown",
    message: `Automation markdown ${detail}`,
  });
}

function isValidCronSchedule(schedule: string): boolean {
  return Result.isSuccess(Cron.parse(schedule));
}
