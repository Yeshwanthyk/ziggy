import type {
  McpServerEntry,
  McpTransportFactory,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Effect, Option, Predicate, Schema } from "effect";
// Pi 0.99.1 exports the factory type from the package root but not the default factory itself.
import { createDefaultTransport } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js";

/**
 * MCP Apps on stock Pi (docs/operations/plugins.md): every MCP connection Pi opens goes
 * through a Ziggy transport tap. The tap advertises the UI extension, records each tool's
 * `_meta.ui`, hides tools the model may not see, and carries the view's own requests on the same
 * connection with ids Pi never uses.
 */

type McpTransport = ReturnType<McpTransportFactory>;

type JsonRpcMessage = Parameters<McpTransport["send"]>[0];

type MessageListener = Parameters<McpTransport["onMessage"]>[0];

type JsonRpcRequest = Extract<JsonRpcMessage, { readonly id: unknown; readonly method: string }>;

type JsonRpcSuccess = Extract<JsonRpcMessage, { readonly result: unknown }>;

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const UI_EXTENSION = "io.modelcontextprotocol/ui";

const APP_REQUEST_PREFIX = "ziggy-app-";

const APP_REQUEST_TIMEOUT_MS = 60_000;

/** What one tool call keeps for its view; the result is dropped past the cap, never cut. */
export const MCP_APP_INPUT_MAX_BYTES = 8 * 1_024;

export const MCP_APP_RESULT_MAX_BYTES = 24 * 1_024;

/** A model-called tool that has a view: what the view needs to render the call again. */
export const McpToolApp = Schema.Struct({
  server: Schema.String,
  tool: Schema.String,
  resourceUri: Schema.String,
  input: Schema.optionalKey(Schema.Json),
  result: Schema.optionalKey(Schema.Json),
  /** Input or result was over its cap and left out; the view gets a placeholder. */
  truncated: Schema.optionalKey(Schema.Literal(true)),
});

export type McpToolApp = typeof McpToolApp.Type;

export const McpAppArguments = Schema.Record(Schema.String, Schema.Json);

export type McpAppArguments = typeof McpAppArguments.Type;

export class McpAppRefused extends Schema.TaggedErrorClass<McpAppRefused>()("McpAppRefused", {
  server: Schema.String,
  reason: Schema.Literals([
    "unknown-server",
    "not-app-resource",
    "not-app-tool",
    "unavailable",
    "failed",
  ]),
  message: Schema.String,
}) {}

type Visibility = ReadonlyArray<"model" | "app">;

interface AppTool {
  readonly resourceUri: string | undefined;
  readonly visibility: Visibility;
}

const UiMeta = Schema.Struct({
  resourceUri: Schema.optionalKey(Schema.String),
  visibility: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ListedTool = Schema.Struct({
  name: Schema.String,
  _meta: Schema.optionalKey(
    Schema.Struct({
      ui: Schema.optionalKey(UiMeta),
      "ui/resourceUri": Schema.optionalKey(Schema.String),
    }),
  ),
});

const decodeListedTool = Schema.decodeUnknownOption(ListedTool);

const ToolsListResult = Schema.Struct({ tools: Schema.Array(Schema.Json) });

const decodeToolsListResult = Schema.decodeUnknownOption(ToolsListResult);

const JsonObject = Schema.Record(Schema.String, Schema.Json);

const decodeJsonObject = Schema.decodeUnknownOption(JsonObject);

const EMPTY: typeof JsonObject.Type = {};

const orEmpty = (value: Option.Option<typeof JsonObject.Type>): typeof JsonObject.Type =>
  Option.getOrElse(value, () => EMPTY);

const ErrorMessage = Schema.Struct({ message: Schema.String });

const isErrorMessage = Schema.is(ErrorMessage);

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

const ListParams = Schema.Struct({ cursor: Schema.optionalKey(Schema.String) });

const decodeListParams = Schema.decodeUnknownOption(ListParams);

const AppResponse = Schema.Struct({
  id: Schema.String,
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});

const decodeAppResponse = Schema.decodeUnknownOption(AppResponse);

const ToolDetails = Schema.Struct({ server: Schema.String, tool: Schema.String });

const decodeToolDetails = Schema.decodeUnknownOption(ToolDetails);

const isUiResourceUri = (value: string): boolean => value.startsWith("ui://");

/** `_meta.ui` of a listed tool; visibility defaults to both, unknown entries are ignored. */
const appTool = (tool: typeof ListedTool.Type): AppTool => {
  const resourceUri = tool._meta?.ui?.resourceUri ?? tool._meta?.["ui/resourceUri"];

  const listed = (tool._meta?.ui?.visibility ?? ["model", "app"]).flatMap(
    (entry): ReadonlyArray<"model" | "app"> =>
      entry === "model" || entry === "app" ? [entry] : [],
  );

  return {
    resourceUri:
      resourceUri !== undefined && isUiResourceUri(resourceUri) ? resourceUri : undefined,
    visibility: listed,
  };
};

/** A listed tool that names `_meta.ui` (or the legacy key) at all, whether or not it decodes. */
const claimsUi = (raw: Schema.Json): boolean =>
  Option.match(
    Option.flatMap(decodeJsonObject(raw), (tool) => decodeJsonObject(tool["_meta"])),
    { onNone: () => false, onSome: (meta) => "ui" in meta || "ui/resourceUri" in meta },
  );

const byteLength = (value: Schema.Json): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

interface PendingRequest {
  readonly resolve: (value: Schema.Json) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ServerApps {
  readonly tools: Map<string, AppTool>;
  tap: AppTap | undefined;
}

interface AppTap {
  readonly ready: () => boolean;
  readonly request: (method: string, params: Schema.Json) => Promise<Schema.Json>;
}

export interface McpApps {
  /** Wraps Pi's own transport for every server; passed to `createMcpExtension`. */
  readonly transport: McpTransportFactory;
  /** Secret redaction for app results; set by each MCP stack build from its server configs. */
  readonly setRedactor: (redact: (value: Schema.Json) => Schema.Json) => void;
  /** The view record for one model-called MCP tool, or none when the tool has no view. */
  readonly toolApp: (event: ToolResultEvent) => McpToolApp | undefined;
  /** A tool call from `server`'s own view: the tool must be that server's and allow the app. */
  readonly callTool: (
    server: string,
    resourceUri: string,
    tool: string,
    args: McpAppArguments,
  ) => Effect.Effect<Schema.Json, McpAppRefused>;
  /** A UI resource that one of `server`'s tools declares. */
  readonly readResource: (server: string, uri: string) => Effect.Effect<Schema.Json, McpAppRefused>;
}

const refused = (server: string, reason: McpAppRefused["reason"], message: string) =>
  new McpAppRefused({ server, reason, message });

/**
 * One registry per Profile runtime, so it outlives Pi's service rebuilds on session switch. It
 * keeps the latest connection and tool list Pi made for each server.
 */
export const makeMcpApps = (): McpApps => {
  const servers = new Map<string, ServerApps>();
  let redact = (value: Schema.Json): Schema.Json => value;

  const serverApps = (name: string): ServerApps => {
    const existing = servers.get(name);

    if (existing !== undefined) return existing;
    const created: ServerApps = { tools: new Map(), tap: undefined };
    servers.set(name, created);

    return created;
  };

  const tapTransport = (entry: McpServerEntry, inner: McpTransport): McpTransport => {
    const apps = serverApps(entry.name);
    const listeners = new Set<MessageListener>();
    const listRequests = new Map<string | number, boolean>();
    const pending = new Map<string, PendingRequest>();
    let initialized = false;
    let sequence = 0;

    const tap: AppTap = {
      ready: () => initialized,
      request: (method, params) =>
        new Promise<Schema.Json>((resolve, reject) => {
          sequence += 1;
          const id = `${APP_REQUEST_PREFIX}${sequence}`;

          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`MCP ${method} timed out`));
          }, APP_REQUEST_TIMEOUT_MS);

          pending.set(id, { resolve, reject, timer });
          inner.send({ jsonrpc: "2.0", id, method, params }).then(undefined, (cause: unknown) => {
            clearTimeout(timer);
            pending.delete(id);
            reject(new Error(`MCP ${method} could not be sent`, { cause }));
          });
        }),
    };

    /** The `initialize` request with the MCP Apps capability added to Pi's capabilities. */
    const withUiCapability = (request: JsonRpcRequest): JsonRpcRequest => {
      const base = orEmpty(decodeJsonObject(request.params));
      const capabilities = orEmpty(decodeJsonObject(base["capabilities"]));
      const extensions = orEmpty(decodeJsonObject(capabilities["extensions"]));

      const params = {
        ...base,
        capabilities: {
          ...capabilities,
          extensions: { ...extensions, [UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
        },
      };

      return { ...request, params };
    };

    /** A tools/list page: record every tool, pass on only the ones the model may see. */
    const listed = (fresh: boolean, response: JsonRpcSuccess): JsonRpcSuccess =>
      Option.match(decodeToolsListResult(response.result), {
        onNone: () => response,
        onSome: (page) => {
          if (fresh) apps.tools.clear();

          const visible = page.tools.filter((raw) =>
            Option.match(decodeListedTool(raw), {
              // An app tool whose `_meta.ui` does not decode may be app-only; never offer it.
              onNone: () => {
                if (!claimsUi(raw)) return true;
                console.warn(`[mcp] ${entry.name}: hid a tool whose _meta.ui is invalid`);

                return false;
              },
              onSome: (tool) => {
                const app = appTool(tool);
                apps.tools.set(tool.name, app);

                return app.visibility.includes("model");
              },
            }),
          );

          return {
            ...response,
            result: { ...orEmpty(decodeJsonObject(response.result)), tools: visible },
          };
        },
      });

    const receive = (message: JsonRpcMessage): void => {
      if ("id" in message && !("method" in message)) {
        const app = decodeAppResponse(message);

        if (Option.isSome(app) && app.value.id.startsWith(APP_REQUEST_PREFIX)) {
          const request = pending.get(app.value.id);

          if (request !== undefined) {
            pending.delete(app.value.id);
            clearTimeout(request.timer);

            if (app.value.error !== undefined) request.reject(new Error(app.value.error.message));
            else request.resolve(app.value.result ?? null);
          }

          return;
        }

        const fresh = listRequests.get(message.id);

        if (fresh !== undefined) {
          listRequests.delete(message.id);

          if ("result" in message) {
            const page = listed(fresh, message);

            for (const listener of listeners) listener(page);

            return;
          }
        }
      }

      for (const listener of listeners) listener(message);
    };

    inner.onMessage(receive);
    inner.onClose(() => {
      if (apps.tap === tap) apps.tap = undefined;

      for (const [id, request] of pending) {
        clearTimeout(request.timer);
        request.reject(new Error("MCP connection closed"));
        pending.delete(id);
      }
    });

    apps.tap = tap;

    const wrapped: McpTransport = {
      start: () => inner.start(),
      close: () => inner.close(),
      onMessage: (listener) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
      onError: (listener) => inner.onError(listener),
      onClose: (listener) => inner.onClose(listener),
      send: async (message) => {
        if ("method" in message && "id" in message) {
          if (message.method === "initialize") return inner.send(withUiCapability(message));

          if (message.method === "tools/list") {
            const cursor = Option.flatMap(decodeListParams(message.params), (params) =>
              Option.fromUndefinedOr(params.cursor),
            );

            listRequests.set(message.id, Option.isNone(cursor));
          }
        }

        await inner.send(message);

        if (
          "method" in message &&
          !("id" in message) &&
          message.method === "notifications/initialized"
        )
          initialized = true;
      },
    };

    if (inner.setProtocolVersion !== undefined) {
      const setProtocolVersion = inner.setProtocolVersion.bind(inner);
      wrapped.setProtocolVersion = (version) => setProtocolVersion(version);
    }

    return wrapped;
  };

  const connected = (server: string): Effect.Effect<AppTap, McpAppRefused> => {
    const apps = servers.get(server);

    if (apps === undefined)
      return Effect.fail(refused(server, "unknown-server", `MCP server ${server} is not loaded`));

    const tap = apps.tap;

    return tap === undefined || !tap.ready()
      ? Effect.fail(
          refused(
            server,
            "unavailable",
            `MCP server ${server} is not connected; it reconnects when the assistant next uses it`,
          ),
        )
      : Effect.succeed(tap);
  };

  const declares = (server: string, uri: string): boolean =>
    [...(servers.get(server)?.tools.values() ?? [])].some((tool) => tool.resourceUri === uri);

  const send = (server: string, tap: AppTap, method: string, params: Schema.Json) =>
    Effect.tryPromise({
      try: () => tap.request(method, params),
      catch: (cause) => {
        const message = redact(isErrorMessage(cause) ? cause.message : "unknown error");

        return refused(
          server,
          "failed",
          `MCP ${method} failed: ${Predicate.isString(message) ? message : "unknown error"}`,
        );
      },
    }).pipe(Effect.map((value) => redact(value)));

  return {
    transport: (entry, cwd, authProvider) =>
      tapTransport(entry, createDefaultTransport(entry, cwd, authProvider)),
    setRedactor: (next) => {
      redact = next;
    },
    toolApp: (event) =>
      Option.getOrUndefined(
        Option.flatMap(decodeToolDetails(event.details), ({ server, tool }) => {
          const resourceUri = servers.get(server)?.tools.get(tool)?.resourceUri;

          if (resourceUri === undefined) return Option.none();
          const args = Option.getOrUndefined(decodeJson(event.input));
          const result = Option.getOrUndefined(decodeJson(event.structuredContent));

          const keepInput = args !== undefined && byteLength(args) <= MCP_APP_INPUT_MAX_BYTES;

          const keepResult = result !== undefined && byteLength(result) <= MCP_APP_RESULT_MAX_BYTES;

          const base: McpToolApp = { server, tool, resourceUri };
          const withInput: McpToolApp = keepInput ? { ...base, input: args } : base;
          const withResult: McpToolApp = keepResult ? { ...withInput, result } : withInput;

          return Option.some(
            keepInput && keepResult ? withResult : { ...withResult, truncated: true as const },
          );
        }),
      ),
    callTool: (server, resourceUri, tool, args) =>
      Effect.gen(function* () {
        const tap = yield* connected(server);

        if (!declares(server, resourceUri))
          return yield* refused(
            server,
            "not-app-resource",
            `${resourceUri} is not a view of MCP server ${server}`,
          );

        const target = servers.get(server)?.tools.get(tool);

        if (target === undefined || !target.visibility.includes("app"))
          return yield* refused(
            server,
            "not-app-tool",
            `${tool} is not a tool MCP server ${server} offers to its views`,
          );

        return yield* send(server, tap, "tools/call", { name: tool, arguments: args });
      }),
    readResource: (server, uri) =>
      Effect.gen(function* () {
        const tap = yield* connected(server);

        if (!declares(server, uri))
          return yield* refused(
            server,
            "not-app-resource",
            `${uri} is not a view of MCP server ${server}`,
          );

        return yield* send(server, tap, "resources/read", { uri });
      }),
  };
};
