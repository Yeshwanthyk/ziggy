/**
 * A scripted model server: a local OpenAI chat-completions stream that a tmp Profile points at
 * through `models.json`. Each request takes the next scripted reply; when the script runs out it
 * answers "ok". Every request body is recorded so proofs can assert what the model was sent.
 */
import { Schema } from "effect";

export interface ToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, Schema.Json>>;
}

export type Reply =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Tools"; readonly calls: ReadonlyArray<ToolCall> }
  | { readonly _tag: "Fail"; readonly status: number; readonly message: string }
  /** Streams `first`, then waits for `release()` before finishing with `rest`. */
  | { readonly _tag: "Held"; readonly first: string; readonly rest: string; readonly gate: Gate };

export const text = (value: string): Reply => ({ _tag: "Text", text: value });

export const tools = (...calls: ReadonlyArray<ToolCall>): Reply => ({ _tag: "Tools", calls });

export const fail = (status: number, message: string): Reply => ({ _tag: "Fail", status, message });

export interface Gate {
  /** Resolves once the held reply has streamed its first chunk. */
  readonly started: Promise<void>;
  readonly release: () => void;
  readonly wait: Promise<void>;
  readonly markStarted: () => void;
}

export const gate = (): Gate => {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  return {
    started: started.promise,
    markStarted: () => started.resolve(),
    release: () => released.resolve(),
    wait: released.promise,
  };
};

export const held = (first: string, rest: string, on: Gate): Reply => ({
  _tag: "Held",
  first,
  rest,
  gate: on,
});

const RequestMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Json), Schema.Null])),
});

const RequestTool = Schema.Struct({
  function: Schema.Struct({ name: Schema.String }),
});

/** The part of a chat-completions request body that proofs look at. */
export const ModelRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(RequestMessage),
  tools: Schema.optional(Schema.Array(RequestTool)),
});

export type ModelRequest = typeof ModelRequest.Type;

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(ModelRequest));

export interface ModelServer {
  readonly baseUrl: string;
  /** Decoded bodies, in arrival order. */
  readonly requests: ReadonlyArray<ModelRequest>;
  /** Raw bodies, for substring checks such as "the SOUL was sent". */
  readonly rawRequests: ReadonlyArray<string>;
  /** The `index`th request; fails the proof when the model was not called that often. */
  readonly request: (index: number) => ModelRequest;
  /** The `index`th raw body; fails like `request`. */
  readonly raw: (index: number) => string;
  /** The tool-result messages sent in the `index`th request, as JSON. */
  readonly toolResults: (index: number) => string;
  /** Queue more replies after start. */
  readonly push: (...replies: ReadonlyArray<Reply>) => void;
  readonly stop: () => void;
}

const chunk = (delta: Schema.Json, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: "harness",
    object: "chat.completion.chunk",
    created: 1,
    model: "harness-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const textFrames = (value: string): ReadonlyArray<string> => [
  chunk({ role: "assistant", content: value }, null),
  chunk({}, "stop"),
  "data: [DONE]\n\n",
];

const toolFrames = (calls: ReadonlyArray<ToolCall>): ReadonlyArray<string> => [
  chunk(
    {
      role: "assistant",
      tool_calls: calls.map((call, index) => ({
        index,
        id: `call_${index}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    },
    null,
  ),
  chunk({}, "tool_calls"),
  "data: [DONE]\n\n",
];

const encoder = new TextEncoder();

const heldStream = (reply: Extract<Reply, { _tag: "Held" }>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: async (controller) => {
      controller.enqueue(encoder.encode(chunk({ role: "assistant", content: reply.first }, null)));
      reply.gate.markStarted();
      await reply.gate.wait;
      controller.enqueue(encoder.encode(chunk({ content: reply.rest }, null)));
      controller.enqueue(encoder.encode(chunk({}, "stop")));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

const respond = (reply: Reply): Response => {
  const headers = { "content-type": "text/event-stream" };

  switch (reply._tag) {
    case "Text":
      return new Response(textFrames(reply.text).join(""), { headers });
    case "Tools":
      return new Response(toolFrames(reply.calls).join(""), { headers });
    case "Fail":
      return Response.json({ error: { message: reply.message } }, { status: reply.status });
    case "Held":
      return new Response(heldStream(reply), { headers });
  }
};

export const startModelServer = (...script: ReadonlyArray<Reply>): ModelServer => {
  const queue = [...script];
  const requests: Array<ModelRequest> = [];
  const rawRequests: Array<string> = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (request) => {
      const raw = await request.text();

      // A body the schema rejects is answered 400: Pi fails at once instead of retrying a 5xx,
      // and `requests` and `rawRequests` stay index-aligned.
      try {
        requests.push(decodeRequest(raw));
      } catch (error) {
        return new Response(`harness could not read the request: ${String(error)}`, {
          status: 400,
        });
      }

      rawRequests.push(raw);

      return respond(queue.shift() ?? text("ok"));
    },
  });

  const request = (index: number): ModelRequest => {
    const found = requests[index];

    if (found === undefined) throw new Error(`model request ${index} was never made`);

    return found;
  };

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    rawRequests,
    request,
    raw: (index) => {
      request(index);

      return rawRequests[index] ?? "";
    },
    toolResults: (index) =>
      JSON.stringify(
        request(index)
          .messages.filter((message) => message.role === "tool")
          .map((message) => message.content),
      ),
    push: (...replies) => queue.push(...replies),
    stop: () => void server.stop(true),
  };
};

/** The last user message's content as JSON, for substring checks. */
export const lastUserContent = (request: ModelRequest): string =>
  JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content ?? null);
