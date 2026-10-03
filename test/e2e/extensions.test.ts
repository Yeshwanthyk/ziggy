/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { hashTree } from "ziggy/platform/tree";
import { ziggy, ziggyWith } from "../harness/cli";
import { scratchProfile, type ScratchProfile, treeHash } from "../harness/profile";
import { type ModelServer, startModelServer, text, tools } from "../harness/provider";
import { startResident, stopResidents } from "../harness/resident";

let server: ModelServer;

let profile: ScratchProfile;

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
});

afterEach(async () => {
  await stopResidents();
  server.stop();
  await profile.remove();
});

const shelf = (id: string) => join(profile.path, "extensions", id);

const selection = () => readFile(join(profile.path, "extensions.json"), "utf8").catch(() => "");

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** A Profile-only code package whose tool answers with `marker`, or whose import throws. */
const writeCodePackage = async (id: string, body: string) => {
  await mkdir(shelf(id), { recursive: true });
  await writeFile(
    join(shelf(id), "package.json"),
    JSON.stringify({
      name: id,
      version: "0.0.1",
      description: `The ${id} probe package.`,
      type: "module",
      keywords: ["pi-package"],
      pi: { extensions: ["./index.ts"] },
    }),
  );
  await writeFile(join(shelf(id), "index.ts"), body);
};

const probeTool = (marker: string) => `
export default function (pi) {
  pi.registerTool({
    name: "probe",
    label: "probe",
    description: "Returns a fixed marker.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: "${marker}" }], details: {} };
    },
  });
}
`;

const receiptFile = (id: string) =>
  join(profile.path, ".runtime", "extension-updates", id, "receipt.json");

/** Rewrite the receipt as if the current bytes had come from an older bundled build. */
const pinReceiptToCurrentBytes = async (id: string) => {
  const receipt = JSON.parse(await readFile(receiptFile(id), "utf8"));
  const contentHash = await Effect.runPromise(hashTree(shelf(id)));
  await writeFile(receiptFile(id), JSON.stringify({ ...receipt, contentHash }));
};

const toolNames = (index: number) =>
  (server.request(index).tools ?? []).map((tool) => tool.function.name);

describe("adding and removing", () => {
  test("an unknown id is refused and the selection and shelf are untouched", async () => {
    const result = await ziggy(profile, "extensions", "add", profile.path, "no-such-package");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no-such-package");
    expect(await exists(join(profile.path, "extensions.json"))).toBe(false);
    expect(await exists(join(profile.path, "extensions"))).toBe(false);
  });

  test("a package that fails to load is refused and the selection keeps its bytes", async () => {
    await writeFile(join(profile.path, "extensions.json"), '{ "extensions": [] }\n');
    await writeCodePackage("broken", 'throw new Error("BROKEN_AT_IMPORT");\n');
    const before = await treeHash(join(profile.path, "extensions"));
    const selected = await selection();

    const result = await ziggy(profile, "extensions", "add", profile.path, "broken");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("preflight failed");
    expect(await selection()).toBe(selected);
    expect(await treeHash(join(profile.path, "extensions"))).toBe(before);
  });

  test("an added tool is offered to the next run and answers the model", async () => {
    await writeCodePackage("probe", probeTool("PROBE_MARKER_5c1"));

    const added = await ziggy(profile, "extensions", "add", profile.path, "probe");
    expect(added.exitCode).toBe(0);

    server.push(tools({ name: "probe", arguments: {} }), text("done"));
    const run = await ziggy(profile, "run", profile.path, "use the probe");

    expect(run.exitCode).toBe(0);
    expect(toolNames(0)).toContain("probe");
    expect(server.toolResults(1)).toContain("PROBE_MARKER_5c1");
  });

  test("the model adds a bundled package in-process, with no PATH to shell out through", async () => {
    server.push(
      tools({ name: "profile_extensions", arguments: { action: "add", id: "weather" } }),
      text("added"),
    );
    const run = await ziggyWith(profile, { PATH: "" }, "run", profile.path, "add weather");

    expect(run.exitCode).toBe(0);
    expect(server.toolResults(1)).toContain("selected Profile extension 'weather'");
    expect(JSON.parse(await selection())).toEqual({ extensions: ["weather"] });
    expect(await exists(join(shelf("weather"), "package.json"))).toBe(true);
  });
});

describe("opening a session", () => {
  test("a selected package that fails to load is skipped with a warning, and doctor names it", async () => {
    await writeCodePackage("broken", 'throw new Error("BROKEN_AT_IMPORT");\n');
    await writeFile(join(profile.path, "extensions.json"), '{ "extensions": ["broken"] }\n');

    const run = await ziggy(profile, "run", profile.path, "hi");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("ok\n");
    expect(run.stderr).toContain("broken");

    const doctor = await ziggy(profile, "doctor", profile.path);

    expect(doctor.stdout).toContain("BROKEN Profile packages skipped: broken");
  });

  test("a Profile package with a bundled id wins over the bundled text", async () => {
    await mkdir(join(shelf("weather"), "skills", "weather"), { recursive: true });
    await writeFile(
      join(shelf("weather"), "package.json"),
      JSON.stringify({
        name: "weather",
        description: "Local weather.",
        keywords: ["pi-package"],
        pi: { skills: ["./skills"] },
      }),
    );
    await writeFile(
      join(shelf("weather"), "skills", "weather", "SKILL.md"),
      "---\nname: weather\ndescription: LOCAL_WEATHER_MARKER_e2\n---\n\nLocal weather.\n",
    );
    await writeFile(join(profile.path, "extensions.json"), '{ "extensions": ["weather"] }\n');

    const run = await ziggy(profile, "run", profile.path, "hi");

    expect(run.exitCode).toBe(0);
    expect(server.raw(0)).toContain("LOCAL_WEATHER_MARKER_e2");
  });

  test("the model can read a required package's references from Ziggy's cache", async () => {
    await ziggy(profile, "run", profile.path, "hi");

    const location = /<location>([^<]*ziggy-operations[^<]*SKILL\.md)<\/location>/.exec(
      server.raw(0),
    )?.[1];

    expect(location).toBeDefined();
    expect(location?.startsWith(profile.path)).toBe(false);

    server.push(tools({ name: "read", arguments: { path: location ?? "" } }), text("read it"));
    const run = await ziggy(profile, "run", profile.path, "read the operations skill");

    expect(run.exitCode).toBe(0);
    expect(server.toolResults(2)).toContain("name: ziggy-operations");
  });
});

describe("updating a bundled copy", () => {
  beforeEach(async () => {
    expect((await ziggy(profile, "extensions", "add", profile.path, "weather")).exitCode).toBe(0);
  });

  const skill = () => join(shelf("weather"), "skills", "weather", "SKILL.md");

  test("an unchanged copy is already current", async () => {
    const result = await ziggy(profile, "extensions", "update", profile.path, "weather");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("current weather");
  });

  test("an older managed copy is replaced with this build's bytes", async () => {
    const bundled = await readFile(skill(), "utf8");
    await writeFile(skill(), `${bundled}\nOLDER_BUILD\n`);
    await pinReceiptToCurrentBytes("weather");

    const result = await ziggy(profile, "extensions", "update", profile.path, "weather");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("updated weather");
    expect(await readFile(skill(), "utf8")).toBe(bundled);
    expect(await exists(`${shelf("weather")}.old`)).toBe(false);
  });

  test("local edits are refused and kept", async () => {
    await writeFile(skill(), "LOCAL EDIT\n");
    const before = await treeHash(shelf("weather"));

    const result = await ziggy(profile, "extensions", "update", profile.path, "weather");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("reason=modified");
    expect(await treeHash(shelf("weather"))).toBe(before);
  });

  test("an untracked copy needs --adopt", async () => {
    await rm(receiptFile("weather"));

    const refused = await ziggy(profile, "extensions", "update", profile.path, "weather");

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("reason=unmanaged");

    const adopted = await ziggy(
      profile,
      "extensions",
      "update",
      profile.path,
      "weather",
      "--adopt",
    );

    expect(adopted.exitCode).toBe(0);
    expect(adopted.stdout).toStartWith("adopted weather");
    expect(await exists(receiptFile("weather"))).toBe(true);
  });

  test("a running resident refuses the update", async () => {
    const resident = await startResident(profile);

    const result = await ziggy(profile, "extensions", "update", profile.path, "weather");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("reason=resident");
    await resident.stop();
  });

  test("an update that published but lost its receipt is current on the next run", async () => {
    const receipt = JSON.parse(await readFile(receiptFile("weather"), "utf8"));
    await writeFile(
      receiptFile("weather"),
      JSON.stringify({ ...receipt, contentHash: "0".repeat(64) }),
    );

    const result = await ziggy(profile, "extensions", "update", profile.path, "weather");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("current weather");
    expect(JSON.parse(await readFile(receiptFile("weather"), "utf8")).contentHash).not.toBe(
      "0".repeat(64),
    );
  });

  test("doctor reports a copy left at <id>.old without moving it", async () => {
    await rename(shelf("weather"), `${shelf("weather")}.old`);

    const doctor = await ziggy(profile, "doctor", profile.path);

    expect(doctor.stdout).toContain("ERROR\tresources");
    expect(await exists(`${shelf("weather")}.old`)).toBe(true);
    expect(await exists(shelf("weather"))).toBe(false);
  });

  test("update puts a copy left at <id>.old back before it checks the shelf", async () => {
    await rename(shelf("weather"), `${shelf("weather")}.old`);

    const result = await ziggy(profile, "extensions", "update", profile.path, "weather");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("current weather");
    expect(await exists(`${shelf("weather")}.old`)).toBe(false);
  });

  test("a copy left only at <id>.old by an interrupted swap is put back on open", async () => {
    await rename(shelf("weather"), `${shelf("weather")}.old`);

    const run = await ziggy(profile, "run", profile.path, "hi");

    expect(run.exitCode).toBe(0);
    expect(await exists(join(shelf("weather"), "package.json"))).toBe(true);
    expect(await exists(`${shelf("weather")}.old`)).toBe(false);
  });
});
