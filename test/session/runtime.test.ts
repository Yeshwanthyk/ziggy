/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests drive the real Pi runtime through the Effect boundary. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { ProfileMcpOptions } from "ziggy/extensions/index";
import { mcpLogPath } from "ziggy/extensions/mcp";
import { openSession } from "ziggy/session/index";
import { createProfileRuntime, disposeRuntime, type ProfileRuntime } from "ziggy/session/runtime";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import { startModelServer, tools, type ModelServer } from "../harness/provider";

const fixture = join(import.meta.dir, "../extensions/fixtures/mcp-server.ts");

const SECRET = "FIXTURE_SECRET_SENTINEL_+/";

const mcp = (exposure: "codemode" | "direct" | "deferred" = "codemode"): ProfileMcpOptions => ({
  servers: [
    {
      name: "fixture",
      source: "test",
      scope: "extension",
      config: {
        command: process.execPath,
        args: [fixture],
        env: { FIXTURE_SECRET: SECRET },
        exposure,
      },
    },
  ],
});

const profiles: ScratchProfile[] = [];

const servers: ModelServer[] = [];

const runtimes: Array<{ profile: string; runtime: ProfileRuntime }> = [];

let cache = "";

const previousCache = process.env["XDG_CACHE_HOME"];

beforeEach(async () => {
  // Pi's mcp.log goes to the user cache; keep test logs out of the real one.
  cache = await mkdtemp(join(tmpdir(), "ziggy-mcp-cache-"));
  process.env["XDG_CACHE_HOME"] = cache;
});

afterEach(async () => {
  for (const { profile, runtime } of runtimes.splice(0)) {
    await Effect.runPromise(disposeRuntime(profile, runtime));
  }

  for (const server of servers.splice(0)) server.stop();

  for (const profile of profiles.splice(0)) await profile.remove();

  if (previousCache === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = previousCache;

  await rm(cache, { recursive: true, force: true });
});

const profileFor = async (server: ModelServer) => {
  servers.push(server);
  const profile = await scratchProfile(server);
  profiles.push(profile);

  return profile;
};

const open = async (
  profile: ScratchProfile,
  options: Parameters<typeof createProfileRuntime>[3],
) => {
  const runtime = await Effect.runPromise(
    createProfileRuntime(
      profile.path,
      SessionManager.inMemory(profile.path),
      { kind: "local" },
      options,
    ),
  );

  runtimes.push({ profile: profile.path, runtime });
  await runtime.session.bindExtensions({ onError: () => undefined });

  return runtime;
};

/** A Profile extension that registers the fixture server at load and again once sessions start. */
const lateRegistration = async (profile: ScratchProfile) => {
  const extension = join(profile.path, "extensions", "late-mcp");
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      name: "late-mcp",
      description: "Registers an MCP server late",
      version: "1.0.0",
      type: "module",
      keywords: ["pi-package"],
      pi: { extensions: ["./index.ts"] },
    }),
  );
  const config = JSON.stringify({ command: process.execPath, args: [fixture] });
  await writeFile(
    join(extension, "index.ts"),
    `export default function(pi){pi.registerMcpServer("early",${config});pi.on("session_start",()=>pi.registerMcpServer("late",${config}));pi.on("before_agent_start",()=>{pi.registerMcpServer("turn",${config});});}`,
  );
  await writeFile(
    join(profile.path, "extensions.json"),
    JSON.stringify({ extensions: ["late-mcp"] }),
  );
};

const noMcpTools = (runtime: ProfileRuntime) =>
  runtime.session
    .getAllTools()
    .map((tool) => tool.name)
    .filter(
      (name) =>
        name === "codemode" ||
        name === "tool_search" ||
        name.startsWith("mcp__") ||
        name.includes("mcp_resource"),
    );

test("main session calls a Ziggy-supplied stdio server through Pi codemode", async () => {
  const server = startModelServer(
    tools({
      name: "codemode",
      arguments: { code: 'text(await tools.mcp__fixture__echo({value:"main"}));' },
    }),
  );

  const profile = await profileFor(server);
  const runtime = await open(profile, { mcp: mcp() });
  await runtime.session.prompt("Use the fixture");

  expect(server.toolResults(1)).toContain("fixture:main");
  expect(await readFile(join(profile.path, ".runtime", "mcp-calls"), "utf8")).toBe("echo\n");
  expect(runtime.session.getActiveToolNames()).toContain("codemode");
  expect(runtime.session.getCallableToolNames()).toContain("mcp__fixture__echo");
  // Pi's plaintext log lives in the user cache, never in the Profile.
  expect(mcpLogPath(profile.path).startsWith(cache)).toBe(true);
  expect(await readFile(mcpLogPath(profile.path), "utf8")).toContain("fixture ready");
  expect(await Bun.file(join(profile.path, "mcp.log")).exists()).toBe(false);
  expect(await Bun.file(join(profile.path, ".runtime", "mcp.log")).exists()).toBe(false);
}, 15_000);

test.each(["specialist", "automation"] as const)(
  "%s without codemode or mcp__ tools never sees or calls MCP tools, even after late registration",
  async (kind) => {
    const server = startModelServer(
      tools(
        { name: "codemode", arguments: { code: "text(await tools.mcp__late__echo({}));" } },
        { name: "mcp__late__echo", arguments: { value: "forged" } },
        { name: "mcp__fixture__echo", arguments: { value: "forged" } },
      ),
    );

    const profile = await profileFor(server);
    await lateRegistration(profile);

    const runtime = await open(
      profile,
      kind === "specialist"
        ? { mcp: mcp(), persona: { id: "specialist", body: "Read only.", tools: ["read"] } }
        : { mcp: mcp("direct"), automation: true },
    );

    await runtime.session.prompt("Attempt MCP tools");
    runtime.session.setActiveToolsByName(["read", "codemode", "mcp__late__echo", "tool_search"]);
    await runtime.session.reload();
    await runtime.session.prompt("Try again after reload");

    expect(noMcpTools(runtime)).toEqual([]);
    expect(runtime.session.getCallableToolNames().filter((name) => name.includes("mcp"))).toEqual(
      [],
    );
    expect(server.toolResults(1)).toContain("not found");
    expect(await Bun.file(join(profile.path, ".runtime", "mcp-calls")).exists()).toBe(false);
    expect(await Bun.file(mcpLogPath(profile.path)).exists()).toBe(false);
  },
  15_000,
);

test("a specialist's mcp__ tools wait for their server; an unknown one fails as an unknown tool", async () => {
  const server = startModelServer(
    tools(
      {
        name: "codemode",
        arguments: {
          code: 'text(ALL_TOOLS); text(await tools.mcp__fixture__echo({value:"allowed"}));',
        },
      },
      { name: "mcp__fixture__missing", arguments: {} },
    ),
  );

  const profile = await profileFor(server);

  const handle = await Effect.runPromise(
    openSession(
      {
        target: { path: profile.path, name: "Harness" },
        directory: join(profile.path, "sessions"),
        session: "new",
        context: { kind: "local" },
        persona: {
          id: "specialist",
          body: "Use the fixture.",
          tools: ["codemode", "mcp__fixture__echo", "mcp__fixture__missing"],
        },
      },
      { mcp: mcp() },
    ),
  );

  try {
    await Effect.runPromise(handle.prompt("Call the allowed tool"));
  } finally {
    await Effect.runPromise(handle.dispose);
  }

  expect(server.toolResults(1)).toContain("fixture:allowed");
  expect(server.toolResults(1)).toContain("not found");
  expect(server.raw(0)).not.toContain("mcp__fixture__secret");
}, 15_000);

test("Profile and cwd MCP files never supply configuration", async () => {
  const server = startModelServer();
  const profile = await profileFor(server);

  const ambient = JSON.stringify({
    mcpServers: { ambient: { command: process.execPath, args: [fixture] } },
  });

  await mkdir(join(profile.path, ".pi"));
  await writeFile(join(profile.path, "mcp.json"), ambient);
  await writeFile(join(profile.path, ".pi", "mcp.json"), ambient);
  const runtime = await open(profile, {});
  await runtime.session.prompt("Hello");

  expect(runtime.session.getActiveToolNames()).not.toContain("codemode");
  expect(runtime.session.getAllTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
  expect(await Bun.file(join(profile.path, ".runtime", "mcp-calls")).exists()).toBe(false);
}, 15_000);

test("MCP tools reconnect after session reload and remain callable through codemode", async () => {
  const server = startModelServer(
    tools({
      name: "codemode",
      arguments: { code: 'text(await tools.mcp__fixture__echo({value:"before"}));' },
    }),
  );

  const profile = await profileFor(server);
  const runtime = await open(profile, { mcp: mcp() });
  await runtime.session.prompt("Before reload");
  expect(server.toolResults(1)).toContain("fixture:before");
  await runtime.session.reload();
  server.push(
    tools({
      name: "codemode",
      arguments: { code: 'text(await tools.mcp__fixture__echo({value:"after"}));' },
    }),
  );
  await runtime.session.prompt("After reload");
  expect(server.toolResults(3)).toContain("fixture:after");
  expect(await readFile(join(profile.path, ".runtime", "mcp-calls"), "utf8")).toBe("echo\necho\n");
}, 15_000);

test.each(["direct", "codemode"] as const)(
  "a credential a server echoes back is redacted from %s results",
  async (exposure) => {
    const server = startModelServer(
      tools(
        exposure === "direct"
          ? { name: "mcp__fixture__secret", arguments: {} }
          : {
              name: "codemode",
              arguments: {
                code: "const r = await tools.mcp__fixture__secret({}); text(JSON.stringify(r));",
              },
            },
      ),
    );

    const profile = await profileFor(server);
    const runtime = await open(profile, { mcp: mcp(exposure) });
    const results: string[] = [];

    runtime.session.subscribe((event) => {
      if (event.type === "tool_execution_end") results.push(JSON.stringify(event.result));
    });

    await runtime.session.prompt("Use the fixture");

    const surfaces = [server.toolResults(1), ...results, JSON.stringify(runtime.session.messages)];

    expect(await readFile(join(profile.path, ".runtime", "mcp-calls"), "utf8")).toBe("secret\n");
    expect(server.toolResults(1)).toContain("[REDACTED]");
    expect(results.join("\n")).toContain('"credential":"[REDACTED]"');

    for (const surface of surfaces) {
      expect(surface).not.toContain(SECRET);
      expect(surface).not.toContain(JSON.stringify(SECRET).slice(1, -1));
    }
  },
  15_000,
);
