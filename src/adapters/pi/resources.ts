import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface PiResources {
  readonly skillPaths: ReadonlyArray<string>;
  readonly catalogSkillIds: ReadonlyArray<string>;
}

const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const existingDirectory = (directoryPath: string): Promise<string | undefined> =>
  stat(directoryPath).then(
    (status) => (status.isDirectory() ? directoryPath : undefined),
    (cause: unknown) => {
      const code =
        cause instanceof Error && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined;
      if (code === "ENOENT") {
        return undefined;
      }
      throw cause;
    },
  );

const existingFile = (filePath: string): Promise<string | undefined> =>
  stat(filePath).then(
    (status) => (status.isFile() ? filePath : undefined),
    (cause: unknown) => {
      const code =
        cause instanceof Error && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined;
      if (code === "ENOENT") {
        return undefined;
      }
      throw cause;
    },
  );

const catalogSkillsAt = async (directoryPath: string): Promise<ReadonlyArray<string>> => {
  const directory = await existingDirectory(directoryPath);
  if (directory === undefined) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && SKILL_ID.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const skills = await Promise.all(
    candidates.map(async (entry) => ({
      id: entry.name,
      skillFile: await existingFile(join(directory, entry.name, "SKILL.md")),
    })),
  );
  return skills.flatMap(({ id, skillFile }) => (skillFile === undefined ? [] : [id]));
};

export const discoverPiResources = async (
  profilePath: string,
  repositoryRoot: string,
): Promise<PiResources> => {
  const extensionsPath = await existingDirectory(join(repositoryRoot, "extensions"));
  const packages =
    extensionsPath === undefined
      ? []
      : (await readdir(extensionsPath, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .sort((left, right) => left.name.localeCompare(right.name));
  const packageResources =
    extensionsPath === undefined
      ? []
      : await Promise.all(
          packages.map(async (extensionPackage) => ({
            skillPath: await existingDirectory(
              join(extensionsPath, extensionPackage.name, "skills"),
            ),
          })),
        );

  const [internalSkills, profileSkills, topLevelSkills] = await Promise.all([
    existingDirectory(join(repositoryRoot, "src", "adapters", "pi", "skills")),
    existingDirectory(join(profilePath, "skills")),
    existingDirectory(join(repositoryRoot, "skills")),
  ]);
  const catalogSkillIds = new Set<string>();
  for (const { skillPath } of packageResources) {
    if (skillPath === undefined) {
      continue;
    }
    for (const id of await catalogSkillsAt(skillPath)) {
      catalogSkillIds.add(id);
    }
  }
  if (topLevelSkills !== undefined) {
    for (const id of await catalogSkillsAt(topLevelSkills)) {
      catalogSkillIds.add(id);
    }
  }

  return {
    skillPaths: [internalSkills, profileSkills].filter(
      (skillPath): skillPath is string => skillPath !== undefined,
    ),
    catalogSkillIds: [...catalogSkillIds].sort((left, right) => left.localeCompare(right)),
  };
};
