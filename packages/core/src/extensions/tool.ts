import type { JsonObject, JsonValue } from "@ziggy/protocol";

export interface ExtensionToolContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
}

export interface ExtensionToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  execute(input: JsonObject, context: ExtensionToolContext): JsonValue | PromiseLike<JsonValue>;
}

/** The complete in-process Extension ABI. Runtime loading still validates this value. */
export function defineTool(definition: ExtensionToolDefinition): ExtensionToolDefinition {
  return Object.freeze(definition);
}
