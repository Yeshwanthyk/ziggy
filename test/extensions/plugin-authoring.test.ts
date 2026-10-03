/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests drive Ziggy through the Effect boundary. */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup owns disposable filesystem promises */
// The plugin template's smoke.ts checks plugins with its own copy of Ziggy's rules (it must run
// from any Profile, without Ziggy). These cases keep that copy in agreement with plugin.ts.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Extensions, pluginMcp } from "ziggy/extensions/index";
import { checkPlugin } from "../../extensions/plugin-authoring/skills/plugin-authoring/template/rules";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/** Keychain values for both sides; the real Keychain is never read. */
const SECRETS = new Map([["AUTHORING_TEST_TOKEN", "token"]]);

const profiles: string[] = [];

afterEach(async () => {
  for (const profile of profiles.splice(0)) await rm(profile, { recursive: true, force: true });
});

/** A scratch Profile holding `plugins/sample/` with these plugin.json and mcp.json texts. */
const plugin = async (manifest: string, mcp?: string) => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-plugin-authoring-"));
  profiles.push(profile);
  const root = join(profile, "plugins", "sample");
  const data = join(profile, "plugin-data", "sample");
  await mkdir(root, { recursive: true });
  await mkdir(data, { recursive: true });
  // A Profile as far as `extensions.show` checks (scratch, so never a real Profile).
  await writeFile(join(profile, "SOUL.md"), "");
  await writeFile(join(root, "plugin.json"), manifest);
  await writeFile(join(root, "server.ts"), "");

  if (mcp !== undefined) await writeFile(join(root, "mcp.json"), mcp);

  return { profile, root, data };
};

const manifest = { $schema: PLUGIN_SCHEMA, name: "sample" };

const stdio = { type: "stdio", command: "bun", args: ["${PLUGIN_ROOT}/server.ts"] };

const remote = { type: "streamable-http", url: "https://example.test/mcp" };

const servers = {
  "valid stdio": stdio,
  "valid stdio, ./ command and data cwd": {
    ...stdio,
    command: "./server.ts",
    cwd: "${PLUGIN_DATA}/x",
  },
  "extra stdio key": { ...stdio, timeout: 5 },
  "stdio with a url": { ...stdio, url: "https://example.test" },
  "absolute command": { ...stdio, command: "/bin/sh" },
  "empty command": { ...stdio, command: "" },
  "cwd outside": { ...stdio, cwd: "/tmp" },
  "cwd escapes the root": { ...stdio, cwd: "./../.." },
  "env sets PLUGIN_ROOT": { ...stdio, env: { PLUGIN_ROOT: "/x" } },
  "env secret set": { ...stdio, env: { TOKEN: "${AUTHORING_TEST_TOKEN}" } },
  "env secret unset": { ...stdio, env: { TOKEN: "${AUTHORING_TEST_UNSET_9}" } },
  "valid remote": remote,
  "extra remote key": { ...remote, env: {} },
  "remote http on loopback": { ...remote, url: "http://127.0.0.1:4000/mcp" },
  "remote http elsewhere": { ...remote, url: "http://example.test/mcp" },
  "remote with credentials": { ...remote, url: "https://user:pw@example.test/mcp" },
  "remote sse": { ...remote, type: "sse" },
  "duplicate headers": { ...remote, headers: { "X-Key": "a", "x-key": "b" } },
  "remote secret in header": { ...remote, headers: { Authorization: "${AUTHORING_TEST_TOKEN}" } },
  "remote secret unset": { ...remote, headers: { Authorization: "${AUTHORING_TEST_UNSET_9}" } },
  "unknown type": { type: "websocket", url: "wss://example.test" },
};

test("smoke's rules skip exactly the servers Ziggy skips", async () => {
  for (const [label, server] of Object.entries(servers)) {
    for (const key of ["server", "bad key"]) {
      const { profile, root, data } = await plugin(
        JSON.stringify(manifest),
        JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { [key]: server } }),
      );

      const ziggy = await Effect.runPromise(
        pluginMcp(profile, [{ id: "sample", root }], {
          get: (name) => Effect.succeed(SECRETS.get(name)),
        }),
      );

      const smoke = checkPlugin(root, data, (name) => SECRETS.get(name) ?? process.env[name]);

      expect({
        label,
        key,
        loads: smoke.problems.length === 0 && smoke.unset.length === 0,
      }).toEqual({
        label,
        key,
        loads: ziggy.servers.length === 1,
      });
    }
  }
});

test("smoke's rules disable MCP for exactly the mcp.json files Ziggy disables", async () => {
  const files = {
    valid: { $schema: MCP_SCHEMA, mcpServers: { server: stdio } },
    "no $schema": { mcpServers: { server: stdio } },
    "wrong $schema": { $schema: PLUGIN_SCHEMA, mcpServers: { server: stdio } },
    "extra key": { $schema: MCP_SCHEMA, mcpServers: { server: stdio }, inputs: [] },
    "servers not an object": { $schema: MCP_SCHEMA, mcpServers: [] },
  };

  for (const [label, file] of Object.entries(files)) {
    const { profile, root, data } = await plugin(JSON.stringify(manifest), JSON.stringify(file));

    const ziggy = await Effect.runPromise(
      pluginMcp(profile, [{ id: "sample", root }], { get: () => Effect.succeed(undefined) }),
    );

    const smoke = checkPlugin(root, data, () => undefined);

    expect({ label, loads: smoke.problems.length === 0 }).toEqual({
      label,
      loads: ziggy.servers.length === 1,
    });
  }
});

test("smoke's rules reject exactly the plugin.json files Ziggy rejects", async () => {
  const extensions = Effect.runSync(Extensions.make);

  const manifests = {
    valid: manifest,
    "unknown field (ignored)": { ...manifest, icon: "x.png" },
    "extensions not an object (ignored)": { ...manifest, extensions: [] },
    "no $schema": { name: "sample" },
    "wrong $schema": { ...manifest, $schema: MCP_SCHEMA },
    "extra author key": { ...manifest, author: { name: "a", handle: "b" } },
    "keywords not strings": { ...manifest, keywords: [1] },
    "bad name": { ...manifest, name: "Sample" },
  };

  for (const [label, file] of Object.entries(manifests)) {
    const { profile, root, data } = await plugin(JSON.stringify(file));

    const ziggy = await Effect.runPromise(Effect.result(extensions.show("sample", profile)));

    const smoke = checkPlugin(root, data, () => undefined);

    expect({ label, loads: smoke.problems.length === 0 }).toEqual({
      label,
      loads: ziggy._tag === "Success",
    });
  }
});

test("smoke names servers as Ziggy does: <id> alone, <id>_<key> for several", async () => {
  const { profile, root, data } = await plugin(
    JSON.stringify(manifest),
    JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { read: stdio, write: stdio } }),
  );

  const ziggy = await Effect.runPromise(
    pluginMcp(profile, [{ id: "sample", root }], { get: () => Effect.succeed(undefined) }),
  );

  const smoke = checkPlugin(root, data, () => undefined);

  expect(smoke.stdio.map((server) => server.name)).toEqual(
    ziggy.servers.map((server) => server.name),
  );
  expect(smoke.stdio.map((server) => server.name)).toEqual(["sample_read", "sample_write"]);
});

test("smoke's rules accept exactly the skill frontmatter both Pi and Ziggy load", async () => {
  const extensions = Effect.runSync(Extensions.make);
  const name = "name: sample";
  const description = "description: Keep the list. Use when they ask about items.";
  const body = "\n\nBody.\n";

  const files = {
    plain: `---\n${name}\n${description}\n---${body}`,
    quoted: `---\n${name}\ndescription: "Use when: they ask about items"\n---${body}`,
    "unquoted colon (invalid YAML)": `---\n${name}\ndescription: Use when: x\n---${body}`,
    empty: `---\n${name}\ndescription: ""\n---${body}`,
    folded: `---\n${name}\ndescription: >\n  Keep the list.\n  Use when asked.\n---${body}`,
    "duplicate description": `---\n${name}\n${description}\n${description}\n---${body}`,
    "comment after the name": `---\nname: sample # c\n${description}\n---${body}`,
    "leading BOM": `\uFEFF---\n${name}\n${description}\n---${body}`,
    "closing ---more": `---\n${name}\n${description}\n---more${body}`,
  };

  for (const [label, text] of Object.entries(files)) {
    const { profile, root, data } = await plugin(JSON.stringify(manifest));
    const folder = join(root, "skills", "sample");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), text);

    const pi = loadSkillsFromDir({ dir: join(root, "skills"), source: "test" });
    const piLoads = pi.skills.length === 1 && pi.diagnostics.length === 0;

    const ziggy = await Effect.runPromise(extensions.show("sample", profile));
    const ziggyLoads = ziggy.skills.length === 1;

    const smoke = checkPlugin(root, data, () => undefined);

    expect({ label, loads: smoke.problems.length === 0 }).toEqual({
      label,
      loads: piLoads && ziggyLoads,
    });
  }
});
