import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileExtensionSelectionRunner } from "./profile-extension-selection";

const writePackage = async (
  repositoryRoot: string,
  id: string,
  description: string,
): Promise<void> => {
  const packagePath = join(repositoryRoot, "extensions", id);
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
    await writePackage(repositoryRoot, "alpha", "Alpha extension");
    await writePackage(repositoryRoot, "beta", "Beta extension");
    await writePackage(repositoryRoot, "pi-packages", "Required package");
    await writeFile(join(profilePath, "extensions.json"), '{"extensions":["alpha"]}\n');

    const runner = createProfileExtensionSelectionRunner(profilePath, repositoryRoot);
    expect(await runner.list()).toEqual({
      available: [
        { id: "alpha", description: "Alpha extension", kind: "skill" },
        { id: "beta", description: "Beta extension", kind: "skill" },
      ],
      selected: ["alpha"],
    });
    expect(await runner.setSelected(["beta", "alpha"])).toEqual({
      changed: true,
      selected: ["alpha", "beta"],
    });
    expect(await readFile(join(profilePath, "extensions.json"), "utf8")).toBe(
      '{\n  "extensions": [\n    "alpha",\n    "beta"\n  ]\n}\n',
    );
    expect(await runner.setSelected(["alpha", "beta"])).toEqual({
      changed: false,
      selected: ["alpha", "beta"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
