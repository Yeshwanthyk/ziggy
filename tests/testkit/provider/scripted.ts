import {
  createAssistantMessageEventStream,
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
  type ToolCall,
} from "../../../packages/core/node_modules/@earendil-works/pi-ai";
import { Barrier } from "../barrier.ts";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface ProviderCall {
  readonly model: Model<string>;
  readonly context: Context;
  readonly options: {
    readonly sessionId: string | undefined;
    readonly cacheRetention: "none" | "short" | "long" | undefined;
  };
}

export type ScriptedStep =
  | {
      readonly kind: "events";
      readonly events: ReadonlyArray<AssistantMessageEvent>;
      readonly result: AssistantMessage;
      readonly barrier?: Barrier;
      readonly eventBarriers?: ReadonlyMap<number, Barrier>;
      readonly omitTerminal?: boolean;
    }
  | { readonly kind: "throw"; readonly error: Error }
  | {
      readonly kind: "iterator-throw";
      readonly events: ReadonlyArray<AssistantMessageEvent>;
      readonly result: AssistantMessage;
      readonly error: Error;
    }
  | { readonly kind: "await-abort"; readonly partial: AssistantMessage };

export class ScriptedProvider {
  readonly calls: ProviderCall[] = [];
  readonly model: Model<string> = {
    id: "scripted-model",
    name: "Scripted Model",
    api: "scripted",
    provider: "scripted",
    baseUrl: "http://localhost:0",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };

  private readonly steps: ScriptedStep[];
  private readonly callWaiters: Array<{
    readonly count: number;
    readonly completion: PromiseWithResolvers<void>;
  }> = [];

  constructor(steps: ReadonlyArray<ScriptedStep>) {
    this.steps = [...steps];
  }

  readonly streamSimple: StreamFunction<string, SimpleStreamOptions> = (
    model,
    context,
    options,
  ) => {
    this.calls.push({
      model: structuredClone(model),
      context: structuredClone(context),
      options: {
        sessionId: options?.sessionId,
        cacheRetention: options?.cacheRetention,
      },
    });
    this.resolveCallWaiters();

    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("Scripted Provider exhausted");
    }
    if (step.kind === "throw") {
      throw step.error;
    }
    if (step.kind === "iterator-throw") {
      return new ThrowingIteratorStream(step.events, step.result, step.error);
    }

    const stream = createAssistantMessageEventStream();
    if (step.kind === "await-abort") {
      stream.push({ type: "start", partial: step.partial });
      const abort = (): void => {
        const error = abortedMessage(step.partial);
        stream.push({ type: "error", reason: "aborted", error });
        stream.end(error);
      };
      if (options?.signal?.aborted === true) {
        abort();
      } else {
        options?.signal?.addEventListener("abort", abort, { once: true });
      }
      return stream;
    }

    const produce = async (): Promise<void> => {
      await step.barrier?.wait();
      const events = step.omitTerminal
        ? step.events.filter((event) => event.type !== "done" && event.type !== "error")
        : step.events;
      for (const [index, event] of events.entries()) {
        await step.eventBarriers?.get(index)?.wait();
        stream.push(event);
      }
      stream.end(step.result);
    };
    void produce();
    return stream;
  };

  waitForCalls(count: number): Promise<void> {
    if (this.calls.length >= count) {
      return Promise.resolve();
    }
    const completion = Promise.withResolvers<void>();
    this.callWaiters.push({ count, completion });
    return completion.promise;
  }

  pendingSteps(): number {
    return this.steps.length;
  }

  private resolveCallWaiters(): void {
    for (const waiter of this.callWaiters) {
      if (this.calls.length >= waiter.count) {
        waiter.completion.resolve();
      }
    }
  }
}

class ThrowingIteratorStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor(
    private readonly events: ReadonlyArray<AssistantMessageEvent>,
    result: AssistantMessage,
    private readonly failure: Error,
  ) {
    super((event) => event.type === "done" || event.type === "error", terminalMessage);
    this.end(result);
  }

  override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    for (const event of this.events) {
      yield event;
    }
    throw this.failure;
  }
}

export function textStep(text: string, timestamp: number): ScriptedStep {
  const partial = assistantMessage([], "stop", timestamp);
  const started = assistantMessage([{ type: "text", text: "" }], "stop", timestamp);
  const message = assistantMessage([{ type: "text", text }], "stop", timestamp);
  return {
    kind: "events",
    result: message,
    events: [
      { type: "start", partial },
      { type: "text_start", contentIndex: 0, partial: started },
      { type: "text_delta", contentIndex: 0, delta: text, partial: message },
      { type: "text_end", contentIndex: 0, content: text, partial: message },
      { type: "done", reason: "stop", message },
    ],
  };
}

export function toolStep(
  calls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }>,
  timestamp: number,
): ScriptedStep {
  const toolCalls: ToolCall[] = calls.map((call) => ({
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: { ...call.arguments },
  }));
  const partial = assistantMessage([], "toolUse", timestamp);
  const message = assistantMessage(toolCalls, "toolUse", timestamp);
  const events: AssistantMessageEvent[] = [{ type: "start", partial }];
  for (const [contentIndex, toolCall] of toolCalls.entries()) {
    events.push(
      { type: "toolcall_start", contentIndex, partial: message },
      { type: "toolcall_end", contentIndex, toolCall, partial: message },
    );
  }
  events.push({ type: "done", reason: "toolUse", message });
  return { kind: "events", events, result: message };
}

export function continuityStep(timestamp: number): ScriptedStep {
  const partial = assistantMessage([], "stop", timestamp);
  const message: AssistantMessage = {
    ...assistantMessage(
      [
        { type: "thinking", thinking: "opaque", thinkingSignature: "thinking-sig", redacted: true },
        { type: "text", text: "answer", textSignature: "text-sig" },
      ],
      "stop",
      timestamp,
    ),
    responseModel: "scripted-model-2026",
    responseId: "response-1",
    usage: { ...EMPTY_USAGE, cacheWrite1h: 3, reasoning: 7 },
  };
  return {
    kind: "events",
    result: message,
    events: [
      { type: "start", partial },
      { type: "done", reason: "stop", message },
    ],
  };
}

export function errorStep(text: string, timestamp: number): ScriptedStep {
  const partial = assistantMessage([], "stop", timestamp);
  const message = {
    ...assistantMessage([{ type: "text", text }], "error", timestamp),
    errorMessage: "scripted failure",
  };
  return {
    kind: "events",
    result: message,
    events: [
      { type: "start", partial },
      { type: "text_delta", contentIndex: 0, delta: text, partial: message },
      { type: "error", reason: "error", error: message },
    ],
  };
}

export function terminalDefectStep(
  kind: "missing-terminal" | "iterator-throw",
  timestamp: number,
): ScriptedStep {
  const partial = assistantMessage([], "stop", timestamp);
  const message = assistantMessage([{ type: "text", text: "partial" }], "stop", timestamp);
  const events: ReadonlyArray<AssistantMessageEvent> = [
    { type: "start", partial },
    { type: "text_delta", contentIndex: 0, delta: "partial", partial: message },
  ];
  return kind === "missing-terminal"
    ? { kind: "events", events, result: message, omitTerminal: true }
    : { kind: "iterator-throw", events, result: message, error: new Error("iterator exploded") };
}

export function awaitingAbortStep(timestamp: number): ScriptedStep {
  return { kind: "await-abort", partial: assistantMessage([], "stop", timestamp) };
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  timestamp: number,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "scripted",
    provider: "scripted",
    model: "scripted-model",
    usage: EMPTY_USAGE,
    stopReason,
    timestamp,
  };
}

function terminalMessage(event: AssistantMessageEvent): AssistantMessage {
  if (event.type === "done") {
    return event.message;
  }
  if (event.type === "error") {
    return event.error;
  }
  throw new Error("Expected a terminal Assistant message event");
}

function abortedMessage(partial: AssistantMessage): AssistantMessage {
  return {
    ...partial,
    stopReason: "aborted",
    errorMessage: "Request was aborted",
  };
}
