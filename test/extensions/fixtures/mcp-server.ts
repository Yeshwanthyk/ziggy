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
      uri: Schema.optional(Schema.String),
      capabilities: Schema.optional(Schema.Json),
    }),
  ),
});

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(Request));

const send = (message: Schema.Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

// `FIXTURE_VIEW` lets a second copy of this server declare a view of its own.
const VIEW = process.env["FIXTURE_VIEW"] ?? "ui://fixture/view.html";

/**
 * A hand-written MCP Apps view: it speaks the bridge protocol by hand, calls its own app-only
 * tool, tries a model-only one, and drafts a message, logging each outcome on the page.
 */
const VIEW_HTML = `<!doctype html><title>fixture</title><style>body{color:var(--color-text-primary,CanvasText);font:13px system-ui}</style><p>fixture view</p><ul id="log"></ul>
<script>
let next = 0;
const waiting = new Map();
const log = (text) => {
  const item = document.createElement("li");
  item.textContent = text;
  document.getElementById("log").append(item);
};
const request = (method, params) =>
  new Promise((resolve) => {
    next += 1;
    waiting.set(next, resolve);
    parent.postMessage({ jsonrpc: "2.0", id: next, method, params }, "*");
  });
addEventListener("message", (event) => {
  const message = event.data;
  if (message && waiting.has(message.id)) {
    waiting.get(message.id)(message);
    waiting.delete(message.id);
  }
});
(async () => {
  const init = await request("ui/initialize", {
    appInfo: { name: "fixture", version: "1" },
    appCapabilities: {},
    protocolVersion: "2026-01-26",
  });
  const variables = init.result?.hostContext?.styles?.variables ?? {};
  for (const [name, value] of Object.entries(variables)) {
    if (value) document.documentElement.style.setProperty(name, value);
  }
  parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
  const own = await request("tools/call", { name: "app_only", arguments: { value: "from-view" } });
  log("app_only: " + JSON.stringify(own.result ? own.result.structuredContent : own.error));
  const model = await request("tools/call", { name: "model_only", arguments: {} });
  log("model_only: " + (model.result && model.result.isError ? "refused" : "allowed"));
  const sent = await request("ui/message", {
    role: "user",
    content: [{ type: "text", text: "Hello from the fixture view" }],
  });
  log("ui/message: " + (sent.result && !sent.result.isError ? "drafted" : "failed"));
})();
</script>`;

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
      mkdirSync(join(process.cwd(), ".runtime"), { recursive: true });
      appendFileSync(
        join(process.cwd(), ".runtime", "mcp-initialize"),
        `${JSON.stringify(request.params?.capabilities ?? null)}\n`,
      );
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: {}, logging: {} },
        serverInfo: { name: "ziggy-fixture", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          tool("echo"),
          tool("secret"),
          // MCP Apps: `view` has a view, `app_only` serves only that view, `model_only` never.
          { ...tool("view"), _meta: { ui: { resourceUri: VIEW } } },
          { ...tool("app_only"), _meta: { ui: { resourceUri: VIEW, visibility: ["app"] } } },
          { ...tool("model_only"), _meta: { ui: { visibility: ["model"] } } },
          // `_meta.ui` that does not decode: the host cannot tell its visibility, so hides it.
          { ...tool("bad_ui"), _meta: { ui: { visibility: "app" } } },
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
          : request.params?.name === "view" || request.params?.name === "app_only"
            ? {
                content: [{ type: "text", text: `fixture:${value}` }],
                structuredContent: { tool: request.params.name, value },
              }
            : { content: [{ type: "text", text: `fixture:${value}` }] };
      break;
    }

    case "resources/read":
      if (request.params?.uri !== VIEW) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "Not found" } });

        return;
      }

      result = {
        contents: [
          {
            uri: VIEW,
            mimeType: "text/html;profile=mcp-app",
            text: VIEW_HTML,
          },
        ],
      };
      break;

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
