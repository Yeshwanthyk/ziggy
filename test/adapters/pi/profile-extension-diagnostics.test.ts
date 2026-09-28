import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partitionPiResourceDiagnostics } from "ziggy/adapters/pi/profile-extension-diagnostics";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("attributes a conflict to an optional package even when the core command appears second", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-optional-attribution-"));
  roots.push(root);

  const packagePath = join(root, "optional");
  await mkdir(packagePath);

  const alias = join(root, "optional-link");
  await symlink(packagePath, alias);

  const optional = join(alias, "extension.ts");
  const core = join(root, "core.ts");
  await writeFile(optional, "");
  await writeFile(core, "");

  const partition = partitionPiResourceDiagnostics(
    {
      extensionPaths: [optional, core],
      skillPaths: [],
      extensionFactories: [],
      optionalPackages: [{ id: "optional", packagePath }],
    },
    [{ source: core, message: `Command "same" conflicts with ${optional}` }],
  );

  expect(partition.skipped).toMatchObject([
    { id: "optional", diagnostics: [{ source: optional }] },
  ]);
  expect(partition.fatal).toEqual([]);
  expect(partition.resources.extensionPaths).toEqual([core]);
});
