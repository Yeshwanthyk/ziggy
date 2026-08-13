import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createProfileExtensionSelectionRunner } from "./profile-extension-selection";

const writePackage = async (
  shelfOwnerPath: string,
  id: string,
  description: string,
): Promise<void> => {
  const packagePath = join(shelfOwnerPath, "extensions", id);
  const skillPath = join(packagePath, "skills", id);
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(skillPath, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n`,
  );
  await writeFile(
    join(packagePath, "package.json"),
    JSON.stringify({
      name: `@ziggy/${id}`,
      description,
      pi: { skills: ["./skills"] },
    }),
  );
};

test("the TUI selection runner lists optional packages and atomically saves a full set", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-extension-runner-"));
  const repositoryRoot = join(root, "repository");
  const profilePath = join(root, "profile");
  try {
    await mkdir(profilePath, { recursive: true });
    await writePackage(profilePath, "gamma", "Profile-owned extension");
    await writePackage(profilePath, "alpha", "Profile-owned Alpha");
    await writeFile(join(profilePath, "extensions.json"), '{"extensions":["alpha"]}\n');

    const installed: string[] = [];
    const deactivated: string[] = [];
    const runner = createProfileExtensionSelectionRunner(profilePath, repositoryRoot, {
      list: () =>
        Effect.succeed([
          {
            id: "alpha",
            description: "Alpha extension",
            kind: "skill",
            required: false,
            source: "bundled",
          },
          {
            id: "weather",
            description: "Weather extension",
            kind: "skill",
            required: false,
            source: "bundled",
          },
          {
            id: "pi-packages",
            description: "Required package",
            kind: "skill",
            required: true,
            source: "bundled",
          },
          {
            id: "remote",
            description: "Remote approved extension",
            kind: "remote",
            required: false,
            source: "remote-approved",
          },
        ]),
      ensureInstalled: (_profilePath, _repositoryRoot, id) =>
        Effect.gen(function* () {
          installed.push(id);
          if (id === "remote") {
            yield* Effect.promise(() =>
              writePackage(profilePath, "remote", "Remote approved extension"),
            );
            return join(profilePath, "extensions", "remote");
          }
          return id === "weather" ? "extensions/weather" : repositoryRoot;
        }),
      deactivate: (_profilePath, _repositoryRoot, id) =>
        Effect.sync(() => {
          deactivated.push(id);
        }),
    });
    expect(await runner.list()).toEqual({
      available: [
        { id: "alpha", description: "Profile-owned Alpha", kind: "skill", source: "profile" },
        {
          id: "gamma",
          description: "Profile-owned extension",
          kind: "skill",
          source: "profile",
        },
        {
          id: "remote",
          description: "Remote approved extension",
          kind: "remote",
          source: "remote-approved",
        },
        { id: "weather", description: "Weather extension", kind: "skill", source: "bundled" },
      ],
      selected: ["alpha"],
    });
    expect(await runner.setSelected(["weather", "gamma", "remote"])).toEqual({
      changed: true,
      selected: ["gamma", "remote", "weather"],
    });
    expect(installed).toEqual(["gamma", "remote", "weather"]);
    expect(deactivated).toEqual(["alpha"]);
    expect(await readFile(join(profilePath, "extensions.json"), "utf8")).toBe(
      '{\n  "extensions": [\n    "gamma",\n    "remote",\n    "weather"\n  ]\n}\n',
    );
    expect(await runner.setSelected(["remote", "gamma", "weather"])).toEqual({
      changed: false,
      selected: ["gamma", "remote", "weather"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
