/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests drive the real Pi runtime through the Effect boundary. */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup owns disposable filesystem promises */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  Extensions,
  pluginMcp,
  profileResources,
  type PluginSecretsApi,
} from "ziggy/extensions/index";
import { createProfileRuntime, disposeRuntime, type ProfileRuntime } from "ziggy/session/runtime";
import { scratchProfile, treeHash, type ScratchProfile } from "../harness/profile";
import { startModelServer, tools, type ModelServer } from "../harness/provider";

const fixture = join(import.meta.dir, "fixtures/mcp-server.ts");

const SECRET = "PLUGIN_SECRET_SENTINEL_+/";

const LITERAL_TOKEN = "LITERAL_PLUGIN_TOKEN_9";

const NOT_SECRET = "production-mode";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const DOLLAR_SECRET = "tok$en$$x";

const BANG_SECRET = "!echo pwned";

/** Pi's own `resolveConfigValue`, which its MCP runtime applies to env and header values. */
const piResolveConfigValue = async (): Promise<(value: string) => string | undefined> => {
  const entry = Bun.fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));

  const module: { resolveConfigValue: (value: string) => string | undefined } = await import(
    join(dirname(entry), "core", "resolve-config-value.js")
  );

  return module.resolveConfigValue;
};

/** A Keychain stand-in: the test never touches the real Keychain. */
const store = (values: Record<string, string>): Pick<PluginSecretsApi, "get"> => ({
  get: (name) => Effect.succeed(values[name]),
});

const profiles: ScratchProfile[] = [];

const servers: ModelServer[] = [];

const runtimes: Array<{ profile: string; runtime: ProfileRuntime }> = [];

let cache = "";

const previousCache = process.env["XDG_CACHE_HOME"];

beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), "ziggy-plugin-cache-"));
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

/** `<profile>/plugins/<id>/` with a skill and the given `mcpServers`. */
const writePlugin = async (
  profile: ScratchProfile,
  id: string,
  mcpServers: Record<string, ServerEntry>,
) => {
  const root = join(profile.path, "plugins", id);
  await mkdir(join(root, "skills", id), { recursive: true });
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ $schema: PLUGIN_SCHEMA, name: id, description: `The ${id} plugin` }),
  );
  await writeFile(join(root, "mcp.json"), JSON.stringify({ $schema: MCP_SCHEMA, mcpServers }));
  await writeFile(
    join(root, "skills", id, "SKILL.md"),
    `---\nname: ${id}\ndescription: Use the ${id} plugin.\n---\n\n# ${id}\n`,
  );

  return root;
};

/** An `mcp.json` server entry as written to disk; some are deliberately invalid. */
interface ServerEntry {
  readonly type: string;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const fixtureServer: ServerEntry = {
  type: "stdio",
  command: "bun",
  args: [fixture],
  env: { FIXTURE_SECRET: "${FIXTURE_SECRET}" },
  cwd: "${PLUGIN_DATA}",
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

test("a selected plugin's server reaches a main session with its Keychain secret, redacted", async () => {
  const server = startModelServer(
    tools({
      name: "codemode",
      arguments: {
        code: `text(await tools.mcp__fixture__echo({value:"main"})); const r = await tools.mcp__fixture__secret({}); text(JSON.stringify(r)); text(JSON.stringify(await tools.mcp__literal__secret({}))); text(JSON.stringify(await tools.mcp__literal__echo({value:"${LITERAL_TOKEN}"}))); text(await tools.mcp__literal__echo({value:"${NOT_SECRET}"}));`,
      },
    }),
  );

  const profile = await profileFor(server);
  const root = await writePlugin(profile, "fixture", { fixture: fixtureServer });
  // A skill Pi would reject is skipped on its own; the plugin's other skill and its MCP stay.
  await mkdir(join(root, "skills", "Bad_Skill"));
  await writeFile(
    join(root, "skills", "Bad_Skill", "SKILL.md"),
    "---\nname: Bad_Skill\ndescription: Breaks Pi's name rule.\n---\n",
  );
  // A literal (not `${NAME}`) Bearer value in mcp.json is redacted like a Step 1 config value.
  await writePlugin(profile, "literal", {
    literal: {
      ...fixtureServer,
      env: { FIXTURE_SECRET: `Bearer ${LITERAL_TOKEN}`, MODE: NOT_SECRET },
    },
  });
  const before = await treeHash(root);
  const extensions = Effect.runSync(Extensions.make);

  // `profile_extensions` add/remove are one operation each and accept plugin ids.
  const added = await Effect.runPromise(
    extensions.add({ path: profile.path, name: "Harness" }, "fixture"),
  );

  expect(added).toMatchObject({ id: "fixture", changed: true, selected: true });
  await Effect.runPromise(extensions.add({ path: profile.path, name: "Harness" }, "literal"));

  const listing = await Effect.runPromise(extensions.listForProfile(profile.path));
  expect(listing.available).toContainEqual(
    expect.objectContaining({ id: "fixture", kind: "plugin" }),
  );

  const runtime = await open(profile, { secrets: store({ FIXTURE_SECRET: SECRET }) });
  await runtime.session.prompt("Use the plugin");

  const result = server.toolResults(1);
  expect(result).toContain("fixture:main");
  expect(result).toContain("[REDACTED]");
  expect(result).not.toContain(SECRET);
  expect(result).not.toContain(LITERAL_TOKEN);
  // A plugin env value whose name marks no credential is not redacted.
  expect(result).toContain(`fixture:${NOT_SECRET}`);
  expect(JSON.stringify(runtime.session.messages)).not.toContain(SECRET);
  // The plugin's skill joined the session; `${PLUGIN_DATA}` was its working directory.
  expect(server.raw(0)).toContain("Use the fixture plugin.");
  expect(server.raw(0)).not.toContain("Breaks Pi's name rule.");
  expect(
    await readFile(join(profile.path, "plugin-data", "fixture", ".runtime", "mcp-calls"), "utf8"),
  ).toBe("echo\nsecret\n");
  // R4: loading never touched the plugin folder.
  expect(await treeHash(root)).toBe(before);

  const removed = await Effect.runPromise(
    extensions.remove({ path: profile.path, name: "Harness" }, "fixture"),
  );

  expect(removed).toMatchObject({ id: "fixture", changed: true, selected: false });
  expect(await treeHash(root)).toBe(before);
}, 20_000);

test("a specialist without codemode never reaches a plugin server (A5)", async () => {
  const server = startModelServer(
    tools(
      { name: "codemode", arguments: { code: "text(await tools.mcp__fixture__echo({}));" } },
      { name: "mcp__fixture__echo", arguments: { value: "forged" } },
    ),
  );

  const profile = await profileFor(server);
  await writePlugin(profile, "fixture", { fixture: fixtureServer });
  await writeFile(
    join(profile.path, "extensions.json"),
    JSON.stringify({ extensions: ["fixture"] }),
  );

  const runtime = await open(profile, {
    secrets: store({ FIXTURE_SECRET: SECRET }),
    persona: { id: "specialist", body: "Read only.", tools: ["read"] },
  });

  await runtime.session.prompt("Attempt plugin tools");

  expect(runtime.session.getAllTools().some((tool) => tool.name.includes("mcp"))).toBe(false);
  expect(server.toolResults(1)).toContain("not found");
  expect(await Bun.file(join(profile.path, "plugin-data")).exists()).toBe(false);
}, 20_000);

test("plugin servers are named, resolved and skipped with value-free diagnostics", async () => {
  const profile = await profileFor(startModelServer());

  const multi = await writePlugin(profile, "multi", {
    ok: {
      ...fixtureServer,
      args: ["${PLUGIN_ROOT}/server.ts"],
      env: { FIXTURE_SECRET: "${FIXTURE_SECRET}", DOLLAR: "${DOLLAR}", BANG: "${BANG}" },
    },
    unset: { ...fixtureServer, env: { TOKEN: "${MISSING_TOKEN}" } },
    reserved: { ...fixtureServer, env: { PLUGIN_ROOT: "/tmp" } },
    outside: { ...fixtureServer, cwd: "/tmp" },
    path: { ...fixtureServer, command: "/bin/sh" },
    sse: { type: "sse", url: "https://example.test/sse" },
    http: {
      type: "streamable-http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer ${FIXTURE_SECRET}" },
    },
    plain: { type: "streamable-http", url: "http://example.test/mcp" },
    query: { type: "streamable-http", url: "https://example.test/mcp?key=${URL_KEY}" },
    hostile: { type: "streamable-http", url: "https://${HOSTILE}/mcp" },
  });

  const single = await writePlugin(profile, "single", { only: fixtureServer });
  const before = await treeHash(join(profile.path, "plugins"));

  const result = await Effect.runPromise(
    pluginMcp(
      profile.path,
      [
        { id: "multi", root: multi },
        { id: "single", root: single },
      ],
      store({
        FIXTURE_SECRET: SECRET,
        DOLLAR: DOLLAR_SECRET,
        BANG: BANG_SECRET,
        URL_KEY: "a b&c=d/e",
        HOSTILE: "user:pw@evil.test",
      }),
      ["single"],
    ),
  );

  const root = await realpath(multi);
  const data = await realpath(join(profile.path, "plugin-data", "multi"));

  expect(result.servers.map((server) => server.name)).toEqual([
    "multi_ok",
    "multi_http",
    "multi_query",
  ]);
  expect(result.servers[0]?.config).toEqual({
    command: "bun",
    args: [join(root, "server.ts")],
    cwd: data,
    env: {
      FIXTURE_SECRET: SECRET,
      DOLLAR: "tok$$en$$$$x",
      BANG: "$!echo pwned",
      PLUGIN_ROOT: root,
      PLUGIN_DATA: data,
    },
  });

  // Pi resolves `$`/`!` in env and header values; the escaped values come back unchanged.
  const env = Object.fromEntries(
    Object.entries(result.servers[0]?.config ?? {}).flatMap(([key, value]) =>
      key === "env" ? Object.entries(value) : [],
    ),
  );

  const resolve = await piResolveConfigValue();
  expect(resolve(env["DOLLAR"] ?? "")).toBe(DOLLAR_SECRET);
  expect(resolve(env["BANG"] ?? "")).toBe(BANG_SECRET);

  // `${NAME}` in a url is URI-encoded, so it cannot change the url's structure.
  expect(result.servers[2]?.config).toEqual({
    type: "http",
    url: "https://example.test/mcp?key=a%20b%26c%3Dd%2Fe",
    headers: {},
  });
  expect(result.servers[1]?.config).toEqual({
    type: "http",
    url: "https://example.test/mcp",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  expect(result.secrets).toContain(SECRET);

  const errors = result.errors.join("\n");
  expect(errors).toContain('server "unset" skipped: ${MISSING_TOKEN} is not set');
  expect(errors).toContain('server "reserved" skipped');
  expect(errors).toContain('server "outside" skipped');
  expect(errors).toContain('server "path" skipped');
  expect(errors).toContain('server "sse" skipped: transport sse is not supported');
  expect(errors).toContain('server "plain" skipped');
  expect(errors).toContain('server name "single" is already in use');
  expect(errors).toContain('server "hostile" skipped: url must be');
  expect(errors).toContain("values in the url are URI-encoded");
  expect(errors).not.toContain("evil.test");
  expect(errors).not.toContain(SECRET);
  expect(await treeHash(join(profile.path, "plugins"))).toBe(before);
});

test("an extension owns its id, and a broken unselected plugin never breaks the Profile", async () => {
  const profile = await profileFor(startModelServer());
  const extensions = Effect.runSync(Extensions.make);
  const target = { path: profile.path, name: "Harness" };

  await Effect.runPromise(extensions.add(target, "apple-notes"));
  // Unselected plugin folders: one named like the selected extension, one named like an
  // unselected bundled extension, one with a malformed manifest, and one valid plugin.
  await writePlugin(profile, "apple-notes", { only: fixtureServer });
  await writePlugin(profile, "weather", { only: fixtureServer });
  await writePlugin(profile, "valid", { only: fixtureServer });
  await mkdir(join(profile.path, "plugins", "broken"), { recursive: true });
  await writeFile(join(profile.path, "plugins", "broken", "plugin.json"), "{ not json");

  // Session open loads the extension and ignores the plugin folder.
  const resources = await Effect.runPromise(profileResources(profile.path));
  expect(resources.plugins).toEqual([]);
  expect(
    resources.skillPaths.some((file) => file.includes(join("extensions", "apple-notes"))),
  ).toBe(true);
  expect(resources.skillPaths.some((file) => file.includes("plugins"))).toBe(false);

  // Listing and show agree on the winner; the broken plugin is left out, the valid one listed.
  const listing = await Effect.runPromise(extensions.listForProfile(profile.path));
  const kinds = new Map(listing.available.map((item) => [item.id, item.kind]));
  expect(kinds.get("apple-notes")).toBe("skill");
  expect(kinds.get("weather")).not.toBe("plugin");
  expect(kinds.get("valid")).toBe("plugin");
  expect(kinds.has("broken")).toBe(false);
  expect((await Effect.runPromise(extensions.show("apple-notes", profile.path))).kind).toBe(
    "skill",
  );
  expect((await Effect.runPromise(extensions.show("weather", profile.path))).kind).not.toBe(
    "plugin",
  );

  // Selecting a shadowed plugin id is still refused, and a broken plugin cannot be selected.
  await expect(Effect.runPromise(extensions.add(target, "weather"))).rejects.toThrow(
    "names both an extension and a plugin",
  );
  await expect(Effect.runPromise(extensions.add(target, "broken"))).rejects.toThrow();

  // The selected extension that shadows plugins/apple-notes does not block other changes.
  const added = await Effect.runPromise(extensions.add(target, "valid"));
  expect(added).toMatchObject({ id: "valid", changed: true, selected: true });

  const removed = await Effect.runPromise(extensions.remove(target, "valid"));
  expect(removed).toMatchObject({ id: "valid", changed: true, selected: false });
});
