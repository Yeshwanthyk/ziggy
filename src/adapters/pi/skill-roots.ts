import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

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

const merlinExtensionSkillRoots = async (merlinRoot: string): Promise<ReadonlyArray<string>> => {
  const extensionsPath = await existingDirectory(join(merlinRoot, "extensions"));
  if (extensionsPath === undefined) {
    return [];
  }

  const extensions = (await readdir(extensionsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));

  const roots = await Promise.all(
    extensions.map((extension) =>
      existingDirectory(join(extensionsPath, extension.name, "skills")),
    ),
  );
  return roots.flatMap((root) => (root === undefined ? [] : [root]));
};

export const discoverSkillRoots = async (
  profilePath: string,
  merlinRoot: string,
): Promise<ReadonlyArray<string>> => {
  const [profileSkills, extensionSkills, topLevelMerlinSkills] = await Promise.all([
    existingDirectory(join(profilePath, "skills")),
    merlinExtensionSkillRoots(merlinRoot),
    existingDirectory(join(merlinRoot, "skills")),
  ]);

  return [
    ...(profileSkills === undefined ? [] : [profileSkills]),
    ...extensionSkills,
    ...(topLevelMerlinSkills === undefined ? [] : [topLevelMerlinSkills]),
  ];
};
