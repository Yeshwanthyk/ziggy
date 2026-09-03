/* oxlint-disable ziggy/no-runtime-typeof, ziggy/no-reflect-get, ziggy/no-conditional-empty-object-spread, typescript/no-this-alias -- Search input is already confined JSON and is narrowed at this host boundary. */
import { Effect, Option, Schema } from "effect";
import type { CodeModeConfig, ResolvedLimits } from "./config.ts";
import { McpClientError, McpStdioClient, type McpTool } from "./mcp.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

const jsonField = (input: Schema.Json, key: string): Schema.Json | undefined =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? Reflect.get(input, key)
    : undefined;

const catalogEntry = (server: string, tool: McpTool): Schema.Json => {
  const inputSchema = decodeJson(tool.inputSchema);
  return {
    path: `${server}.${tool.name}`,
    description: tool.description ?? "",
    ...(Option.isSome(inputSchema) ? { inputSchema: inputSchema.value } : {}),
  };
};

export class McpHost {
  readonly #clients = new Map<string, McpStdioClient>();

  constructor(
    readonly config: CodeModeConfig,
    readonly profilePath: string,
    readonly limits: ResolvedLimits,
  ) {}

  search(input: Schema.Json): Effect.Effect<Schema.Json, McpClientError> {
    const queryValue = jsonField(input, "query");
    const namespaceValue = jsonField(input, "namespace");
    const limitValue = jsonField(input, "limit");
    const query = typeof queryValue === "string" ? queryValue.trim().toLowerCase() : "";
    const namespace = typeof namespaceValue === "string" ? namespaceValue : undefined;
    const requestedLimit = typeof limitValue === "number" ? Math.floor(limitValue) : 20;
    const limit = Math.max(1, Math.min(this.limits.maxCatalogTools, requestedLimit));
    const serverNames = Object.keys(this.config.mcpServers)
      .filter((name) => namespace === undefined || name === namespace)
      .sort();
    const self = this;
    return Effect.gen(function* () {
      const entries: Schema.Json[] = [];
      let acquired = 0;
      for (const server of serverNames) {
        const remaining = self.limits.maxCatalogTools - acquired;
        if (remaining <= 0) break;
        const client = yield* self.#client(server);
        const tools = yield* client.listTools(remaining);
        acquired += tools.length;
        const allowed = new Set(self.config.mcpServers[server]?.allowTools ?? []);
        for (const tool of tools) {
          if (!allowed.has(tool.name)) continue;
          const entry = catalogEntry(server, tool);
          const haystack = `${server}.${tool.name} ${tool.description ?? ""}`.toLowerCase();
          if (query.length === 0 || query.split(/\s+/).every((term) => haystack.includes(term))) {
            entries.push(entry);
          }
        }
      }
      return entries.slice(0, limit);
    });
  }

  call(
    server: string,
    toolName: string,
    input: Schema.Json,
  ): Effect.Effect<Schema.Json, McpClientError> {
    const self = this;
    return Effect.gen(function* () {
      const allowed = self.config.mcpServers[server]?.allowTools;
      if (allowed === undefined || !allowed.includes(toolName)) {
        return yield* new McpClientError({
          server,
          operation: "tools/call",
          reason: `MCP tool '${toolName}' is not allowed by Profile policy.`,
        });
      }
      const client = yield* self.#client(server);
      const tools = yield* client.listTools(self.limits.maxCatalogTools);
      if (!tools.some((tool) => tool.name === toolName)) {
        return yield* new McpClientError({
          server,
          operation: "tools/call",
          reason: `Unknown MCP tool '${toolName}'.`,
        });
      }
      if (!allowed.includes(toolName)) {
        return yield* new McpClientError({
          server,
          operation: "tools/call",
          reason: `MCP tool '${toolName}' is not allowed by Profile policy.`,
        });
      }
      return yield* client.callTool(toolName, input);
    });
  }

  close(): Effect.Effect<void> {
    return this.revokeAll();
  }

  revokeAll(): Effect.Effect<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    return Effect.forEach(clients, (client) => client.close(), {
      concurrency: "unbounded",
      discard: true,
    });
  }

  #client(server: string): Effect.Effect<McpStdioClient, McpClientError> {
    const existing = this.#clients.get(server);
    if (existing !== undefined) return Effect.succeed(existing);
    const config = this.config.mcpServers[server];
    if (config === undefined) {
      return Effect.fail(
        new McpClientError({
          server,
          operation: "connect",
          reason: `Unknown configured MCP server '${server}'.`,
        }),
      );
    }
    return McpStdioClient.connect(
      server,
      config,
      this.profilePath,
      this.limits.maxMcpMessageBytes,
    ).pipe(
      Effect.tap((client) =>
        Effect.sync(() => {
          this.#clients.set(server, client);
        }),
      ),
    );
  }
}
