import { lstat, readFile } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer, Predicate } from "effect";
import { BUILTIN_CORE_SKILLS, BUILTIN_EXTENSION_CATALOG, bundledPackageMetadata } from "../catalog";
import {
  ExtensionCatalog,
  ExtensionCatalogInstallFailed,
  ExtensionCatalogInvalid,
  ExtensionCatalogUnavailable,
  type GitHubExtensionCatalogEntry,
} from "../domain/extension-catalog";
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
  type ExtensionPackage,
} from "../adapters/fs/profile-extensions";
import {
  automationFileStore,
  installAutomationDefinition,
  pauseAutomationDefinition,
} from "../adapters/fs/automation-files";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import { parseAutomationFile, validateAutomationId } from "../domain/automation";
import type { ProfileExtensionError } from "./profiles";

export interface ExtensionCatalogListing {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly kind: "skill" | "code" | "skill+code" | "remote";
  readonly required: boolean;
  readonly source: "bundled" | "remote-approved";
  readonly installed: boolean;
  readonly packagePath?: string;
  readonly skills?: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly extensionPaths?: ReadonlyArray<string>;
}

export interface ExtensionCatalogApi {
  readonly list: (
    repositoryRoot: string,
  ) => Effect.Effect<
    ReadonlyArray<ExtensionCatalogListing>,
    ExtensionCatalogInvalid | ProfileExtensionError
  >;
  readonly show: (
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<ExtensionCatalogListing, ExtensionCatalogInvalid | ProfileExtensionError>;
  readonly ensureInstalled: (
    profilePath: string,
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<
    string,
    | ExtensionCatalogInstallFailed
    | ExtensionCatalogInvalid
    | ExtensionCatalogUnavailable
    | ProfileExtensionError
  >;
  readonly deactivate: (
    profilePath: string,
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<void, ExtensionCatalogInstallFailed | ProfileExtensionError>;
  readonly materialize: (
    profilePath: string,
    repositoryRoot: string,
  ) => Effect.Effect<
    void,
    | ExtensionCatalogInstallFailed
    | ExtensionCatalogInvalid
    | ExtensionCatalogUnavailable
    | ProfileExtensionError
  >;
}

export class ExtensionCatalogService extends Context.Service<
  ExtensionCatalogService,
  ExtensionCatalogApi
>()("ziggy/ExtensionCatalogService") {}

const bundledListing = (
  id: string,
  version: string,
): Effect.Effect<ExtensionCatalogListing, ExtensionCatalogInvalid> => {
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

const remoteListing = (
  entry: GitHubExtensionCatalogEntry,
  installed: boolean,
): ExtensionCatalogListing => ({
  id: entry.id,
  version: entry.version,
  description: entry.description,
  kind: "remote",
  required: false,
  source: entry.source === "github" ? "remote-approved" : "bundled",
  installed,
});

const provisionAutomations = (profilePath: string, packageInfo: ExtensionPackage) =>
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
            new ExtensionCatalogInstallFailed({
              id: packageInfo.id,
              path: declared.path,
              reason: "validation",
              message: `automation ${id} must declare owner: ${owner}`,
              cause: undefined,
            }),
          );
        }
        const target = { name: path.basename(profilePath), path: profilePath };
        const existing = yield* installAutomationDefinition(target, id, source).pipe(
          Effect.as(undefined),
          Effect.catch(() => automationFileStore.readDefinition(target, id, true)),
        );
        if (existing === undefined) return;
        const parsed = yield* parseAutomationFile(id, existing.path, existing.source);
        if (parsed.owner !== owner || existing.source !== source) {
          return yield* Effect.fail(
            new ExtensionCatalogInstallFailed({
              id: packageInfo.id,
              path: existing.path,
              reason: "validation",
              message: `automation ${id} already exists and is not the exact ${owner} definition`,
              cause: undefined,
            }),
          );
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ExtensionCatalogInstallFailed
            ? cause
            : new ExtensionCatalogInstallFailed({
                id: packageInfo.id,
                path: declared.path,
                reason: "validation",
                message: `could not provision extension automation '${declared.id}' without overwriting Profile state`,
                cause,
              }),
        ),
      ),
    { discard: true },
  );

const pauseOwnedAutomations = (profilePath: string, packageInfo: ExtensionPackage) =>
  Effect.forEach(
    packageInfo.automations,
    (declared) =>
      Effect.gen(function* () {
        const id = yield* validateAutomationId(declared.id);
        const target = { name: path.basename(profilePath), path: profilePath };
        const existing = yield* automationFileStore.readDefinition(target, id, true).pipe(
          Effect.catchIf(
            (failure) => Predicate.isTagged(failure, "AutomationNotFound"),
            () => Effect.succeed(undefined),
          ),
        );
        if (existing === undefined || existing.lifecycle === "paused") return;
        const parsed = yield* parseAutomationFile(id, existing.path, existing.source);
        const owner = `extension:${packageInfo.id}`;
        if (parsed.owner !== owner) {
          return yield* Effect.fail(
            new ExtensionCatalogInstallFailed({
              id: packageInfo.id,
              path: existing.path,
              reason: "validation",
              message: `refusing to pause automation ${id} because it is not owned by ${owner}`,
              cause: undefined,
            }),
          );
        }
        yield* pauseAutomationDefinition(target, id);
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ExtensionCatalogInstallFailed
            ? cause
            : new ExtensionCatalogInstallFailed({
                id: packageInfo.id,
                path: declared.path,
                reason: "filesystem",
                message: `could not safely pause owned automation '${declared.id}'`,
                cause,
              }),
        ),
      ),
    { discard: true },
  );

const makeExtensionCatalogService = (
  archiveClient: ExtensionArchiveClientApi,
  catalog: ExtensionCatalog,
  extractor?: ExtensionArchiveExtractor,
): ExtensionCatalogApi => {
  const installer = makeExtensionInstaller(archiveClient, extractor);
  const entryFor = (id: string) => catalog.extensions.find((entry) => entry.id === id);

  const list = (_repositoryRoot: string) =>
    Effect.forEach(catalog.extensions, (entry) =>
      entry.source === "bundled"
        ? bundledListing(entry.id, entry.version)
        : Effect.succeed(remoteListing(entry, false)),
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

  const ensureInstalled = (profilePath: string, _repositoryRoot: string, id: string) =>
    Effect.gen(function* () {
      const entry = entryFor(id);
      const profilePackagePath = `${profilePath}/extensions/${id}`;
      const profileOwned = yield* Effect.tryPromise({
        try: () => lstat(profilePackagePath),
        catch: (cause) => cause,
      }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (cause) => fileSystemCauseDetails(cause).code === "ENOENT",
          () => Effect.succeed(false),
        ),
        Effect.mapError(
          (cause) =>
            new ExtensionCatalogInstallFailed({
              id,
              path: profilePackagePath,
              reason: "filesystem",
              message: "could not inspect Profile extension package",
              cause,
            }),
        ),
      );
      if (profileOwned) {
        const installed = yield* readExtensionPackage(profilePath, id).pipe(
          Effect.mapError(
            (cause) =>
              new ExtensionCatalogInstallFailed({
                id,
                path: profilePackagePath,
                reason: "validation",
                message: "installed Profile extension failed validation",
                cause,
              }),
          ),
        );
        yield* provisionAutomations(profilePath, installed);
        return profilePackagePath;
      }
      if (entry === undefined) {
        return yield* Effect.fail(
          new ExtensionCatalogInvalid({
            source: id,
            message: `unknown extension '${id}'; it is neither approved nor Profile-local`,
            cause: undefined,
          }),
        );
      }
      if (entry.source === "github") {
        yield* installer.installGitHub(profilePath, entry);
      } else {
        yield* installer.installBundled(profilePath, entry);
      }
      const copied = yield* readExtensionPackage(profilePath, id).pipe(
        Effect.mapError(
          (cause) =>
            new ExtensionCatalogInstallFailed({
              id,
              path: profilePackagePath,
              reason: "validation",
              message: "installed Profile extension failed validation",
              cause,
            }),
        ),
      );
      yield* provisionAutomations(profilePath, copied);
      return profilePackagePath;
    });

  const materialize = (profilePath: string, repositoryRoot: string) =>
    Effect.gen(function* () {
      yield* ensureInstalled(profilePath, repositoryRoot, "pi-packages");
      yield* Effect.forEach(BUILTIN_CORE_SKILLS, (skill) =>
        installer.installRequiredSkill(profilePath, {
          id: skill.id,
          description: skill.description,
          files: [...skill.files],
        }),
      );
      const selected = yield* readExtensionSelection(profilePath);
      yield* Effect.forEach(selected, (id) => ensureInstalled(profilePath, repositoryRoot, id));
    });

  const deactivate = (profilePath: string, repositoryRoot: string, id: string) =>
    Effect.gen(function* () {
      if (entryFor(id) === undefined) {
        const exists = yield* Effect.tryPromise({
          try: () => lstat(`${profilePath}/extensions/${id}`),
          catch: (cause) => cause,
        }).pipe(
          Effect.as(true),
          Effect.catchIf(
            (cause) => fileSystemCauseDetails(cause).code === "ENOENT",
            () => Effect.succeed(false),
          ),
          Effect.mapError(
            (cause) =>
              new ExtensionCatalogInstallFailed({
                id,
                path: `${profilePath}/extensions/${id}`,
                reason: "filesystem",
                message: "could not inspect Profile-local extension during removal",
                cause,
              }),
          ),
        );
        if (!exists) return;
      }
      const packageInfo = yield* readSelectedExtensionPackage(profilePath, repositoryRoot, id);
      yield* pauseOwnedAutomations(profilePath, packageInfo);
    });

  return { list, show, ensureInstalled, deactivate, materialize };
};

export const makeExtensionCatalogLive = (
  archiveClient: ExtensionArchiveClientApi,
  catalog: ExtensionCatalog = BUILTIN_EXTENSION_CATALOG,
  extractor?: ExtensionArchiveExtractor,
) => makeExtensionCatalogService(archiveClient, catalog, extractor);

export const ExtensionCatalogServiceLive = Layer.effect(
  ExtensionCatalogService,
  Effect.gen(function* () {
    const archiveClient = yield* ExtensionArchiveClient;
    return makeExtensionCatalogService(archiveClient, BUILTIN_EXTENSION_CATALOG);
  }),
);
