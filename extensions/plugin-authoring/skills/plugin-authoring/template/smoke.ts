// Smoke test: `bun run check` (build + this). Checks the files with the rules Ziggy applies
// (rules.ts), then starts each stdio server the way Ziggy does and exercises it.
//
// SAFETY: smoke calls only READS and LOCAL writes, whose effects stay in PLUGIN_DATA (a scratch
// folder here). A tool that writes anywhere else (an external API, a file outside PLUGIN_DATA,
// a message) is NEVER called: it is only listed with its visibility, and checked by hand with
// the person. When the Profile already has data for this plugin, the reads also run once
// against a copy of it.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { checkPlugin, launch, type Secret, type StdioServer } from "./rules";

// Edit these for your plugin. Every model- or app-visible tool must be in exactly one list.
// Reads: no side effects. They also run against a copy of the Profile's real data.
const READS: ReadonlyArray<Call> = [{ tool: "list_items" }];
// Local writes: effects stay in PLUGIN_DATA. Runs in order; `{ "$id": "add_item" }` stands for
// the first item id that call returned. A call whose `$id` has no item (an empty read) is skipped
// with a warning.
const LOCAL_WRITES: ReadonlyArray<Call> = [
  { tool: "add_item", args: { title: "smoke item" } },
  { tool: "set_done", args: { id: { $id: "add_item" }, done: true } },
  { tool: "remove_item", args: { id: { $id: "add_item" } } },
];
// External writes: listed and checked for visibility only, never called.
const EXTERNAL_WRITES: ReadonlyArray<string> = [];

interface Call {
  readonly tool: string;
  readonly args?: Record<string, unknown>;
}

const ROOT = import.meta.dir;
const ID = basename(ROOT);
const problems: string[] = [];
const check = (ok: unknown, message: string) => {
  if (!ok) problems.push(message);
};

// A tool sits in one list only, so an external write can never also be called as a read or a
// local write.
const lists = {
  READS: READS.map((call) => call.tool),
  LOCAL_WRITES: LOCAL_WRITES.map((call) => call.tool),
  EXTERNAL_WRITES,
};
for (const tool of new Set(Object.values(lists).flat())) {
  const inLists = Object.entries(lists).flatMap(([list, tools]) =>
    tools.includes(tool) ? [list] : [],
  );
  check(inLists.length === 1, `tool ${tool} is in more than one list: ${inLists.join(", ")}`);
}

// `${NAME}` the way Ziggy looks it up: the Keychain (service ziggy-plugin), then the environment.
const secret: Secret = (name) => {
  if (process.platform === "darwin") {
    const found = spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "ziggy-plugin", "-a", name, "-w"],
      { encoding: "utf8" },
    );

    if (found.status === 0) return found.stdout.replace(/\n$/u, "");
  }

  return process.env[name];
};

const scratch = mkdtempSync(join(tmpdir(), `${ID}-smoke-`));
const checked = checkPlugin(ROOT, scratch, secret);
problems.push(...checked.problems);
for (const warning of checked.warnings) console.warn(`warning: ${warning}`);

const built = join(ROOT, "dist", "view.html");
const html = existsSync(built) ? readFileSync(built, "utf8") : "";
check(!/<(script|link)[^>]+(src|href)=["']?(https?:)?\/\//iu.test(html), "view loads remote files");
// The kit's stylesheet is inlined only when the view imports ./kit.
check(
  !existsSync(join(ROOT, "ui")) || html.includes(".kit-button"),
  "view does not use the kit: import it from ./kit in ui/view.ts and build controls from it",
);

// Every result smoke sees from a tool with a view, for `bun run shots` to render.
const fixtures: Array<{ tool: string; uri: string; result: unknown }> = [];
const views: Record<string, string> = {};

// Spawn like Ziggy hands the server to Pi: Pi resolves a bare name from PATH; `bun` is the Bun
// running this script, so the same runtime is used even when PATH has another.
const connect = async (server: StdioServer, data: string) => {
  const spec = launch(server, ROOT, data, secret);
  const command =
    spec.command === "bun" ? process.execPath : (Bun.which(spec.command) ?? spec.command);
  const client = new Client({ name: "smoke", version: "0" });

  await client.connect(
    new StdioClientTransport({
      command,
      args: [...spec.args],
      cwd: spec.cwd,
      env: { ...(process.env as Record<string, string>), ...spec.env },
      stderr: "inherit",
    }),
  );

  return client;
};

const run = async (
  client: Client,
  calls: ReadonlyArray<Call>,
  record?: ReadonlyMap<string, string>,
) => {
  const ids = new Map<string, unknown>();
  const sources = (args: Record<string, unknown> = {}) =>
    Object.values(args).flatMap((value) =>
      typeof value === "object" && value !== null && "$id" in value ? [String(value.$id)] : [],
    );
  const resolveArgs = (args: Record<string, unknown> = {}) =>
    Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        key,
        typeof value === "object" && value !== null && "$id" in value
          ? ids.get(String(value.$id))
          : value,
      ]),
    );

  for (const { tool, args } of calls) {
    // Never call an external write, whatever list it also appears in.
    if (EXTERNAL_WRITES.includes(tool)) {
      check(false, `${tool}: not called, it is an external write`);
      continue;
    }

    const missing = sources(args).filter((source) => ids.get(source) === undefined);
    if (missing.length > 0) {
      console.warn(
        `warning: ${tool} skipped: ${missing.join(", ")} returned no items, so there is no id to use`,
      );
      continue;
    }

    const result = await client.callTool({ name: tool, arguments: resolveArgs(args) });
    const uri = record?.get(tool);
    if (uri) fixtures.push({ tool, uri, result });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((part) => part.text ?? "")
      .join("");
    check(!result.isError, `${tool}: ${text}`);
    check(text.trim(), `${tool}: no text result (faces without a UI show only text)`);
    console.log(`  call ${tool}: ${text.split("\n")[0]}`);
    const structured = result.structuredContent as { items?: Array<{ id?: unknown }> } | undefined;
    if (!ids.has(tool)) ids.set(tool, structured?.items?.[0]?.id);
  }
};

try {
  if (checked.stdio.length === 0) console.log("no stdio server to start: static checks only");

  for (const { key, name, server } of checked.stdio) {
    const client = await connect(server, scratch);

    try {
      const { tools } = await client.listTools();
      const ui = (tool: (typeof tools)[number]) =>
        (tool._meta?.ui ?? {}) as { resourceUri?: string; visibility?: string[] };
      console.log(`server ${name} (mcp.json "${key}"): ${tools.length} tools`);
      const listed = new Set([
        ...READS.map((call) => call.tool),
        ...LOCAL_WRITES.map((call) => call.tool),
        ...EXTERNAL_WRITES,
      ]);

      for (const tool of tools) {
        const { resourceUri, visibility = ["model", "app"] } = ui(tool);
        const external = EXTERNAL_WRITES.includes(tool.name) ? " (external write: not called)" : "";
        console.log(
          `  ${tool.name} [${visibility.join(", ")}]${resourceUri ? ` ${resourceUri}` : ""}${external}`,
        );
        check(tool.description, `tool ${tool.name} needs a description`);
        check(
          checked.stdio.length > 1 || listed.has(tool.name),
          `tool ${tool.name} is in none of READS, LOCAL_WRITES, EXTERNAL_WRITES`,
        );
      }

      // Every view must be readable, one inline HTML file of the MCP Apps type.
      for (const uri of new Set(tools.flatMap((tool) => ui(tool).resourceUri ?? []))) {
        const read = await client.readResource({ uri });
        const view = read.contents.find((content) => content.uri === uri);
        check(view?.mimeType === "text/html;profile=mcp-app", `${uri}: wrong mimeType`);
        check(
          "text" in (view ?? {}) && (view as { text: string }).text.length > 0,
          `${uri}: empty`,
        );
        if (view && "text" in view) views[uri] = view.text;
      }

      // Calls go to the first server only; split the lists per server if you have several.
      if (key === checked.stdio[0]?.key) {
        const withView = new Map(
          tools.flatMap((tool) => {
            const uri = ui(tool).resourceUri;
            return uri ? [[tool.name, uri] as const] : [];
          }),
        );
        await run(client, [...READS, ...LOCAL_WRITES, ...READS], withView);
      }
    } finally {
      await client.close();
    }
  }

  // The Profile's real data, read through a copy: the reads must still work on it after a change.
  const state = join(ROOT, "..", "..", "plugin-data", ID, "state.sqlite");
  const first = checked.stdio[0];

  if (existsSync(state) && first !== undefined) {
    const copy = mkdtempSync(join(tmpdir(), `${ID}-smoke-data-`));

    try {
      // VACUUM INTO needs a read-write handle; it may checkpoint the source's WAL but never
      // changes its data. The busy timeout waits out a running server's write.
      const source = new Database(state, { readwrite: true, create: false });
      source.run("PRAGMA busy_timeout = 5000");
      source.run("VACUUM INTO ?", [join(copy, "state.sqlite")]);
      source.close();
      console.log(`reads against a copy of plugin-data/${ID}/state.sqlite`);
      const client = await connect(first.server, copy);

      try {
        await run(client, READS);
      } finally {
        await client.close();
      }
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// Only results from the scratch run, not from the copy of the Profile's data.
mkdirSync(join(ROOT, "shots"), { recursive: true });
writeFileSync(join(ROOT, "shots", "fixtures.json"), JSON.stringify({ views, fixtures }, null, 2));

if (problems.length > 0) {
  console.error(`smoke FAILED:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
if (checked.unset.length > 0) {
  console.log(
    `smoke ok for the rest; not started until their secrets are set: ${checked.unset.join(", ")}`,
  );
} else {
  console.log("smoke ok");
}
