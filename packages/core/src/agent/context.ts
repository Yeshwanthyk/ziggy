import type {
  AssistantMessage,
  Context,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  FinalModelResponse,
  JsonObject,
  JsonValue,
  ModelContent,
  SessionEnvelope,
} from "@ziggy/protocol";
import { Result, Schema } from "effect";

export class SessionContextError extends Schema.TaggedErrorClass<SessionContextError>()(
  "SessionContextError",
  { message: Schema.String },
) {}

export function projectProviderContext(
  envelopes: ReadonlyArray<SessionEnvelope>,
): Result.Result<Context, SessionContextError> {
  const started = envelopes.find((envelope) => envelope.event.type === "session-started");
  if (started === undefined || started.event.type !== "session-started") {
    return Result.fail(
      new SessionContextError({ message: "Session log has no session-started event" }),
    );
  }
  const messages: Context["messages"] = [];
  const toolNames = new Map<string, string>();
  const pendingSteers = new Map<string, UserMessage[]>();
  const completedSteps = new Set(
    envelopes
      .filter(
        (envelope) => envelope.event.type === "step-ended" && envelope.event.status === "completed",
      )
      .map((envelope) =>
        envelope.event.type === "step-ended"
          ? stepKey(envelope.event.turnId, envelope.event.stepId)
          : "",
      ),
  );

  for (const envelope of envelopes) {
    const event = envelope.event;
    if (event.type === "turn-started") {
      messages.push({
        role: "user",
        content: event.message,
        timestamp: Date.parse(envelope.emittedAt),
      });
    } else if (event.type === "steer-received") {
      const turnSteers = pendingSteers.get(event.turnId) ?? [];
      turnSteers.push({
        role: "user",
        content: event.message,
        timestamp: Date.parse(envelope.emittedAt),
      });
      pendingSteers.set(event.turnId, turnSteers);
    } else if (event.type === "step-started") {
      const turnSteers = pendingSteers.get(event.turnId);
      if (turnSteers !== undefined) {
        messages.push(...turnSteers);
        pendingSteers.delete(event.turnId);
      }
    } else if (
      event.type === "model-response" &&
      completedSteps.has(stepKey(event.turnId, event.stepId))
    ) {
      messages.push(toAssistantMessage(event.response));
    } else if (
      event.type === "tool-call" &&
      completedSteps.has(stepKey(event.turnId, event.stepId))
    ) {
      toolNames.set(event.toolCallId, event.toolName);
    } else if (
      event.type === "tool-result" &&
      completedSteps.has(stepKey(event.turnId, event.stepId))
    ) {
      const toolName = toolNames.get(event.toolCallId);
      if (toolName === undefined) {
        return Result.fail(
          new SessionContextError({
            message: `Tool result ${event.toolCallId} has no durable tool call`,
          }),
        );
      }
      const result: ToolResultMessage<undefined> = {
        role: "toolResult",
        toolCallId: event.toolCallId,
        toolName,
        content: [{ type: "text", text: jsonText(event.output) }],
        isError: event.isError,
        timestamp: Date.parse(envelope.emittedAt),
      };
      messages.push(result);
    }
  }

  return Result.succeed({
    systemPrompt: started.event.snapshot.systemPrompt,
    messages,
    tools: started.event.snapshot.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  });
}

export function toFinalModelResponse(
  message: AssistantMessage,
): Result.Result<FinalModelResponse, SessionContextError> {
  return Result.map(Result.all(message.content.map(toModelContent)), (content) => ({
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    content,
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      ...(message.usage.cacheWrite1h === undefined
        ? {}
        : { cacheWrite1h: message.usage.cacheWrite1h }),
      ...(message.usage.reasoning === undefined ? {} : { reasoning: message.usage.reasoning }),
      totalTokens: message.usage.totalTokens,
    },
    stopReason: message.stopReason,
    ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
    timestamp: message.timestamp,
  }));
}

function toModelContent(
  content: AssistantMessage["content"][number],
): Result.Result<ModelContent, SessionContextError> {
  if (content.type === "text") {
    return Result.succeed({
      type: "text",
      text: content.text,
      ...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
    });
  }
  if (content.type === "thinking") {
    return Result.succeed({
      type: "thinking",
      thinking: content.thinking,
      ...(content.thinkingSignature === undefined
        ? {}
        : { thinkingSignature: content.thinkingSignature }),
      ...(content.redacted === undefined ? {} : { redacted: content.redacted }),
    });
  }
  return Result.map(requireJsonObject(content.arguments), (arguments_) => ({
    type: "toolCall",
    id: content.id,
    name: content.name,
    arguments: arguments_,
    ...(content.thoughtSignature === undefined
      ? {}
      : { thoughtSignature: content.thoughtSignature }),
  }));
}

function toAssistantMessage(response: FinalModelResponse): AssistantMessage {
  return {
    role: "assistant",
    api: response.api,
    provider: response.provider,
    model: response.model,
    ...(response.responseModel === undefined ? {} : { responseModel: response.responseModel }),
    ...(response.responseId === undefined ? {} : { responseId: response.responseId }),
    content: response.content.map((content) => {
      if (content.type === "text") {
        return {
          type: "text",
          text: content.text,
          ...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
        };
      }
      if (content.type === "thinking") {
        return {
          type: "thinking",
          thinking: content.thinking,
          ...(content.thinkingSignature === undefined
            ? {}
            : { thinkingSignature: content.thinkingSignature }),
          ...(content.redacted === undefined ? {} : { redacted: content.redacted }),
        };
      }
      return {
        type: "toolCall",
        id: content.id,
        name: content.name,
        arguments: content.arguments,
        ...(content.thoughtSignature === undefined
          ? {}
          : { thoughtSignature: content.thoughtSignature }),
      };
    }),
    usage: {
      ...response.usage,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: response.stopReason,
    ...(response.errorMessage === undefined ? {} : { errorMessage: response.errorMessage }),
    timestamp: response.timestamp,
  };
}

function requireJsonObject(value: unknown): Result.Result<JsonObject, SessionContextError> {
  return Result.flatMap(requireJsonValue(value), (json) =>
    typeof json !== "object" || json === null || isJsonArray(json)
      ? Result.fail(
          new SessionContextError({
            message: "Provider tool arguments must be a JSON object",
          }),
        )
      : Result.succeed(json),
  );
}

function requireJsonValue(value: unknown): Result.Result<JsonValue, SessionContextError> {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return Result.succeed(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return Result.fail(new SessionContextError({ message: "JSON numbers must be finite" }));
    }
    return Result.succeed(value);
  }
  if (Array.isArray(value)) {
    return Result.all(value.map(requireJsonValue));
  }
  if (typeof value === "object") {
    return Result.map(
      Result.all(
        Object.entries(value).map(([key, child]) =>
          Result.map(
            requireJsonValue(child),
            (decoded) => [key, decoded] satisfies readonly [string, JsonValue],
          ),
        ),
      ),
      (entries) => Object.fromEntries(entries),
    );
  }
  return Result.fail(new SessionContextError({ message: "Value is not JSON serializable" }));
}

function isJsonArray(value: JsonValue): value is ReadonlyArray<JsonValue> {
  return Array.isArray(value);
}

function stepKey(turnId: string, stepId: string): string {
  return `${turnId}\u0000${stepId}`;
}

function jsonText(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
