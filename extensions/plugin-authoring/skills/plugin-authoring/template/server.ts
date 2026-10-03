// Plugin MCP server over stdio. Ziggy starts it with cwd = PLUGIN_ROOT and sets PLUGIN_DATA.
// stdout carries the protocol: log with console.error only.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const ROOT = import.meta.dir;
// Ziggy creates PLUGIN_DATA and always sets it; the plugin folder itself is read-only.
const DATA = process.env.PLUGIN_DATA;
if (!DATA) throw new Error("PLUGIN_DATA is not set; Ziggy (or smoke.ts) sets it");
const VIEW = "ui://example/view.html";

// One server process per session (G8): several can share this file, so WAL + busy timeout.
const db = new Database(join(DATA, "state.sqlite"), { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");
db.run(`CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

interface Item {
  id: number;
  title: string;
  done: boolean;
}

const items = (): Item[] =>
  db
    .query<{ id: number; title: string; done: number }, []>(
      "SELECT id, title, done FROM items ORDER BY done, id DESC",
    )
    .all()
    .map((row) => ({ id: row.id, title: row.title, done: row.done === 1 }));

// Every result carries text for faces without a UI (Slack, Telegram, CLI) and
// structuredContent for the view.
const snapshot = (note?: string) => {
  const list = items();
  const lines = list.map((item) => `${item.done ? "[x]" : "[ ]"} #${item.id} ${item.title}`);
  const text = [note, list.length === 0 ? "No items." : lines.join("\n")]
    .filter(Boolean)
    .join("\n");

  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { items: list },
  };
};

const failure = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

const server = new McpServer({ name: "example", version: "0.1.0" });

// Model + view: the model calls it, and the view opens with its result.
registerAppTool(
  server,
  "list_items",
  {
    title: "List items",
    description: "List the items, open ones first.",
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: VIEW } },
  },
  async () => snapshot(),
);

registerAppTool(
  server,
  "add_item",
  {
    title: "Add item",
    description: "Add an item to the list.",
    inputSchema: { title: z.string().trim().min(1).max(200) },
    _meta: { ui: { resourceUri: VIEW } },
  },
  async ({ title }) => {
    db.query("INSERT INTO items (title) VALUES (?)").run(title);

    return snapshot(`Added "${title}".`);
  },
);

// App-only: a click in the view is the person's intent, so the model never sees these.
registerAppTool(
  server,
  "set_done",
  {
    description: "Mark an item done or open (view only).",
    inputSchema: { id: z.number().int(), done: z.boolean() },
    _meta: { ui: { resourceUri: VIEW, visibility: ["app"] } },
  },
  async ({ id, done }) => {
    const { changes } = db.query("UPDATE items SET done = ? WHERE id = ?").run(done ? 1 : 0, id);

    return changes === 0 ? failure(`No item #${id}.`) : snapshot();
  },
);

registerAppTool(
  server,
  "remove_item",
  {
    description: "Remove an item (view only).",
    inputSchema: { id: z.number().int() },
    _meta: { ui: { resourceUri: VIEW, visibility: ["app"] } },
  },
  async ({ id }) => {
    const { changes } = db.query("DELETE FROM items WHERE id = ?").run(id);

    return changes === 0 ? failure(`No item #${id}.`) : snapshot();
  },
);

// The view is one HTML file built by `bun run build`. Read on each request so a rebuild shows up
// without restarting the server. Declare network origins in csp only when the view needs them:
// Ziggy's sandbox blocks everything else.
registerAppResource(server, "Example view", VIEW, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
  contents: [
    {
      uri: VIEW,
      mimeType: RESOURCE_MIME_TYPE,
      text: readFileSync(join(ROOT, "dist", "view.html"), "utf8"),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    },
  ],
}));

await server.connect(new StdioServerTransport());
