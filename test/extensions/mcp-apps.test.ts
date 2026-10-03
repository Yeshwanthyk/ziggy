/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests drive the real Pi runtime through the Effect boundary. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProfileMcpOptions } from "ziggy/extensions/index";
import { openSession, type ChatEvent } from "ziggy/session/index";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import { startModelServer, tools, type ModelServer } from "../harness/provider";

const fixture = join(import.meta.dir, "fixtures/mcp-server.ts");

const VIEW = "ui://fixture/view.html";

const OTHER_VIEW = "ui://other/view.html";

const server = (name: string, view: string, exposure: "direct" | "codemode" = "direct") => ({
  name,
  source: "test",
  scope: "extension" as const,
  config: {
    command: process.execPath,
    args: [fixture],
    env: { FIXTURE_VIEW: view },
    exposure,
  },
});

const mcp: ProfileMcpOptions = { servers: [server("fixture", VIEW), server("other", OTHER_VIEW)] };

let profile: ScratchProfile | undefined;

let model: ModelServer | undefined;

let cache = "";

const previousCache = process.env["XDG_CACHE_HOME"];

beforeEach(async () => {
  // Pi's mcp.log goes to the user cache; keep test logs out of the real one.
  cache = await mkdtemp(join(tmpdir(), "ziggy-mcp-apps-cache-"));
  process.env["XDG_CACHE_HOME"] = cache;
});

afterEach(async () => {
  model?.stop();
  await profile?.remove();

  if (previousCache === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = previousCache;

  await rm(cache, { recursive: true, force: true });
});

test("a view reaches only its own server's app tools; app-only tools stay hidden from the model", async () => {
  model = startModelServer(tools({ name: "mcp__fixture__view", arguments: { value: "shown" } }));
  profile = await scratchProfile(model);

  const handle = await Effect.runPromise(
    openSession(
      {
        target: { path: profile.path, name: "Harness" },
        directory: join(profile.path, "sessions"),
        session: "new",
        context: { kind: "local" },
      },
      { mcp },
    ),
  );

  const events: ChatEvent[] = [];
  handle.subscribe((event) => events.push(event));

  try {
    const reply = await Effect.runPromise(handle.prompt("Show the view"));

    // G7: the model sees `view` and `model_only`, never `app_only`.
    const offered = model.request(0).tools?.map((tool) => tool.function.name) ?? [];
    expect(offered).toContain("mcp__fixture__view");
    expect(offered).toContain("mcp__fixture__model_only");
    expect(offered.some((name) => name.endsWith("__app_only"))).toBe(false);
    expect(offered.some((name) => name.endsWith("__bad_ui"))).toBe(false);

    // The tool event carries the view record; the reply itself is never changed by the session.
    const end = events.find((event) => event.kind === "tool" && event.phase === "end");
    expect(end?.kind === "tool" ? end.app : undefined).toEqual({
      server: "fixture",
      tool: "view",
      resourceUri: VIEW,
      input: { value: "shown" },
      result: {
        content: [{ type: "text", text: "fixture:shown" }],
        structuredContent: { tool: "view", value: "shown" },
      },
    });
    expect(reply).not.toContain("web UI");

    const initialize = await readFile(join(profile.path, ".runtime", "mcp-initialize"), "utf8");
    expect(initialize).toContain('"io.modelcontextprotocol/ui"');

    // The view calls its own app-only tool and reads its own resource.
    const called = await Effect.runPromise(
      handle.callAppTool("fixture", VIEW, "app_only", { value: "from-view" }),
    );

    expect(called).toMatchObject({ structuredContent: { tool: "app_only", value: "from-view" } });

    const page = await Effect.runPromise(handle.readAppResource("fixture", VIEW));
    expect(JSON.stringify(page)).toContain("text/html;profile=mcp-app");

    const refusal = (effect: Effect.Effect<unknown, { readonly reason: string }>) =>
      Effect.runPromise(Effect.flip(effect)).then((error) => error.reason);

    // A model-only tool, another server's view, an undeclared resource and an unknown server.
    expect(await refusal(handle.callAppTool("fixture", VIEW, "model_only", {}))).toBe(
      "not-app-tool",
    );
    expect(await refusal(handle.callAppTool("other", VIEW, "app_only", {}))).toBe(
      "not-app-resource",
    );
    expect(await refusal(handle.readAppResource("fixture", OTHER_VIEW))).toBe("not-app-resource");
    expect(await refusal(handle.callAppTool("missing", VIEW, "app_only", {}))).toBe(
      "unknown-server",
    );

    expect(await readFile(join(profile.path, ".runtime", "mcp-calls"), "utf8")).toBe(
      "view\napp_only\n",
    );
  } finally {
    await Effect.runPromise(handle.dispose);
  }
}, 20_000);

test("a codemode script carries the view of the MCP call it made", async () => {
  model = startModelServer(
    tools({
      name: "codemode",
      arguments: {
        code: 'text(await tools.mcp__fixture__echo({value:"a"})); text(await tools.mcp__fixture__view({value:"b"}));',
      },
    }),
  );
  profile = await scratchProfile(model);

  const handle = await Effect.runPromise(
    openSession(
      {
        target: { path: profile.path, name: "Harness" },
        directory: join(profile.path, "sessions"),
        session: "new",
        context: { kind: "local" },
      },
      { mcp: { servers: [server("fixture", VIEW, "codemode")] } },
    ),
  );

  const events: ChatEvent[] = [];
  handle.subscribe((event) => events.push(event));

  try {
    await Effect.runPromise(handle.prompt("Show the view"));

    // Nested calls stream live but only the script's own result is kept, so it holds the view.
    const ends = events.filter((event) => event.kind === "tool" && event.phase === "end");
    expect(ends.map((event) => (event.kind === "tool" ? event.toolName : ""))).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__view",
      "codemode",
    ]);
    expect(ends.filter((event) => event.kind === "tool" && event.app !== undefined)).toEqual([
      expect.objectContaining({
        toolName: "codemode",
        app: expect.objectContaining({ tool: "view", resourceUri: VIEW, input: { value: "b" } }),
      }),
    ]);
  } finally {
    await Effect.runPromise(handle.dispose);
  }
}, 20_000);

test("G7 under codemode: the script's tools list leaves out app-only tools and cannot call them", async () => {
  model = startModelServer(
    tools({
      name: "codemode",
      arguments: {
        code: 'try { await tools.mcp__fixture__app_only({value:"x"}); text("called"); } catch { text("refused"); }',
      },
    }),
  );
  profile = await scratchProfile(model);

  const handle = await Effect.runPromise(
    openSession(
      {
        target: { path: profile.path, name: "Harness" },
        directory: join(profile.path, "sessions"),
        session: "new",
        context: { kind: "local" },
      },
      { mcp: { servers: [server("fixture", VIEW, "codemode")] } },
    ),
  );

  try {
    await Effect.runPromise(handle.prompt("Use the app-only tool"));

    // The codemode listing the model reads names the view tool but never the app-only ones.
    const listing = model.raw(0);
    expect(listing).toContain("mcp__fixture__view");
    expect(listing).not.toContain("app_only");
    expect(listing).not.toContain("bad_ui");
    expect(model.toolResults(1)).toContain("refused");
    expect(
      await readFile(join(profile.path, ".runtime", "mcp-calls"), "utf8").catch(() => ""),
    ).toBe("");
  } finally {
    await Effect.runPromise(handle.dispose);
  }
}, 20_000);
