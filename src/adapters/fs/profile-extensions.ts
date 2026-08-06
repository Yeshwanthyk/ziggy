import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Predicate, Schema } from "effect";
import { ProfileExtensionInvalid, ProfileFileSystemError } from "../../domain/profile";
import { fileSystemCauseDetails } from "./cause";

const ExtensionId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
const Selection = Schema.Struct({ extensions: Schema.Array(ExtensionId) });
const Manifest = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  pi: Schema.Struct({
    extensions: Schema.optionalKey(Schema.Array(Schema.String)),
    skills: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
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
            ? Effect.fail(invalid(skillFile, `declared skill has invalid frontmatter: ${skillFile}`))
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
  declared: string,
  resource: "extension" | "skill",
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
    const resourceStatus = yield* status(resolved).pipe(
      Effect.catchIf(
        (error) => error.code === "ENOENT",
        () => Effect.fail(invalid(resolved, `declared ${resource} path does not exist: ${resolved}`)),
      ),
    );
    if (resource === "extension" ? !resourceStatus.isFile() : !resourceStatus.isFile() && !resourceStatus.isDirectory()) {
      return yield* invalid(resolved, `declared ${resource} path has the wrong type: ${resolved}`);
    }
    return resolved;
  });

export const scanExtensionShelf = (
  repositoryRoot: string,
): Effect.Effect<ReadonlyArray<ExtensionPackage>, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    const shelfPath = path.join(repositoryRoot, "extensions");
    const entries = yield* Effect.tryPromise({
      try: () => readdir(shelfPath, { withFileTypes: true }),
      catch: (cause) => fsError("list", shelfPath, cause),
    });
    const packages = yield* Effect.forEach(
      entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name)),
      (entry) =>
        Effect.gen(function* () {
          const id = entry.name;
          const packagePath = path.join(shelfPath, id);
          const manifestPath = path.join(packagePath, "package.json");
          const manifest = yield* readText(manifestPath).pipe(
            Effect.flatMap((text) => decodeManifest(text)),
            Effect.mapError((cause) =>
              Predicate.isTagged(cause, "ProfileFileSystemError")
                ? cause
                : invalid(manifestPath, `invalid extension manifest: ${manifestPath}`, cause),
            ),
          );
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || manifest.name !== `@ziggy/${id}`) {
            return yield* invalid(manifestPath, `extension manifest name must be '@ziggy/${id}'`);
          }
          const extensionPaths = yield* Effect.forEach(manifest.pi.extensions ?? [], (declared) =>
            resolveDeclaredPath(packagePath, declared, "extension"),
          );
          const skillPaths = yield* Effect.forEach(manifest.pi.skills ?? [], (declared) =>
            resolveDeclaredPath(packagePath, declared, "skill"),
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
            kind: hasSkills && hasCode ? "skill+code" : hasSkills ? "skill" : "code",
            required: id === "pi-packages",
          } satisfies ExtensionPackage;
        }),
    );
    return packages;
  });

export const readExtensionSelection = (
  profilePath: string,
  shelf: ReadonlyArray<ExtensionPackage>,
): Effect.Effect<ReadonlyArray<string>, ProfileExtensionInvalid | ProfileFileSystemError> => {
  const selectionPath = path.join(profilePath, "extensions.json");
  return readText(selectionPath).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(undefined),
    ),
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed<ReadonlyArray<string>>([])
        : decodeSelection(text, { onExcessProperty: "error" }).pipe(
            Effect.mapError((cause) => invalid(selectionPath, `invalid extension selection: ${selectionPath}`, cause)),
            Effect.flatMap(({ extensions }) => {
              const unique = new Set(extensions);
              const known = new Set(shelf.filter((item) => !item.required).map((item) => item.id));
              const problem =
                unique.size !== extensions.length
                  ? "extension selection contains duplicate IDs"
                  : extensions.includes("pi-packages")
                    ? "extension selection cannot include reserved ID 'pi-packages'"
                    : extensions.find((id) => !known.has(id)) === undefined
                      ? undefined
                      : `unknown extension '${extensions.find((id) => !known.has(id))}'`;
              return problem === undefined
                ? Effect.succeed([...extensions].sort())
                : Effect.fail(invalid(selectionPath, problem));
            }),
          ),
    ),
  );
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
      Effect.tryPromise({
        try: async () => {
          await handle.close().catch(() => undefined);
          await rm(temporaryPath, { force: true });
        },
        catch: (cause) => fsError("remove", temporaryPath, cause),
      }).pipe(Effect.catch(() => Effect.void)),
  );
};
