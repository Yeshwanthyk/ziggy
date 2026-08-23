/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-promise-catch -- Native Bun stdio promises are adapted to Effect at this file boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- JSON framing and sink failures are translated to typed MCP errors at this adapter boundary. */
/* oxlint-disable ziggy/no-unknown-parameters, ziggy/no-conditional-empty-object-spread, unicorn/no-useless-fallback-in-spread, typescript/no-this-alias -- Unknown JSON-RPC payloads are schema-decoded before leaving this adapter. */
import { Effect, Option, Schema } from "effect";
import type { McpServerConfig } from "./config.ts";

const RpcResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
const RpcNotification = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const RpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.Number, Schema.String]),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const Inbound = Schema.Union([RpcResponse, RpcNotification, RpcRequest]);
const decodeInbound = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Inbound, Schema.Array(Inbound)])),
);
const InitializeResult = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.Unknown,
  serverInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
});
const decodeInitializeResult = Schema.decodeUnknownOption(InitializeResult);

const Tool = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.optionalKey(Schema.Unknown),
});
const ToolsPage = Schema.Struct({
  tools: Schema.Array(Tool),
  nextCursor: Schema.optionalKey(Schema.String),
});
const decodeToolsPage = Schema.decodeUnknownOption(ToolsPage);
const CallToolResult = Schema.Struct({
  content: Schema.Array(Schema.Json),
  structuredContent: Schema.optionalKey(Schema.Json),
  isError: Schema.optionalKey(Schema.Boolean),
});
const decodeToolResult = Schema.decodeUnknownOption(CallToolResult);
const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type McpTool = typeof Tool.Type;

export class McpClientError extends Schema.TaggedErrorClass<McpClientError>()("McpClientError", {
  server: Schema.String,
  operation: Schema.String,
  reason: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

type Pending = {
  readonly operation: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: McpClientError) => void;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class McpStdioClient {
  readonly #process: Bun.Subprocess<"pipe", "pipe", "ignore">;
  readonly #pending = new Map<number, Pending>();
  readonly #writer: Bun.FileSink;
  readonly #maxMessageBytes: number;
  readonly #server: string;
  #nextId = 1;
  #closed = false;
  #termination: Promise<void> | undefined;
  #tools: ReadonlyArray<McpTool> | undefined;

  private constructor(
    server: string,
    config: McpServerConfig,
    profilePath: string,
    maxMessageBytes: number,
  ) {
    this.#server = server;
    this.#maxMessageBytes = maxMessageBytes;
    this.#process = Bun.spawn([config.command, ...(config.args ?? [])], {
      cwd: profilePath,
      detached: process.platform !== "win32",
      env: { ...(config.env ?? {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.#writer = this.#process.stdin;
    void this.#readLoop();
    void this.#process.exited.then((code) => {
      this.#closed = true;
      this.#failAll(`MCP process exited with code ${code}.`);
    });
  }

  static connect(
    server: string,
    config: McpServerConfig,
    profilePath: string,
    maxMessageBytes: number,
  ): Effect.Effect<McpStdioClient, McpClientError> {
    let client: McpStdioClient | undefined;
    return Effect.gen(function* () {
      client = yield* Effect.try({
        try: () => new McpStdioClient(server, config, profilePath, maxMessageBytes),
        catch: (cause) =>
          new McpClientError({
            server,
            operation: "spawn",
            reason: "Could not start configured MCP stdio server.",
            cause,
          }),
      });
      const initialized = yield* client.#request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "ziggy-codemode", version: "0.1.0" },
      });
      if (Option.isNone(decodeInitializeResult(initialized))) {
        return yield* new McpClientError({
          server,
          operation: "initialize",
          reason: "MCP server returned an invalid initialize result.",
        });
      }
      yield* client.#notify("notifications/initialized", {});
      return client;
    }).pipe(
      Effect.onError(() => (client === undefined ? Effect.void : client.close())),
      Effect.onInterrupt(() => (client === undefined ? Effect.void : client.close())),
    );
  }

  listTools(maximum: number): Effect.Effect<ReadonlyArray<McpTool>, McpClientError> {
    if (this.#tools !== undefined) return Effect.succeed(this.#tools.slice(0, maximum));
    const self = this;
    return Effect.gen(function* () {
      const tools: McpTool[] = [];
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const raw = yield* self.#request("tools/list", cursor === undefined ? {} : { cursor });
        const decoded = decodeToolsPage(raw);
        if (Option.isNone(decoded)) {
          return yield* new McpClientError({
            server: self.#server,
            operation: "tools/list",
            reason: "MCP server returned an invalid tools/list result.",
          });
        }
        for (const tool of decoded.value.tools) {
          if (!SAFE_TOOL_NAME.test(tool.name) || names.has(tool.name)) {
            return yield* new McpClientError({
              server: self.#server,
              operation: "tools/list",
              reason: "MCP server returned a duplicate or unsafe tool name.",
            });
          }
          names.add(tool.name);
          tools.push(tool);
          if (tools.length >= maximum) break;
        }
        const nextCursor = decoded.value.nextCursor;
        if (nextCursor !== undefined && cursors.has(nextCursor)) {
          return yield* new McpClientError({
            server: self.#server,
            operation: "tools/list",
            reason: "MCP server repeated a tools/list cursor.",
          });
        }
        if (nextCursor !== undefined) cursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor !== undefined && tools.length < maximum && cursors.size <= maximum);
      self.#tools = tools;
      return tools.slice(0, maximum);
    });
  }

  callTool(name: string, input: Schema.Json): Effect.Effect<Schema.Json, McpClientError> {
    return this.#request("tools/call", { name, arguments: input }).pipe(
      Effect.flatMap((raw) => {
        const decoded = decodeToolResult(raw);
        if (Option.isNone(decoded)) {
          return Effect.fail(
            new McpClientError({
              server: this.#server,
              operation: "tools/call",
              reason: "MCP server returned a non-JSON tool result.",
            }),
          );
        }
        if (decoded.value.isError === true) {
          return Effect.fail(
            new McpClientError({
              server: this.#server,
              operation: "tools/call",
              reason: "MCP tool reported failure.",
            }),
          );
        }
        return Effect.succeed(
          decoded.value.structuredContent === undefined
            ? { content: decoded.value.content }
            : {
                content: decoded.value.content,
                structuredContent: decoded.value.structuredContent,
              },
        );
      }),
    );
  }

  close(): Effect.Effect<void> {
    return Effect.promise(() => this.#terminateAndWait());
  }

  #request(method: string, params: Schema.Json): Effect.Effect<unknown, McpClientError> {
    return Effect.callback<unknown, McpClientError>((resume, signal) => {
      if (this.#closed) {
        resume(
          Effect.fail(
            new McpClientError({
              server: this.#server,
              operation: method,
              reason: "MCP client is closed.",
            }),
          ),
        );
        return;
      }
      const id = this.#nextId++;
      this.#pending.set(id, {
        operation: method,
        resolve: (value) => resume(Effect.succeed(value)),
        reject: (error) => resume(Effect.fail(error)),
      });
      this.#write({ jsonrpc: "2.0", id, method, params }).catch((cause) => {
        this.#pending.delete(id);
        resume(
          Effect.fail(
            new McpClientError({
              server: this.#server,
              operation: method,
              reason: "Could not write MCP request.",
              cause,
            }),
          ),
        );
      });
      const cancel = () => {
        if (!this.#pending.delete(id)) return;
        void this.#write({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "Code Mode execution cancelled" },
        }).catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      return Effect.sync(() => {
        cancel();
        signal.removeEventListener("abort", cancel);
      });
    });
  }

  #notify(method: string, params: Schema.Json): Effect.Effect<void, McpClientError> {
    return Effect.tryPromise({
      try: () => this.#write({ jsonrpc: "2.0", method, params }),
      catch: (cause) =>
        new McpClientError({
          server: this.#server,
          operation: method,
          reason: "Could not write MCP notification.",
          cause,
        }),
    });
  }

  async #write(message: Schema.Json): Promise<void> {
    const body = JSON.stringify(message);
    const bytes = encoder.encode(`${body}\n`);
    if (bytes.byteLength > this.#maxMessageBytes) {
      throw new Error("MCP request exceeds the configured message limit.");
    }
    await this.#writer.write(bytes);
    await this.#writer.flush();
  }

  async #readLoop(): Promise<void> {
    const reader = this.#process.stdout.getReader();
    let buffered = "";
    try {
      while (!this.#closed) {
        const next = await reader.read();
        if (next.done) break;
        buffered += decoder.decode(next.value, { stream: true });
        while (true) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line.length > 0) {
            if (encoder.encode(line).byteLength > this.#maxMessageBytes) {
              this.#protocolFailure("MCP response exceeds the configured message limit.");
              return;
            }
            this.#accept(line);
          }
        }
        if (encoder.encode(buffered).byteLength > this.#maxMessageBytes) {
          this.#protocolFailure("MCP response exceeds the configured message limit.");
          return;
        }
      }
    } catch (cause) {
      this.#failAll("Could not read MCP stdio response.", cause);
    }
  }

  #accept(line: string): void {
    const decoded = decodeInbound(line);
    if (Option.isNone(decoded)) {
      this.#protocolFailure("MCP server emitted malformed JSON-RPC.");
      return;
    }
    const messages = Array.isArray(decoded.value) ? decoded.value : [decoded.value];
    for (const message of messages) this.#acceptMessage(message);
  }

  #acceptMessage(message: typeof Inbound.Type): void {
    if ("method" in message) {
      if ("id" in message) this.#protocolFailure("MCP server requests are not enabled.");
      return;
    }
    if ((message.result === undefined) === (message.error === undefined)) {
      this.#protocolFailure("MCP response must contain exactly one result or error.");
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(
        new McpClientError({
          server: this.#server,
          operation: pending.operation,
          reason: `MCP error ${message.error.code}: ${message.error.message}`,
        }),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #protocolFailure(reason: string): void {
    this.#failAll(reason);
    void this.#terminateAndWait();
  }

  #terminateAndWait(): Promise<void> {
    if (this.#termination !== undefined) return this.#termination;
    this.#closed = true;
    this.#failAll("MCP client closed.");
    void Promise.resolve(this.#writer.end()).catch(() => undefined);
    this.#termination = this.#shutdownProcess();
    return this.#termination;
  }

  async #shutdownProcess(): Promise<void> {
    const signal = (name: "SIGTERM" | "SIGKILL") => {
      if (process.platform !== "win32") {
        try {
          process.kill(-this.#process.pid, name);
          return;
        } catch {
          // Fall back to the direct child when its detached process group already exited.
        }
      }
      try {
        this.#process.kill(name);
      } catch {
        // The direct child can exit between the process-group and fallback signals.
      }
    };
    signal("SIGTERM");
    const exitedDuringGrace = await Promise.race([
      this.#process.exited.then(() => true),
      Bun.sleep(150).then(() => false),
    ]);
    if (process.platform !== "win32" || !exitedDuringGrace) signal("SIGKILL");
    await this.#process.exited;
  }

  #failAll(reason: string, cause?: unknown): void {
    for (const pending of this.#pending.values()) {
      pending.reject(
        new McpClientError({
          server: this.#server,
          operation: pending.operation,
          reason,
          ...(cause === undefined ? {} : { cause }),
        }),
      );
    }
    this.#pending.clear();
  }
}
