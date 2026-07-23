import type { JsonObject, JsonValue } from "@ziggy/protocol";
import { Effect, Schema } from "effect";
import type { SessionTool } from "../agent/runtime.ts";
import type { AutomationAuthoringService, AutomationObservation } from "./authoring.ts";

const AutomationToolInputSchema = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literal("inspect"), id: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("create"),
    id: Schema.String,
    content: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    id: Schema.String,
    content: Schema.String,
    expectedRevision: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("delete"),
    id: Schema.String,
    expectedRevision: Schema.String,
  }),
]);
const decodeInput = Schema.decodeUnknownEffect(AutomationToolInputSchema, {
  errors: "all",
  onExcessProperty: "error",
});

export function createAutomationAuthoringTool(service: AutomationAuthoringService): SessionTool {
  return {
    name: "automations",
    description:
      "List, inspect, create, update, or delete validated Automation definitions. Updates and deletes require the revision returned by inspect or list.",
    inputSchema: automationToolJsonSchema(),
    execute({ input }) {
      return decodeInput(input).pipe(
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
  const id = { type: "string", minLength: 1 };
  const content = { type: "string", minLength: 1 };
  const expectedRevision = { type: "string", pattern: "^[a-f0-9]{64}$" };
  return {
    oneOf: [
      objectSchema(["action"], { action: { const: "list" } }),
      objectSchema(["action", "id"], { action: { const: "inspect" }, id }),
      objectSchema(["action", "id", "content"], {
        action: { const: "create" },
        id,
        content,
      }),
      objectSchema(["action", "id", "content", "expectedRevision"], {
        action: { const: "update" },
        id,
        content,
        expectedRevision,
      }),
      objectSchema(["action", "id", "expectedRevision"], {
        action: { const: "delete" },
        id,
        expectedRevision,
      }),
    ],
  };
}

function objectSchema(required: ReadonlyArray<string>, properties: JsonObject): JsonObject {
  return { type: "object", additionalProperties: false, required, properties };
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
