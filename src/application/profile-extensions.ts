import { lstat, readFile } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer, Predicate, Result, Schema } from "effect";
import {
  BUILTIN_EXTENSION_CATALOG,
  REQUIRED_BUNDLED_EXTENSION_IDS,
  bundledPackageMetadata,
} from "../catalog";
import {
  ExtensionCatalog,
  ExtensionCatalogInstallFailed,
  ExtensionCatalogInvalid,
  type GitHubExtensionCatalogEntry,
} from "../domain/extension-catalog";
import {
  ProfileExtensionId,
  ProfileExtensionMutationLock,
  ProfileExtensionPreflight,
  type ProfileExtensionMutationLockApi,
  type ProfileExtensionPreflightApi,
  type ProfileExtensionCatalogListing,
  type ProfileExtensionChoice,
  type ProfileExtensionError,
  ProfileExtensionRollbackFailed,
  type ProfileExtensionRuntimePreparation,
  type ProfileExtensionListing,
  type ProfileExtensionMutation,
  type ProfileExtensionSetResult,
  type ProfileExtensionValidation,
  type ProfileExtensionsApi,
  type ProfileExtensionRuntimeError,
} from "../domain/profile-extension";
import {
  ProfileExtensionInvalid,
  ProfileFileSystemError,
  type ProfileTarget,
} from "../domain/profile";
import {
  ExtensionArchiveClient,
  type ExtensionArchiveClientApi,
} from "../adapters/github/extension-catalog";
import {
  makeExtensionInstaller,
  type ExtensionArchiveExtractor,
} from "../adapters/fs/extension-installer";
import {
  readExtensionPackage,
  readExtensionSelection,
  readSelectedExtensionPackage,
  extensionSelectionGeneration,
  replaceExtensionSelection,
  restoreExtensionSelection,
  scanOptionalExtensionShelf,
  snapshotExtensionSelection,
  type ExtensionSelectionSnapshot,
  type ExtensionPackage,
} from "../adapters/fs/profile-extensions";
import {
  automationFileStore,
  installAutomationDefinition,
  removeAutomationDefinition,
  pauseAutomationDefinition,
  resumeAutomationDefinition,
  type AutomationFileStore,
} from "../adapters/fs/automation-files";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import { parseAutomationFile, validateAutomationId } from "../domain/automation";
/** File operations owned by Profile extension activation; injectable for rollback proofs. */
export interface ProfileExtensionAutomationOperations {
  readonly files: AutomationFileStore;
  readonly install: typeof installAutomationDefinition;
  readonly remove: typeof removeAutomationDefinition;
  readonly pause: typeof pauseAutomationDefinition;
  readonly resume: typeof resumeAutomationDefinition;
}

const liveAutomationOperations: ProfileExtensionAutomationOperations = {
  files: automationFileStore,
  install: installAutomationDefinition,
  remove: removeAutomationDefinition,
  pause: pauseAutomationDefinition,
  resume: resumeAutomationDefinition,
};

export class ProfileExtensions extends Context.Service<ProfileExtensions, ProfileExtensionsApi>()(
  "ziggy/ProfileExtensions",
) {}

const decodeRequestedExtensionIds = Schema.decodeUnknownEffect(Schema.Array(ProfileExtensionId));

const profileNotInitialized = (profilePath: string): ProfileExtensionInvalid =>
  new ProfileExtensionInvalid({
    path: profilePath,
    message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
    cause: undefined,
  });

const verifyInitialized = (
  profilePath: string,
): Effect.Effect<void, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.tryPromise({
    try: () => lstat(path.join(profilePath, "SOUL.md")),
    catch: (cause) => {
      const details = fileSystemCauseDetails(cause);
      return details.code === "ENOENT"
        ? profileNotInitialized(profilePath)
        : new ProfileFileSystemError({
            operation: "inspect",
            path: path.join(profilePath, "SOUL.md"),
            message: details.message,
            code: details.code,
            cause,
          });
    },
  }).pipe(
    Effect.flatMap((status) =>
      status.isFile() && !status.isSymbolicLink()
        ? Effect.void
        : Effect.fail(profileNotInitialized(profilePath)),
    ),
  );

const packageExists = (
  profilePath: string,
  id: string,
): Effect.Effect<boolean, ProfileFileSystemError> => {
  const packagePath = path.join(profilePath, "extensions", id);
  return Effect.tryPromise({
    try: () => lstat(packagePath),
    catch: (cause) => {
      const details = fileSystemCauseDetails(cause);
      return new ProfileFileSystemError({
        operation: "inspect",
        path: packagePath,
        message: details.message,
        code: details.code,
        cause,
      });
    },
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(false),
    ),
  );
};

const bundledListing = (
  id: string,
  version: string,
): Effect.Effect<ProfileExtensionCatalogListing, ExtensionCatalogInvalid> => {
  const metadata = bundledPackageMetadata(id);
  if (metadata === undefined) {
    return Effect.fail(
      new ExtensionCatalogInvalid({
        source: id,
        message: `approved extension '${id}' is missing from the bundled catalog`,
        cause: undefined,
      }),
    );
  }
  return Effect.succeed({
    id: metadata.id,
    version,
    description: metadata.description,
    kind: metadata.kind,
    required: metadata.required,
    source: "bundled" as const,
    installed: true,
    packagePath: metadata.sourcePath,
    skills: metadata.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
    })),
    extensionPaths: [...metadata.executables],
  });
};

const remoteListing = (entry: GitHubExtensionCatalogEntry): ProfileExtensionCatalogListing => ({
  id: entry.id,
  version: entry.version,
  description: entry.description,
  kind: "remote",
  required: false,
  source: "remote-approved",
  installed: false,
});

const selectionInvalid = (profilePath: string, message: string, cause?: unknown) =>
  new ProfileExtensionInvalid({
    path: path.join(profilePath, "extensions.json"),
    message,
    cause,
  });

const isProfileExtensionRuntimeError = (
  cause: ProfileExtensionError,
): cause is ProfileExtensionRuntimeError =>
  Predicate.isTagged(cause, "ProfileExtensionInvalid") ||
  Predicate.isTagged(cause, "ProfileFileSystemError") ||
  Predicate.isTagged(cause, "ProfileExtensionPreflightFailed") ||
  Predicate.isTagged(cause, "ProfileExtensionLockFailed") ||
  Predicate.isTagged(cause, "ProfileExtensionRollbackFailed");

const runtimeFailure = (
  profilePath: string,
  cause: ProfileExtensionError,
): ProfileExtensionRuntimeError => {
  if (isProfileExtensionRuntimeError(cause)) {
    return cause;
  }
  return new ProfileExtensionInvalid({
    path: path.join(profilePath, "extensions.json"),
    message: `could not prepare the Profile extension runtime: ${cause.message}`,
    cause,
  });
};

const readExistingAutomation = (
  automation: ProfileExtensionAutomationOperations,
  target: ProfileTarget,
  id: string,
) =>
  automation.files.readDefinition(target, id, true).pipe(
    Effect.catchTag("AutomationNotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("AutomationFileSystemError", (failure) =>
      fileSystemCauseDetails(failure.cause).code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(failure),
    ),
  );

const decodeRequestedSelection = (
  profilePath: string,
  ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, ProfileExtensionInvalid> =>
  decodeRequestedExtensionIds(ids).pipe(
    Effect.mapError((cause) => selectionInvalid(profilePath, "invalid extension selection", cause)),
    Effect.flatMap((decoded) => {
      const duplicate = new Set(decoded).size !== decoded.length;
      const reserved = decoded.find((id) => REQUIRED_BUNDLED_EXTENSION_IDS.has(id));
      if (duplicate) {
        return Effect.fail(
          selectionInvalid(profilePath, "extension selection contains duplicate IDs"),
        );
      }
      if (reserved !== undefined) {
        return Effect.fail(
          selectionInvalid(
            profilePath,
            `extension selection cannot include reserved ID '${reserved}'`,
          ),
        );
      }
      return Effect.succeed([...decoded].sort());
    }),
  );

const isExtensionCatalogInstallFailed = (cause: unknown): cause is ExtensionCatalogInstallFailed =>
  Predicate.isTagged(cause, "ExtensionCatalogInstallFailed");

const installFailure = (
  id: string,
  targetPath: string,
  reason: ConstructorParameters<typeof ExtensionCatalogInstallFailed>[0]["reason"],
  message: string,
  cause: unknown,
): ExtensionCatalogInstallFailed =>
  new ExtensionCatalogInstallFailed({ id, path: targetPath, reason, message, cause });

const readInstalledPackage = (
  profilePath: string,
  id: string,
): Effect.Effect<ExtensionPackage, ExtensionCatalogInstallFailed> =>
  readExtensionPackage(profilePath, id).pipe(
    Effect.mapError((cause) =>
      installFailure(
        id,
        path.join(profilePath, "extensions", id),
        "validation",
        "installed Profile extension failed validation",
        cause,
      ),
    ),
  );

const validateAutomationOwnership = (
  packages: ReadonlyArray<ExtensionPackage>,
): Effect.Effect<void, ExtensionCatalogInstallFailed> => {
  const owners = new Map<string, string>();
  for (const packageInfo of packages) {
    for (const declared of packageInfo.automations) {
      const previous = owners.get(declared.id);
      if (previous !== undefined && previous !== packageInfo.id) {
        return Effect.fail(
          installFailure(
            packageInfo.id,
            declared.path,
            "validation",
            `automation ${declared.id} is declared by both ${previous} and ${packageInfo.id}`,
            undefined,
          ),
        );
      }
      owners.set(declared.id, packageInfo.id);
    }
  }
  return Effect.void;
};

const validatePackageAutomationDefinitions = (
  automation: ProfileExtensionAutomationOperations,
  profilePath: string,
  packageInfo: ExtensionPackage,
): Effect.Effect<void, ExtensionCatalogInstallFailed> =>
  Effect.forEach(
    packageInfo.automations,
    (declared) =>
      Effect.gen(function* () {
        const id = yield* validateAutomationId(declared.id);
        const source = yield* Effect.tryPromise({
          try: () => readFile(declared.path, "utf8"),
          catch: (cause) => cause,
        });
        const expected = yield* parseAutomationFile(id, declared.path, source);
        const owner = `extension:${packageInfo.id}`;
        if (expected.owner !== owner) {
          return yield* Effect.fail(
            installFailure(
              packageInfo.id,
              declared.path,
              "validation",
              `automation ${id} must declare owner: ${owner}`,
              undefined,
            ),
          );
        }
        const target = { name: path.basename(profilePath), path: profilePath };
        const existing = yield* readExistingAutomation(automation, target, id);
        if (existing === undefined) return;
        const parsed = yield* parseAutomationFile(id, existing.path, existing.source);
        if (parsed.owner !== owner || existing.source !== source) {
          return yield* Effect.fail(
            installFailure(
              packageInfo.id,
              existing.path,
              "validation",
              `automation ${id} already exists and is not the exact ${owner} definition`,
              undefined,
            ),
          );
        }
      }).pipe(
        Effect.mapError((cause) =>
          isExtensionCatalogInstallFailed(cause)
            ? cause
            : installFailure(
                packageInfo.id,
                declared.path,
                "validation",
                `could not validate extension automation '${declared.id}' without changing Profile state`,
                cause,
              ),
        ),
      ),
    { discard: true, concurrency: 1 },
  );

interface ActivatedAutomation {
  readonly packageInfo: ExtensionPackage;
  readonly id: string;
  readonly activation: "installed" | "resumed";
  readonly source: string;
}

interface PausedAutomation {
  readonly packageInfo: ExtensionPackage;
  readonly id: string;
}

interface RollbackAction {
  readonly operation: string;
  readonly path: string;
  readonly effect: Effect.Effect<void, unknown, never>;
}

const boundedRollbackText = (value: string, maximum: number): string =>
  [...value.replace(/\s+/gu, " ").trim()].slice(0, maximum).join("");

const rollbackMutation = <E>(
  profilePath: string,
  operation: string,
  originalFailure: E,
  actions: ReadonlyArray<RollbackAction>,
): Effect.Effect<never, E | ProfileExtensionRollbackFailed> =>
  Effect.forEach(actions, (action) => action.effect.pipe(Effect.result), { concurrency: 1 }).pipe(
    Effect.flatMap((results): Effect.Effect<never, E | ProfileExtensionRollbackFailed> => {
      const failures = results.flatMap((result, index) => {
        if (Result.isSuccess(result)) return [];
        const action = actions[index];
        return action === undefined
          ? []
          : [
              {
                operation: boundedRollbackText(action.operation, 96),
                path: boundedRollbackText(action.path, 240),
                message: boundedRollbackText("rollback action failed", 360),
              },
            ];
      });
      if (failures.length === 0)
        return Effect.fail<E | ProfileExtensionRollbackFailed>(originalFailure);
      return Effect.fail(
        new ProfileExtensionRollbackFailed({
          profilePath,
          operation: boundedRollbackText(operation, 96),
          message:
            "Profile extension operation failed and rollback also failed; Profile state may have changed",
          originalFailure,
          rollbackFailures: failures.slice(0, 12),
          cause: originalFailure,
        }),
      );
    }),
  );

const pauseOwnedAutomations = (
  automation: ProfileExtensionAutomationOperations,
  profilePath: string,
  packageInfo: ExtensionPackage,
  paused: Array<PausedAutomation>,
): Effect.Effect<void, ExtensionCatalogInstallFailed> => {
  const target = { name: path.basename(profilePath), path: profilePath };
  return Effect.forEach(
    packageInfo.automations,
    (declared) =>
      Effect.gen(function* () {
        const id = yield* validateAutomationId(declared.id);
        const existing = yield* readExistingAutomation(automation, target, id);
        if (existing === undefined || existing.lifecycle === "paused") return;
        const owner = `extension:${packageInfo.id}`;
        const parsed = yield* parseAutomationFile(id, existing.path, existing.source);
        if (parsed.owner !== owner) {
          return yield* Effect.fail(
            installFailure(
              packageInfo.id,
              existing.path,
              "validation",
              `refusing to pause automation ${id} because it is not owned by ${owner}`,
              undefined,
            ),
          );
        }
        yield* automation.pause(target, id);
        paused.push({ packageInfo, id });
      }).pipe(
        Effect.mapError((cause) =>
          isExtensionCatalogInstallFailed(cause)
            ? cause
            : installFailure(
                packageInfo.id,
                declared.path,
                "filesystem",
                `could not safely pause owned automation '${declared.id}'`,
                cause,
              ),
        ),
      ),
    { discard: true, concurrency: 1 },
  );
};

interface ProvisionOwnedAutomationsResult {
  readonly activated: ReadonlyArray<ActivatedAutomation>;
  readonly failure?: ExtensionCatalogInstallFailed;
}

const provisionOwnedAutomations = (
  automation: ProfileExtensionAutomationOperations,
  profilePath: string,
  packageInfo: ExtensionPackage,
): Effect.Effect<ProvisionOwnedAutomationsResult, never> => {
  const target = { name: path.basename(profilePath), path: profilePath };
  return Effect.gen(function* () {
    const activated: Array<ActivatedAutomation> = [];
    for (const declared of packageInfo.automations) {
      const operation = Effect.gen(function* () {
        const id = yield* validateAutomationId(declared.id);
        const source = yield* Effect.tryPromise({
          try: () => readFile(declared.path, "utf8"),
          catch: (cause) => cause,
        });
        const existing = yield* readExistingAutomation(automation, target, id);
        if (existing === undefined) {
          yield* automation.install(target, id, source);
          activated.push({ packageInfo, id, activation: "installed", source });
          return;
        }
        if (existing.lifecycle === "paused") {
          yield* automation.resume(target, id);
          activated.push({ packageInfo, id, activation: "resumed", source });
        }
      }).pipe(
        Effect.mapError((cause) =>
          isExtensionCatalogInstallFailed(cause)
            ? cause
            : installFailure(
                packageInfo.id,
                declared.path,
                "filesystem",
                `could not provision extension automation '${declared.id}'`,
                cause,
              ),
        ),
      );
      const result = yield* operation.pipe(Effect.result);
      if (Result.isFailure(result)) return { activated, failure: result.failure };
    }
    return { activated };
  });
};

export const makeProfileExtensions = (
  archiveClient: ExtensionArchiveClientApi,
  preflight: ProfileExtensionPreflightApi,
  lock: ProfileExtensionMutationLockApi,
  catalog: ExtensionCatalog = BUILTIN_EXTENSION_CATALOG,
  extractor?: ExtensionArchiveExtractor,
  automation: ProfileExtensionAutomationOperations = liveAutomationOperations,
): ProfileExtensionsApi => {
  const installer = makeExtensionInstaller(archiveClient, extractor);
  const entryFor = (id: string) => catalog.extensions.find((entry) => entry.id === id);

  const list = (_repositoryRoot: string) =>
    Effect.forEach(catalog.extensions, (entry) =>
      entry.source === "bundled"
        ? bundledListing(entry.id, entry.version)
        : Effect.succeed(remoteListing(entry)),
    ).pipe(
      Effect.map((items) => [...items].sort((left, right) => left.id.localeCompare(right.id))),
    );

  const show = (repositoryRoot: string, id: string) =>
    list(repositoryRoot).pipe(
      Effect.flatMap((items) => {
        const found = items.find((item) => item.id === id);
        return found === undefined
          ? Effect.fail(
              new ExtensionCatalogInvalid({
                source: id,
                message: `unknown extension '${id}'`,
                cause: undefined,
              }),
            )
          : Effect.succeed(found);
      }),
    );

  const ensurePublished = (
    profilePath: string,
    _repositoryRoot: string,
    id: string,
  ): Effect.Effect<ExtensionPackage, ProfileExtensionError> =>
    Effect.gen(function* () {
      const packagePath = path.join(profilePath, "extensions", id);
      if (yield* packageExists(profilePath, id)) {
        return yield* readInstalledPackage(profilePath, id);
      }
      const entry = entryFor(id);
      if (entry === undefined) {
        return yield* new ExtensionCatalogInvalid({
          source: id,
          message: `unknown extension '${id}'; it is neither approved nor Profile-local`,
          cause: undefined,
        });
      }
      if (entry.source === "github") {
        yield* installer.installGitHub(profilePath, entry);
      } else {
        yield* installer.installBundled(profilePath, entry);
      }
      return yield* readInstalledPackage(profilePath, id).pipe(
        Effect.mapError((cause) =>
          isExtensionCatalogInstallFailed(cause)
            ? cause
            : installFailure(
                id,
                packagePath,
                "validation",
                "installed extension failed validation",
                cause,
              ),
        ),
      );
    });

  const readSelectedPackage = (
    profilePath: string,
    repositoryRoot: string,
    id: string,
  ): Effect.Effect<ExtensionPackage, ProfileExtensionError> =>
    readSelectedExtensionPackage(profilePath, repositoryRoot, id);

  const readPresentPackage = (
    profilePath: string,
    id: string,
  ): Effect.Effect<ExtensionPackage, ProfileExtensionError> =>
    Effect.gen(function* () {
      if (!(yield* packageExists(profilePath, id))) {
        return yield* Effect.fail<ProfileExtensionError>(
          selectionInvalid(
            profilePath,
            `selected extension '${id}' is not installed at ${path.join(profilePath, "extensions", id)}`,
          ),
        );
      }
      return yield* readInstalledPackage(profilePath, id);
    });

  const readOptionalPresentPackage = (
    profilePath: string,
    repositoryRoot: string,
    id: string,
  ): Effect.Effect<ExtensionPackage | undefined, ProfileExtensionError> =>
    packageExists(profilePath, id).pipe(
      Effect.flatMap((exists) =>
        exists ? readSelectedPackage(profilePath, repositoryRoot, id) : Effect.succeed(undefined),
      ),
    );

  const validatePackages = (
    profilePath: string,
    repositoryRoot: string,
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<ExtensionPackage>, ProfileExtensionError> =>
    Effect.forEach(
      ids,
      (id) =>
        ensurePublished(profilePath, repositoryRoot, id).pipe(
          Effect.tap((packageInfo) =>
            validatePackageAutomationDefinitions(automation, profilePath, packageInfo),
          ),
        ),
      { concurrency: 1 },
    ).pipe(Effect.tap(validateAutomationOwnership));
  const validateExistingPackages = (
    profilePath: string,
    repositoryRoot: string,
    selected: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<ExtensionPackage>, ProfileExtensionError> => {
    const selectedSet = new Set(selected);
    return Effect.forEach(
      materializationIds(selected),
      (id) =>
        (selectedSet.has(id)
          ? readPresentPackage(profilePath, id)
          : readSelectedPackage(profilePath, repositoryRoot, id)
        ).pipe(
          Effect.tap((packageInfo) =>
            validatePackageAutomationDefinitions(automation, profilePath, packageInfo),
          ),
        ),
      { concurrency: 1 },
    ).pipe(Effect.tap(validateAutomationOwnership));
  };

  const equalSelection = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
    left.length === right.length && left.every((id, index) => id === right[index]);
  const equalSelectionSnapshot = (
    left: ExtensionSelectionSnapshot,
    right: ExtensionSelectionSnapshot,
  ): boolean =>
    left.exists === right.exists &&
    left.bytes.length === right.bytes.length &&
    left.bytes.every((byte, index) => byte === right.bytes[index]);
  const materializationIds = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
    [...new Set([...REQUIRED_BUNDLED_EXTENSION_IDS, ...ids])].sort((left, right) =>
      left.localeCompare(right),
    );

  const rollbackActions = (
    automation: ProfileExtensionAutomationOperations,
    profilePath: string,
    snapshot: ExtensionSelectionSnapshot,
    activated: ReadonlyArray<ActivatedAutomation>,
    paused: ReadonlyArray<PausedAutomation>,
  ): ReadonlyArray<RollbackAction> => [
    ...[...activated].reverse().map(({ id, activation, source }) => ({
      operation: `${activation === "installed" ? "remove newly installed" : "pause resumed"} automation`,
      path: path.join(profilePath, "automations", `${id}.md`),
      effect:
        activation === "installed"
          ? automation
              .remove({ name: path.basename(profilePath), path: profilePath }, id, source)
              .pipe(Effect.asVoid)
          : automation
              .pause({ name: path.basename(profilePath), path: profilePath }, id)
              .pipe(Effect.asVoid),
    })),
    ...[...paused].reverse().map(({ id }) => ({
      operation: "resume paused automation",
      path: path.join(profilePath, "automations", `${id}.paused.md`),
      effect: automation
        .resume({ name: path.basename(profilePath), path: profilePath }, id)
        .pipe(Effect.asVoid),
    })),
    {
      operation: "restore extensions.json",
      path: path.join(profilePath, "extensions.json"),
      effect: restoreExtensionSelection(profilePath, snapshot),
    },
  ];

  const provisionAdditions = (
    automation: ProfileExtensionAutomationOperations,
    profilePath: string,
    added: ReadonlyArray<ExtensionPackage>,
    activated: Array<ActivatedAutomation>,
  ): Effect.Effect<void, ProfileExtensionError> =>
    Effect.gen(function* () {
      for (const packageInfo of added) {
        const result = yield* provisionOwnedAutomations(automation, profilePath, packageInfo);
        activated.push(...result.activated);
        if (result.failure !== undefined) return yield* result.failure;
      }
    });

  const listForProfile = (profilePath: string, repositoryRoot: string) =>
    lock
      .withLock(
        profilePath,
        Effect.all({
          catalogue: list(repositoryRoot),
          profileOwned: scanOptionalExtensionShelf(profilePath),
          selected: readExtensionSelection(profilePath),
        }),
      )
      .pipe(
        Effect.map(({ catalogue, profileOwned, selected }) => {
          const availableById = new Map<string, ProfileExtensionChoice>(
            catalogue.flatMap((extension) =>
              extension.required
                ? []
                : [
                    [
                      extension.id,
                      {
                        id: extension.id,
                        description: extension.description,
                        kind: extension.kind,
                        source: extension.source,
                      },
                    ] as const,
                  ],
            ),
          );
          for (const extension of profileOwned) {
            if (!extension.required) {
              availableById.set(extension.id, {
                id: extension.id,
                description: extension.description,
                kind: extension.kind,
                source: "profile",
              });
            }
          }
          return {
            available: [...availableById.values()].sort((left, right) =>
              left.id.localeCompare(right.id),
            ),
            selected,
          } satisfies ProfileExtensionListing;
        }),
      );

  const add = (target: ProfileTarget, repositoryRoot: string, id: string) =>
    verifyInitialized(target.path).pipe(
      Effect.andThen(
        lock.withLock(
          target.path,
          Effect.gen(function* () {
            const current = yield* readExtensionSelection(target.path);
            if (current.includes(id)) {
              return {
                id,
                profilePath: target.path,
                changed: false,
                selected: true,
              } satisfies ProfileExtensionMutation;
            }
            const snapshot = yield* snapshotExtensionSelection(target.path);
            const requested = yield* decodeRequestedSelection(target.path, [...current, id]);
            const packages = yield* validatePackages(
              target.path,
              repositoryRoot,
              materializationIds(requested),
            );
            yield* preflight.preflight(target.path, repositoryRoot, requested);
            const activated: Array<ActivatedAutomation> = [];
            const addedIds = new Set(requested.filter((candidate) => !current.includes(candidate)));
            yield* Effect.gen(function* () {
              yield* replaceExtensionSelection(target.path, requested);
              yield* provisionAdditions(
                automation,
                target.path,
                packages.filter((packageInfo) => addedIds.has(packageInfo.id)),
                activated,
              );
            }).pipe(
              Effect.catch((failure) =>
                rollbackMutation(
                  target.path,
                  "add",
                  failure,
                  rollbackActions(automation, target.path, snapshot, activated, []),
                ),
              ),
            );
            return {
              id,
              profilePath: target.path,
              changed: true,
              selected: true,
            } satisfies ProfileExtensionMutation;
          }),
        ),
      ),
    );

  const remove = (target: ProfileTarget, repositoryRoot: string, id: string) =>
    verifyInitialized(target.path).pipe(
      Effect.andThen(
        lock.withLock(
          target.path,
          Effect.gen(function* () {
            const requested = yield* decodeRequestedSelection(target.path, [id]);
            const requestedId = requested[0];
            if (requestedId === undefined) {
              return yield* selectionInvalid(target.path, "invalid extension selection");
            }
            const current = yield* readExtensionSelection(target.path);
            if (!current.includes(requestedId)) {
              return {
                id: requestedId,
                profilePath: target.path,
                changed: false,
                selected: false,
              } satisfies ProfileExtensionMutation;
            }
            const snapshot = yield* snapshotExtensionSelection(target.path);
            const packageInfo = yield* readOptionalPresentPackage(
              target.path,
              repositoryRoot,
              requestedId,
            );
            if (packageInfo?.required === true) {
              return yield* selectionInvalid(
                target.path,
                `required extension '${requestedId}' cannot be added or removed`,
              );
            }
            if (packageInfo !== undefined) {
              yield* validatePackageAutomationDefinitions(automation, target.path, packageInfo);
            }
            const next = current.filter((candidate) => candidate !== requestedId);
            yield* validateExistingPackages(target.path, repositoryRoot, next);
            yield* preflight.preflight(target.path, repositoryRoot, next);
            const paused: Array<PausedAutomation> = [];
            yield* Effect.gen(function* () {
              if (packageInfo !== undefined) {
                yield* pauseOwnedAutomations(automation, target.path, packageInfo, paused);
              }
              yield* replaceExtensionSelection(target.path, next);
            }).pipe(
              Effect.catch((failure) =>
                rollbackMutation(
                  target.path,
                  "remove",
                  failure,
                  rollbackActions(automation, target.path, snapshot, [], paused),
                ),
              ),
            );
            return {
              id: requestedId,
              profilePath: target.path,
              changed: true,
              selected: false,
            } satisfies ProfileExtensionMutation;
          }),
        ),
      ),
    );

  const setSelected = (target: ProfileTarget, repositoryRoot: string, ids: ReadonlyArray<string>) =>
    verifyInitialized(target.path).pipe(
      Effect.andThen(
        lock.withLock(
          target.path,
          Effect.gen(function* () {
            const current = yield* readExtensionSelection(target.path);
            const next = yield* decodeRequestedSelection(target.path, ids);
            if (equalSelection(current, next)) {
              return { changed: false, selected: current } satisfies ProfileExtensionSetResult;
            }
            const snapshot = yield* snapshotExtensionSelection(target.path);
            const currentSet = new Set(current);
            const nextSet = new Set(next);
            const removed = current.filter((id) => !nextSet.has(id));
            const added = next.filter((id) => !currentSet.has(id));
            const removedPackages = yield* Effect.forEach(
              removed,
              (id) => readOptionalPresentPackage(target.path, repositoryRoot, id),
              { concurrency: 1 },
            );
            yield* Effect.forEach(
              removedPackages.filter(
                (packageInfo): packageInfo is ExtensionPackage => packageInfo !== undefined,
              ),
              (packageInfo) =>
                validatePackageAutomationDefinitions(automation, target.path, packageInfo),
              { discard: true, concurrency: 1 },
            );
            const nextPackages = yield* added.length > 0
              ? validatePackages(target.path, repositoryRoot, materializationIds(next))
              : validateExistingPackages(target.path, repositoryRoot, next);
            yield* preflight.preflight(target.path, repositoryRoot, next);
            const paused: Array<PausedAutomation> = [];
            const activated: Array<ActivatedAutomation> = [];
            const addedSet = new Set(added);
            yield* Effect.gen(function* () {
              for (const packageInfo of removedPackages) {
                if (packageInfo !== undefined) {
                  yield* pauseOwnedAutomations(automation, target.path, packageInfo, paused);
                }
              }
              yield* replaceExtensionSelection(target.path, next);
              yield* provisionAdditions(
                automation,
                target.path,
                nextPackages.filter((packageInfo) => addedSet.has(packageInfo.id)),
                activated,
              );
            }).pipe(
              Effect.catch((failure) =>
                rollbackMutation(
                  target.path,
                  "set-selected",
                  failure,
                  rollbackActions(automation, target.path, snapshot, activated, paused),
                ),
              ),
            );
            return { changed: true, selected: next } satisfies ProfileExtensionSetResult;
          }),
        ),
      ),
    );

  const validate = (target: ProfileTarget, repositoryRoot: string) =>
    verifyInitialized(target.path).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const before = yield* snapshotExtensionSelection(target.path);
          const selected = before.selected;
          yield* validateExistingPackages(target.path, repositoryRoot, selected);
          const preflightResult = yield* preflight
            .preflight(target.path, repositoryRoot, selected)
            .pipe(Effect.result);
          const after = yield* snapshotExtensionSelection(target.path);
          if (!equalSelectionSnapshot(before, after)) {
            return yield* selectionInvalid(
              target.path,
              "read-only Profile extension validation changed extensions.json",
            );
          }
          if (Result.isFailure(preflightResult)) return yield* preflightResult.failure;
          return {
            selected,
            preflight: preflightResult.success,
          } satisfies ProfileExtensionValidation;
        }),
      ),
    );

  const prepareRuntime = (profilePath: string, repositoryRoot: string) =>
    verifyInitialized(profilePath)
      .pipe(
        Effect.andThen(
          lock.withLock(
            profilePath,
            Effect.gen(function* () {
              const snapshot = yield* snapshotExtensionSelection(profilePath);
              const selected = snapshot.selected;
              yield* validatePackages(profilePath, repositoryRoot, materializationIds(selected));
              yield* preflight.preflight(profilePath, repositoryRoot, selected);
              const preparation: ProfileExtensionRuntimePreparation = {
                selected,
                generation: extensionSelectionGeneration(snapshot),
              };
              return preparation;
            }),
          ),
        ),
      )
      .pipe(Effect.mapError((cause) => runtimeFailure(profilePath, cause)));

  const activateRuntime = (
    profilePath: string,
    repositoryRoot: string,
    preparation: ProfileExtensionRuntimePreparation,
  ) =>
    verifyInitialized(profilePath)
      .pipe(
        Effect.andThen(
          lock.withLock(
            profilePath,
            Effect.gen(function* () {
              const snapshot = yield* snapshotExtensionSelection(profilePath);
              const selected = yield* readExtensionSelection(profilePath);
              if (
                !equalSelection(selected, preparation.selected) ||
                extensionSelectionGeneration(snapshot) !== preparation.generation
              ) {
                return yield* selectionInvalid(
                  profilePath,
                  "Profile extension selection changed while the Pi runtime was being constructed",
                );
              }
              const packages = yield* validateExistingPackages(
                profilePath,
                repositoryRoot,
                preparation.selected,
              );
              const activated: Array<ActivatedAutomation> = [];
              yield* provisionAdditions(automation, profilePath, packages, activated).pipe(
                Effect.catch((failure) =>
                  rollbackMutation(
                    profilePath,
                    "activate-runtime",
                    failure,
                    rollbackActions(automation, profilePath, snapshot, activated, []),
                  ),
                ),
              );
            }),
          ),
        ),
      )
      .pipe(Effect.mapError((cause) => runtimeFailure(profilePath, cause)));

  const api: ProfileExtensionsApi = {
    list,
    show,
    listForProfile,
    add,
    remove,
    setSelected,
    validate,
    prepareRuntime,
    activateRuntime,
  };
  return api;
};

export const ProfileExtensionsLive = Layer.effect(
  ProfileExtensions,
  Effect.gen(function* () {
    return makeProfileExtensions(
      yield* ExtensionArchiveClient,
      yield* ProfileExtensionPreflight,
      yield* ProfileExtensionMutationLock,
    );
  }),
);
