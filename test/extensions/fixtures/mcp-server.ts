// Tiny newline-framed stdio MCP server. The MCP SDK is absent in the installed Pi tree.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Schema } from "effect";

const Request = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Struct({ value: Schema.optional(Schema.String) })),
    }),
  ),
});

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(Request));

const send = (message: Schema.Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

const tool = (name: string) => ({
  name,
  description: `Fixture ${name}`,
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = decodeRequest(line);

  if (request.id === undefined) return;

  let result: Schema.Json;

  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, logging: {} },
        serverInfo: { name: "ziggy-fixture", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          tool("echo"),
          tool("secret"),
          { ...tool("app_only"), _meta: { ui: { visibility: ["app"] } } },
        ],
      };
      break;
    case "tools/call": {
      mkdirSync(join(process.cwd(), ".runtime"), { recursive: true });
      appendFileSync(join(process.cwd(), ".runtime", "mcp-calls"), `${request.params?.name}\n`);
      const value = request.params?.arguments?.value ?? "";

      // `secret` echoes the server's own credential back, as a careless server might.
      const secret = process.env["FIXTURE_SECRET"] ?? "";

      result =
        request.params?.name === "secret"
          ? {
              content: [{ type: "text", text: `secret:${secret}` }],
              structuredContent: { nested: [{ credential: secret }] },
            }
          : { content: [{ type: "text", text: `fixture:${value}` }] };
      break;
    }

    case "ping":
    case "logging/setLevel":
      result = {};
      break;
    default:
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } });

      return;
  }

  send({ jsonrpc: "2.0", id: request.id, result });

  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: "fixture ready" },
    });
  }
});
