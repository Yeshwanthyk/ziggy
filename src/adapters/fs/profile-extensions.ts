import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import * as path from "node:path";
import { Effect, Predicate, Schema } from "effect";
import {
  APPROVED_BUNDLED_EXTENSION_IDS,
  bundledPackageMetadata,
  isRequiredBundledExtension,
} from "../../catalog";
import { bundledFilePath } from "../../generated/builtin-files";
import { ProfileExtensionInvalid, ProfileFileSystemError } from "../../domain/profile";
import { fileSystemCauseDetails } from "./cause";

const ExtensionId = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
const Selection = Schema.Struct({ extensions: Schema.Array(ExtensionId) });
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
const decodeSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(Selection));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

export type ExtensionKind = "skill" | "code" | "skill+code";
export interface DeclaredSkill {
  readonly name: string;
  readonly description: string;
}
export interface ExtensionPackage {
  readonly id: string;
  readonly description: string;
  readonly packagePath: string;
  readonly extensionPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<DeclaredSkill>;
  readonly automations: ReadonlyArray<{ readonly id: string; readonly path: string }>;
  readonly kind: ExtensionKind;
  readonly required: boolean;
}

const fsError = (operation: string, targetPath: string, cause: unknown) => {
  const details = fileSystemCauseDetails(cause);
  return new ProfileFileSystemError({
    operation,
    path: targetPath,
    message: details.message,
    code: details.code,
    cause,
  });
};

const invalid = (targetPath: string, message: string, cause?: unknown) =>
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

const parseFrontmatter = (text: string): DeclaredSkill | undefined => {
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
      resource === "extension" || resource === "automation"
        ? !resourceStatus.isFile()
        : !resourceStatus.isFile() && !resourceStatus.isDirectory()
    ) {
      return yield* invalid(resolved, `declared ${resource} path has the wrong type: ${resolved}`);
    }
    return resolved;
  });

export const readExtensionPackage = (
  shelfOwnerPath: string,
  id: string,
): Effect.Effect<ExtensionPackage, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    const packagePath = path.join(shelfOwnerPath, "extensions", id);
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
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
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

const requiredBundledFile = (logicalPath: string, id: string) => {
  const filePath = bundledFilePath(logicalPath);
  return filePath === undefined
    ? Effect.fail(
        invalid(logicalPath, `bundled extension '${id}' is missing embedded file ${logicalPath}`),
      )
    : Effect.succeed(filePath);
};

/** Resolve an approved bundled package from compile-in metadata, not a checkout folder. */
export const bundledExtensionPackage = (
  id: string,
): Effect.Effect<ExtensionPackage, ProfileExtensionInvalid> =>
  Effect.gen(function* () {
    const metadata = bundledPackageMetadata(id);
    if (metadata === undefined) {
      return yield* invalid(id, `unknown extension '${id}'`);
    }
    const skillPaths: Array<string> = [];
    for (const skill of metadata.skills) {
      skillPaths.push(yield* requiredBundledFile(skill.logicalPath, id));
    }
    const automations: Array<{ readonly id: string; readonly path: string }> = [];
    for (const automation of metadata.automations) {
      automations.push({
        id: automation.id,
        path: yield* requiredBundledFile(automation.logicalPath, id),
      });
    }
    return {
      id: metadata.id,
      description: metadata.description,
      packagePath: metadata.sourcePath,
      extensionPaths: [],
      skillPaths,
      skills: metadata.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
      automations,
      kind: metadata.kind,
      required: metadata.required,
    };
  });

export const scanExtensionShelf = (
  shelfOwnerPath: string,
): Effect.Effect<
  ReadonlyArray<ExtensionPackage>,
  ProfileExtensionInvalid | ProfileFileSystemError
> =>
  Effect.gen(function* () {
    const shelfPath = path.join(shelfOwnerPath, "extensions");
    const entries = yield* Effect.tryPromise({
      try: () => readdir(shelfPath, { withFileTypes: true }),
      catch: (cause) => fsError("list", shelfPath, cause),
    });
    return yield* Effect.forEach(
      entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name)),
      (entry) => readExtensionPackage(shelfOwnerPath, entry.name),
    );
  });

export const scanOptionalExtensionShelf = (
  shelfOwnerPath: string,
): Effect.Effect<
  ReadonlyArray<ExtensionPackage>,
  ProfileExtensionInvalid | ProfileFileSystemError
> =>
  scanExtensionShelf(shelfOwnerPath).pipe(
    Effect.catchIf(
      (error) => Predicate.isTagged(error, "ProfileFileSystemError") && error.code === "ENOENT",
      () => Effect.succeed([]),
    ),
  );

const extensionPackageExists = (shelfOwnerPath: string, id: string) => {
  const packagePath = path.join(shelfOwnerPath, "extensions", id);
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

/** Resolve a Profile selection without allowing the catalogue to shadow Profile-owned code. */
export const readSelectedExtensionPackage = (
  profilePath: string,
  _repositoryRoot: string,
  id: string,
  approvedRepositoryIds: ReadonlySet<string> = APPROVED_BUNDLED_EXTENSION_IDS,
): Effect.Effect<ExtensionPackage, ProfileExtensionInvalid | ProfileFileSystemError> =>
  extensionPackageExists(profilePath, id).pipe(
    Effect.flatMap((profileOwned) => {
      if (profileOwned) {
        return readExtensionPackage(profilePath, id);
      }
      if (!approvedRepositoryIds.has(id)) {
        return Effect.fail(
          invalid(
            path.join(profilePath, "extensions.json"),
            `selected extension '${id}' is neither approved nor Profile-local`,
          ),
        );
      }
      return bundledExtensionPackage(id);
    }),
  );

const validateDecodedSelection = (
  selectionPath: string,
  extensions: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, ProfileExtensionInvalid> => {
  const reserved = extensions.find(isRequiredBundledExtension);
  const problem =
    new Set(extensions).size !== extensions.length
      ? "extension selection contains duplicate IDs"
      : reserved === undefined
        ? undefined
        : `extension selection cannot include reserved ID '${reserved}'`;
  return problem === undefined
    ? Effect.succeed([...extensions].sort())
    : Effect.fail(invalid(selectionPath, problem));
};

const decodeSelectionText = (
  selectionPath: string,
  text: string,
): Effect.Effect<ReadonlyArray<string>, ProfileExtensionInvalid> =>
  decodeSelection(text, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) =>
      invalid(selectionPath, `invalid extension selection: ${selectionPath}`, cause),
    ),
    Effect.flatMap(({ extensions }) => validateDecodedSelection(selectionPath, extensions)),
  );

const inspectSelectionPath = (
  selectionPath: string,
): Effect.Effect<boolean, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const selectionStatus = await lstat(selectionPath);
        if (selectionStatus.isSymbolicLink() || !selectionStatus.isFile()) {
          throw invalid(selectionPath, "extension selection must be a physical file");
        }
        return true;
      } catch (cause) {
        if (fileSystemCauseDetails(cause).code === "ENOENT") return false;
        throw cause;
      }
    },
    catch: (cause) =>
      cause instanceof ProfileExtensionInvalid ? cause : fsError("inspect", selectionPath, cause),
  });

const readPhysicalSelectionBytes = (
  selectionPath: string,
): Effect.Effect<Uint8Array | undefined, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.tryPromise({
    try: async () => {
      let selectionStatus;
      try {
        selectionStatus = await lstat(selectionPath);
      } catch (cause) {
        if (fileSystemCauseDetails(cause).code === "ENOENT") return undefined;
        throw cause;
      }
      if (selectionStatus.isSymbolicLink() || !selectionStatus.isFile()) {
        throw invalid(selectionPath, "extension selection must be a physical file");
      }

      const handle = await open(selectionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const openedStatus = await handle.stat();
        if (openedStatus.isSymbolicLink() || !openedStatus.isFile()) {
          throw invalid(selectionPath, "extension selection must be a physical file");
        }
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => {
      if (cause instanceof ProfileExtensionInvalid) return cause;
      const details = fileSystemCauseDetails(cause);
      return details.code === "ELOOP"
        ? invalid(selectionPath, "extension selection must be a physical file", cause)
        : fsError("read", selectionPath, cause);
    },
  });

export const readExtensionSelection = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<string>, ProfileExtensionInvalid | ProfileFileSystemError> => {
  const selectionPath = path.join(profilePath, "extensions.json");
  return readPhysicalSelectionBytes(selectionPath).pipe(
    Effect.flatMap((bytes) =>
      bytes === undefined
        ? Effect.succeed<ReadonlyArray<string>>([])
        : decodeSelectionText(selectionPath, Buffer.from(bytes).toString("utf8")),
    ),
  );
};

/** Decoded selection plus the exact bytes needed to restore the human-owned file. */
export interface ExtensionSelectionSnapshot {
  readonly exists: boolean;
  readonly bytes: Uint8Array;
  readonly selected: ReadonlyArray<string>;
}

export const snapshotExtensionSelection = (
  profilePath: string,
): Effect.Effect<ExtensionSelectionSnapshot, ProfileExtensionInvalid | ProfileFileSystemError> => {
  const selectionPath = path.join(profilePath, "extensions.json");
  return readPhysicalSelectionBytes(selectionPath).pipe(
    Effect.flatMap((bytes) =>
      bytes === undefined
        ? Effect.succeed<ExtensionSelectionSnapshot>({
            exists: false,
            bytes: new Uint8Array(),
            selected: [],
          })
        : decodeSelectionText(selectionPath, Buffer.from(bytes).toString("utf8")).pipe(
            Effect.map((selected) => ({ exists: true, bytes, selected })),
          ),
    ),
  );
};

export const extensionSelectionGeneration = (snapshot: ExtensionSelectionSnapshot): string =>
  createHash("sha256")
    .update(snapshot.exists ? Buffer.concat([Buffer.from("present\0"), snapshot.bytes]) : "absent")
    .digest("hex");

const cleanupRestoreTemporary =
  (temporaryPath: string) => (handle: Awaited<ReturnType<typeof open>>) =>
    Effect.tryPromise({
      try: () => handle.close(),
      catch: (cause) => fsError("close", temporaryPath, cause),
    }).pipe(
      Effect.catch((failure) =>
        Effect.logWarning("Profile extension restore close failed", { failure }),
      ),
      Effect.andThen(
        Effect.tryPromise({
          try: () => unlink(temporaryPath),
          catch: (cause) => fsError("remove", temporaryPath, cause),
        }).pipe(
          Effect.catchIf(
            (failure) => failure.code === "ENOENT",
            () => Effect.void,
          ),
          Effect.catch((failure) =>
            Effect.logWarning("Profile extension restore cleanup failed", { failure }),
          ),
        ),
      ),
    );

const restorePresentSelection = (selectionPath: string, bytes: Uint8Array) => {
  const temporaryPath = path.join(
    path.dirname(selectionPath),
    `.extensions-restore-${randomUUID()}.tmp`,
  );
  return Effect.gen(function* () {
    yield* inspectSelectionPath(selectionPath);
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(temporaryPath, "wx", 0o600),
        catch: (cause) => fsError("open", temporaryPath, cause),
      }),
      (handle) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: async () => {
              await handle.writeFile(bytes);
              await handle.sync();
              await handle.close();
            },
            catch: (cause) => fsError("write", temporaryPath, cause),
          });
          yield* inspectSelectionPath(selectionPath);
          yield* Effect.tryPromise({
            try: () => rename(temporaryPath, selectionPath),
            catch: (cause) => fsError("rename", selectionPath, cause),
          });
        }),
      cleanupRestoreTemporary(temporaryPath),
    );
  });
};

const restoreAbsentSelection = (
  selectionPath: string,
): Effect.Effect<void, ProfileExtensionInvalid | ProfileFileSystemError> =>
  inspectSelectionPath(selectionPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? Effect.tryPromise({
            try: () => unlink(selectionPath),
            catch: (cause) => fsError("remove", selectionPath, cause),
          }).pipe(
            Effect.catchIf(
              (failure) => failure.code === "ENOENT",
              () => Effect.void,
            ),
          )
        : Effect.void,
    ),
  );

/** Restore raw selection bytes or absence atomically; callers hold the Profile mutation lock. */
export const restoreExtensionSelection = (
  profilePath: string,
  snapshot: ExtensionSelectionSnapshot,
): Effect.Effect<void, ProfileExtensionInvalid | ProfileFileSystemError> => {
  const selectionPath = path.join(profilePath, "extensions.json");
  const bytes = new Uint8Array(snapshot.bytes);
  return snapshot.exists
    ? restorePresentSelection(selectionPath, bytes)
    : restoreAbsentSelection(selectionPath);
};

export const replaceExtensionSelection = (profilePath: string, ids: ReadonlyArray<string>) => {
  const selectionPath = path.join(profilePath, "extensions.json");
  const temporaryPath = path.join(profilePath, `.extensions-${randomUUID()}.tmp`);
  const content = `${JSON.stringify({ extensions: [...ids].sort() }, null, 2)}\n`;
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(temporaryPath, "wx"),
      catch: (cause) => fsError("open", temporaryPath, cause),
    }),
    (handle) =>
      Effect.tryPromise({
        try: async () => {
          await handle.writeFile(content, "utf8");
          await handle.close();
          await rename(temporaryPath, selectionPath);
        },
        catch: (cause) => fsError("write or rename", selectionPath, cause),
      }),
    (handle) =>
      Effect.all(
        [
          Effect.tryPromise({
            try: () => handle.close(),
            catch: (cause) => fsError("close", temporaryPath, cause),
          }),
          Effect.tryPromise({
            try: () => rm(temporaryPath),
            catch: (cause) => fsError("remove", temporaryPath, cause),
          }).pipe(
            Effect.catch((failure) =>
              failure.code === "ENOENT" ? Effect.void : Effect.fail(failure),
            ),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.catch((failure) =>
          Effect.logWarning("Profile extension cleanup failed", { failure }),
        ),
      ),
  );
};
