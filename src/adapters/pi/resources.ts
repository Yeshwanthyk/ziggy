import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface PiResources {
  readonly extensionPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<string>;
}

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
            extensionPath: await existingFile(
              join(extensionsPath, extensionPackage.name, "index.ts"),
            ),
            skillPath: await existingDirectory(
              join(extensionsPath, extensionPackage.name, "skills"),
            ),
          })),
        );

  const [profileSkills, topLevelSkills] = await Promise.all([
    existingDirectory(join(profilePath, "skills")),
    existingDirectory(join(repositoryRoot, "skills")),
  ]);

  return {
    extensionPaths: packageResources.flatMap(({ extensionPath }) =>
      extensionPath === undefined ? [] : [extensionPath],
    ),
    skillPaths: [
      ...(profileSkills === undefined ? [] : [profileSkills]),
      ...packageResources.flatMap(({ skillPath }) => (skillPath === undefined ? [] : [skillPath])),
      ...(topLevelSkills === undefined ? [] : [topLevelSkills]),
    ],
  };
};
