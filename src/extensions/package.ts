import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Predicate, Schema } from "effect";
import { isRequiredBundledExtension } from "../catalog";
import { ProfileExtensionInvalid } from "../domain/profile";
import { fileSystemCauseDetails } from "../platform/cause";
import { ProfileFileSystemError } from "../profile";
import { ExtensionId, type ExtensionPackage } from "./types";

const Manifest = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/\S/u)),
  description: Schema.optionalKey(Schema.String),
  pi: Schema.Struct({
    extensions: Schema.optionalKey(Schema.Array(Schema.String)),
    skills: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  ziggy: Schema.optionalKey(
    Schema.Struct({
      automations: Schema.optionalKey(
        Schema.Array(Schema.Struct({ id: ExtensionId, path: Schema.String })),
      ),
      curatorManaged: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

const isExtensionId = Schema.is(ExtensionId);

interface Skill {
  readonly name: string;
  readonly description: string;
}

export const fsError = (operation: string, targetPath: string, cause: unknown) => {
  const details = fileSystemCauseDetails(cause);

  return new ProfileFileSystemError({
    operation,
    path: targetPath,
    message: details.message,
    code: details.code,
    cause,
  });
};

export const invalid = (targetPath: string, message: string, cause?: unknown) =>
  new ProfileExtensionInvalid({ path: targetPath, message, cause });

const readText = (targetPath: string) =>
  Effect.tryPromise({
    try: () => readFile(targetPath, "utf8"),
    catch: (cause) => fsError("read", targetPath, cause),
  });

const status = (targetPath: string) =>
  Effect.tryPromise({
    try: () => stat(targetPath),
    catch: (cause) => fsError("inspect", targetPath, cause),
  });

const physicalPath = (targetPath: string) =>
  Effect.tryPromise({
    try: () => realpath(targetPath),
    catch: (cause) => fsError("resolve", targetPath, cause),
  });

const frontmatterScalar = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();

  return trimmed !== undefined &&
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed;
};

const parseFrontmatter = (text: string): Skill | undefined => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);

  if (match === null) return undefined;

  const fields = new Map(
    (match[1] ?? "")
      .split(/\r?\n/)
      .map((line) => /^([a-zA-Z]+):\s*(.*)$/.exec(line))
      .flatMap((entry) => (entry === null ? [] : [[entry[1], entry[2]] as const])),
  );

  const name = frontmatterScalar(fields.get("name"));
  const description = frontmatterScalar(fields.get("description"));

  return name === undefined || description === undefined ? undefined : { name, description };
};

const declaredSkills = (declaredPath: string) =>
  Effect.gen(function* () {
    const declaredStatus = yield* status(declaredPath);

    const skillFiles = declaredStatus.isFile()
      ? path.basename(declaredPath) === "SKILL.md"
        ? [declaredPath]
        : []
      : (yield* Effect.tryPromise({
          try: () => readdir(declaredPath, { withFileTypes: true }),
          catch: (cause) => fsError("list", declaredPath, cause),
        })).flatMap((entry) =>
          entry.isDirectory() ? [path.join(declaredPath, entry.name, "SKILL.md")] : [],
        );

    const skills = yield* Effect.forEach(skillFiles, (skillFile) =>
      readText(skillFile).pipe(
        Effect.flatMap((text) => {
          const metadata = parseFrontmatter(text);

          return metadata === undefined
            ? Effect.fail(
                invalid(skillFile, `declared skill has invalid frontmatter: ${skillFile}`),
              )
            : Effect.succeed(metadata);
        }),
        Effect.catchIf(
          (error) => Predicate.isTagged(error, "ProfileFileSystemError") && error.code === "ENOENT",
          () => Effect.fail(invalid(skillFile, `declared skill does not exist: ${skillFile}`)),
        ),
      ),
    );

    return skills.sort((left, right) => left.name.localeCompare(right.name));
  });

const resolveDeclaredPath = (
  packagePath: string,
  physicalPackagePath: string,
  declared: string,
  resource: "extension" | "skill" | "automation",
) =>
  Effect.gen(function* () {
    const resolved = path.resolve(packagePath, declared);

    if (
      !declared.startsWith("./") ||
      (resolved !== packagePath && !resolved.startsWith(`${packagePath}${path.sep}`))
    ) {
      return yield* invalid(
        path.join(packagePath, "package.json"),
        `invalid declared ${resource} path '${declared}'`,
      );
    }

    const physicalResourcePath = yield* physicalPath(resolved).pipe(
      Effect.catchIf(
        (error) => error.code === "ENOENT",
        () =>
          Effect.fail(invalid(resolved, `declared ${resource} path does not exist: ${resolved}`)),
      ),
    );

    const relativePhysicalPath = path.relative(physicalPackagePath, physicalResourcePath);

    if (
      relativePhysicalPath === ".." ||
      relativePhysicalPath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePhysicalPath)
    ) {
      return yield* invalid(
        path.join(packagePath, "package.json"),
        `declared ${resource} path escapes its package: '${declared}'`,
      );
    }

    const resourceStatus = yield* status(resolved);

    if (
      resource === "skill"
        ? !resourceStatus.isFile() && !resourceStatus.isDirectory()
        : !resourceStatus.isFile()
    ) {
      return yield* invalid(resolved, `declared ${resource} path has the wrong type: ${resolved}`);
    }

    return resolved;
  });

/** Read and check the package at `<owner>/extensions/<id>`. */
export const readExtensionPackage = (
  owner: string,
  id: string,
): Effect.Effect<ExtensionPackage, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    const packagePath = path.join(owner, "extensions", id);
    const manifestPath = path.join(packagePath, "package.json");

    const packageStatus = yield* Effect.tryPromise({
      try: () => lstat(packagePath),
      catch: (cause) => fsError("inspect", packagePath, cause),
    }).pipe(
      Effect.catchIf(
        (error) => error.code === "ENOENT",
        () => Effect.fail(invalid(manifestPath, `unknown extension '${id}'`)),
      ),
    );

    if (!packageStatus.isDirectory() || packageStatus.isSymbolicLink()) {
      return yield* invalid(packagePath, `extension '${id}' is not a physical shelf directory`);
    }

    const manifest = yield* readText(manifestPath).pipe(
      Effect.catchIf(
        (error) => error.code === "ENOENT",
        () => Effect.fail(invalid(manifestPath, `unknown extension '${id}'`)),
      ),
      Effect.flatMap((text) => decodeManifest(text)),
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, "ProfileExtensionInvalid") ||
        Predicate.isTagged(cause, "ProfileFileSystemError")
          ? cause
          : invalid(manifestPath, `invalid extension manifest: ${manifestPath}`, cause),
      ),
    );

    if (!isExtensionId(id)) {
      return yield* invalid(
        manifestPath,
        `extension shelf ID must use lowercase kebab-case: '${id}'`,
      );
    }

    const physicalPackagePath = yield* physicalPath(packagePath);

    const extensionPaths = yield* Effect.forEach(manifest.pi.extensions ?? [], (declared) =>
      resolveDeclaredPath(packagePath, physicalPackagePath, declared, "extension"),
    );

    const skillPaths = yield* Effect.forEach(manifest.pi.skills ?? [], (declared) =>
      resolveDeclaredPath(packagePath, physicalPackagePath, declared, "skill"),
    );

    const declaredAutomations = manifest.ziggy?.automations ?? [];

    if (new Set(declaredAutomations.map((item) => item.id)).size !== declaredAutomations.length) {
      return yield* invalid(manifestPath, `extension '${id}' declares duplicate automation IDs`);
    }

    const automations = yield* Effect.forEach(declaredAutomations, (automation) =>
      resolveDeclaredPath(packagePath, physicalPackagePath, automation.path, "automation").pipe(
        Effect.map((automationPath) => ({ id: automation.id, path: automationPath })),
      ),
    );

    const skills = (yield* Effect.forEach(skillPaths, declaredSkills)).flat();
    const description = manifest.description?.trim() || skills[0]?.description;

    if (description === undefined) {
      return yield* invalid(manifestPath, `extension '${id}' has no description`);
    }

    const hasSkills = skillPaths.length > 0;
    const hasCode = extensionPaths.length > 0;

    if (!hasSkills && !hasCode) {
      return yield* invalid(manifestPath, `extension '${id}' declares no Pi resources`);
    }

    return {
      id,
      description: description.replace(/\s+/g, " ").trim(),
      packagePath,
      extensionPaths,
      skillPaths,
      skills,
      automations,
      kind: hasSkills && hasCode ? "skill+code" : hasSkills ? "skill" : "code",
      required: isRequiredBundledExtension(id),
    };
  });

/** Whether `<owner>/extensions/<id>` exists at all, valid or not. */
export const packageExists = (
  owner: string,
  id: string,
): Effect.Effect<boolean, ProfileFileSystemError> => {
  const packagePath = path.join(owner, "extensions", id);

  return Effect.tryPromise({
    try: () => lstat(packagePath),
    catch: (cause) => fsError("inspect", packagePath, cause),
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(false),
    ),
  );
};

/**
 * The package ids on a shelf. Names that are not ids (staging and `.old` folders) are
 * skipped, and a missing shelf is empty.
 */
export const shelfIds = (
  owner: string,
): Effect.Effect<ReadonlyArray<string>, ProfileFileSystemError> => {
  const shelfPath = path.join(owner, "extensions");

  return Effect.tryPromise({
    try: () => readdir(shelfPath, { withFileTypes: true }),
    catch: (cause) => fsError("list", shelfPath, cause),
  }).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.isDirectory() && isExtensionId(entry.name))
        .map((entry) => entry.name)
        .sort(),
    ),
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed([]),
    ),
  );
};

/** Every valid package on a shelf; one broken package fails the scan. */
export const scanShelf = (
  owner: string,
): Effect.Effect<
  ReadonlyArray<ExtensionPackage>,
  ProfileExtensionInvalid | ProfileFileSystemError
> =>
  Effect.flatMap(shelfIds(owner), (ids) =>
    Effect.forEach(ids, (id) => readExtensionPackage(owner, id)),
  );
