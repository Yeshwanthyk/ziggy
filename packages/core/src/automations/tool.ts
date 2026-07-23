import type { JsonObject, JsonValue } from "@ziggy/protocol";
import { Effect, Schema } from "effect";
import type { SessionTool } from "../agent/runtime.ts";
import type { AutomationAuthoringService, AutomationObservation } from "./authoring.ts";

const NonEmptyStringSchema = Schema.String.check(Schema.isNonEmpty());
const RevisionSchema = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/));
const AutomationToolInputSchema = Schema.Struct({
  action: Schema.Literals(["list", "inspect", "create", "update", "delete"]),
  id: Schema.optional(NonEmptyStringSchema),
  content: Schema.optional(NonEmptyStringSchema),
  expectedRevision: Schema.optional(RevisionSchema),
});
const decodeInputFields = Schema.decodeUnknownEffect(AutomationToolInputSchema, {
  errors: "all",
  onExcessProperty: "error",
});

type AutomationToolInput =
  | { readonly action: "list" }
  | { readonly action: "inspect"; readonly id: string }
  | { readonly action: "create"; readonly id: string; readonly content: string }
  | {
      readonly action: "update";
      readonly id: string;
      readonly content: string;
      readonly expectedRevision: string;
    }
  | { readonly action: "delete"; readonly id: string; readonly expectedRevision: string };

class AutomationToolInputError extends Schema.TaggedErrorClass<AutomationToolInputError>()(
  "AutomationToolInputError",
  { message: Schema.String },
) {}

export function createAutomationAuthoringTool(service: AutomationAuthoringService): SessionTool {
  return {
    name: "automations",
    description:
      "List, inspect, create, update, or delete validated Automation definitions. Updates and deletes require the revision returned by inspect or list.",
    inputSchema: automationToolJsonSchema(),
    execute({ input }) {
      return decodeAutomationToolInput(input).pipe(
        Effect.flatMap((request) => {
          switch (request.action) {
            case "list":
              return service
                .list()
                .pipe(Effect.map((observations) => observations.map(observationJson)));
            case "inspect":
              return service.inspect(request.id).pipe(Effect.map(observationJson));
            case "create":
              return service.create(request).pipe(Effect.map(observationJson));
            case "update":
              return service.update(request).pipe(Effect.map(observationJson));
            case "delete":
              return service.delete(request).pipe(Effect.as({ deleted: true }));
          }
        }),
        Effect.map((result) => ({ success: true, result })),
        Effect.catch((error) => Effect.succeed({ success: false, error: error.message })),
      );
    },
  };
}

function automationToolJsonSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["list", "inspect", "create", "update", "delete"] },
      id: { type: "string", minLength: 1 },
      content: { type: "string", minLength: 1 },
      expectedRevision: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
    },
  };
}

function decodeAutomationToolInput(
  value: unknown,
): Effect.Effect<AutomationToolInput, AutomationToolInputError | Schema.SchemaError> {
  return Effect.gen(function* () {
    const input = yield* decodeInputFields(value);
    return yield* validateInputFields(input);
  });
}

function validateInputFields(input: typeof AutomationToolInputSchema.Type) {
  switch (input.action) {
    case "list": {
      if (
        input.id === undefined &&
        input.content === undefined &&
        input.expectedRevision === undefined
      ) {
        const request: AutomationToolInput = { action: input.action };
        return Effect.succeed(request);
      }
      break;
    }
    case "inspect": {
      if (
        input.id !== undefined &&
        input.content === undefined &&
        input.expectedRevision === undefined
      ) {
        const request: AutomationToolInput = { action: input.action, id: input.id };
        return Effect.succeed(request);
      }
      break;
    }
    case "create": {
      if (
        input.id !== undefined &&
        input.content !== undefined &&
        input.expectedRevision === undefined
      ) {
        const request: AutomationToolInput = {
          action: input.action,
          id: input.id,
          content: input.content,
        };
        return Effect.succeed(request);
      }
      break;
    }
    case "update": {
      if (
        input.id !== undefined &&
        input.content !== undefined &&
        input.expectedRevision !== undefined
      ) {
        const request: AutomationToolInput = {
          action: input.action,
          id: input.id,
          content: input.content,
          expectedRevision: input.expectedRevision.toLowerCase(),
        };
        return Effect.succeed(request);
      }
      break;
    }
    case "delete": {
      if (
        input.id !== undefined &&
        input.content === undefined &&
        input.expectedRevision !== undefined
      ) {
        const request: AutomationToolInput = {
          action: input.action,
          id: input.id,
          expectedRevision: input.expectedRevision.toLowerCase(),
        };
        return Effect.succeed(request);
      }
      break;
    }
  }
  return Effect.fail(
    new AutomationToolInputError({
      message: `Invalid fields for Automation action ${input.action}`,
    }),
  );
}

function observationJson(observation: AutomationObservation): JsonValue {
  const trigger: JsonObject =
    "schedule" in observation.definition.trigger
      ? { schedule: observation.definition.trigger.schedule }
      : {
          webhook: {
            name: observation.definition.trigger.webhook.name,
            token: observation.definition.trigger.webhook.token,
          },
        };
  return {
    id: observation.definition.id,
    version: observation.definition.version,
    type: observation.definition.type,
    trigger,
    body: observation.definition.body,
    content: observation.content,
    revision: observation.revision,
  };
}
