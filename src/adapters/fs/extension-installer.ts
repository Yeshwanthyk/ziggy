import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import {
  ExtensionCatalogInstallFailed,
  type BundledExtensionCatalogEntry,
  type GitHubExtensionCatalogEntry,
} from "../../domain/extension-catalog";
import type { ExtensionArchiveClientShape } from "../github/extension-catalog";
import { fileSystemCauseDetails } from "./cause";
import { readExtensionPackage } from "./profile-extensions";

export interface ExtensionArchiveExtractor {
  readonly extract: (
    archivePath: string,
    destinationPath: string,
  ) => Effect.Effect<void, ExtensionCatalogInstallFailed>;
}

type CatalogEntry = BundledExtensionCatalogEntry | GitHubExtensionCatalogEntry;

const installFailure = (
  entry: CatalogEntry,
  targetPath: string,
  reason: ConstructorParameters<typeof ExtensionCatalogInstallFailed>[0]["reason"],
  message: string,
  cause: unknown,
) => new ExtensionCatalogInstallFailed({ id: entry.id, path: targetPath, reason, message, cause });

const safeArchiveEntry = (entry: string): boolean => {
  const normalized = entry.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.split("/").some((part) => part === "..")
  );
};

const runTar = (args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(stderr.trim() || `tar exited ${exitCode}`);
      return stdout;
    },
    catch: (cause) => cause,
  });

export const systemTarExtractor: ExtensionArchiveExtractor = {
  extract: (archivePath, destinationPath) =>
    Effect.gen(function* () {
      const failure = (message: string, cause: unknown) =>
        new ExtensionCatalogInstallFailed({
          id: path.basename(destinationPath),
          path: destinationPath,
          reason: "archive",
          message,
          cause,
        });
      const verbose = yield* runTar(["-tvzf", archivePath]).pipe(
        Effect.mapError((cause) => failure("could not inspect extension archive", cause)),
      );
      const rows = verbose.split(/\r?\n/u).filter((row) => row.length > 0);
      const listing = yield* runTar(["-tzf", archivePath]).pipe(
        Effect.mapError((cause) => failure("could not inspect extension archive", cause)),
      );
      const names = listing.split(/\r?\n/u).filter((name) => name.length > 0);
      if (
        names.length === 0 ||
        names.some((name) => !safeArchiveEntry(name)) ||
        rows.some((row) => !row.startsWith("-") && !row.startsWith("d"))
      ) {
        return yield* Effect.fail(failure("extension archive contains an unsafe entry", undefined));
      }
      yield* runTar([
        "-xzf",
        archivePath,
        "-C",
        destinationPath,
        "--strip-components=1",
        "--no-same-owner",
        "--no-same-permissions",
      ]).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => failure("could not extract extension archive", cause)),
      );
    }).pipe(Effect.asVoid),
};

const inspectTree = (
  entry: CatalogEntry,
  root: string,
): Effect.Effect<void, ExtensionCatalogInstallFailed> =>
  Effect.gen(function* () {
    const status = yield* Effect.tryPromise({
      try: () => lstat(root),
      catch: (cause) => cause,
    }).pipe(
      Effect.mapError((cause) =>
        installFailure(entry, root, "filesystem", "could not inspect extension source", cause),
      ),
    );
    if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
      return yield* Effect.fail(
        installFailure(
          entry,
          root,
          "validation",
          "extension contains a symbolic link or special file",
          undefined,
        ),
      );
    }
    if (!status.isDirectory()) return;
    const children = yield* Effect.tryPromise({
      try: () => readdir(root),
      catch: (cause) => cause,
    }).pipe(
      Effect.mapError((cause) =>
        installFailure(entry, root, "filesystem", "could not inspect extension source", cause),
      ),
    );
    yield* Effect.forEach(children, (child) => inspectTree(entry, path.join(root, child)), {
      discard: true,
    });
  });

const destinationAvailable = (entry: CatalogEntry, destinationPath: string) =>
  Effect.tryPromise({ try: () => lstat(destinationPath), catch: (cause) => cause }).pipe(
    Effect.flatMap((status) =>
      !status.isDirectory() || status.isSymbolicLink()
        ? Effect.fail(
            installFailure(
              entry,
              destinationPath,
              "filesystem",
              "extension destination is not a physical directory",
              undefined,
            ),
          )
        : Effect.succeed(false),
    ),
    Effect.catchIf(
      (cause) => fileSystemCauseDetails(cause).code === "ENOENT",
      () => Effect.succeed(true),
    ),
    Effect.mapError((cause) =>
      cause instanceof ExtensionCatalogInstallFailed
        ? cause
        : installFailure(
            entry,
            destinationPath,
            "filesystem",
            "could not inspect extension destination",
            cause,
          ),
    ),
  );

const cleanup = (temporaryRoot: string) =>
  Effect.tryPromise({
    try: () => rm(temporaryRoot, { recursive: true, force: true }),
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.void));

const publishSource = (
  profilePath: string,
  entry: CatalogEntry,
  sourcePath: string,
): Effect.Effect<string, ExtensionCatalogInstallFailed> => {
  const extensionRoot = path.join(profilePath, "extensions");
  const destinationPath = path.join(extensionRoot, entry.id);
  return Effect.gen(function* () {
    if (!(yield* destinationAvailable(entry, destinationPath))) return destinationPath;
    const temporaryRoot = yield* Effect.tryPromise({
      try: () => mkdtemp(path.join(profilePath, ".ziggy-extension-")),
      catch: (cause) => cause,
    }).pipe(
      Effect.mapError((cause) =>
        installFailure(
          entry,
          profilePath,
          "filesystem",
          "could not create extension staging directory",
          cause,
        ),
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.succeed(temporaryRoot),
      (stagingRoot) =>
        Effect.gen(function* () {
          const stagedShelf = path.join(stagingRoot, "shelf");
          const stagedPackage = path.join(stagedShelf, "extensions", entry.id);
          yield* inspectTree(entry, sourcePath);
          yield* Effect.tryPromise({
            try: () =>
              cp(sourcePath, stagedPackage, { recursive: true, errorOnExist: true, force: false }),
            catch: (cause) => cause,
          }).pipe(
            Effect.mapError((cause) =>
              installFailure(
                entry,
                stagedPackage,
                "filesystem",
                "could not stage extension package",
                cause,
              ),
            ),
          );
          yield* inspectTree(entry, stagedPackage);
          yield* readExtensionPackage(stagedShelf, entry.id).pipe(
            Effect.mapError((cause) =>
              installFailure(
                entry,
                stagedPackage,
                "validation",
                "extension failed package validation",
                cause,
              ),
            ),
          );
          yield* Effect.tryPromise({
            try: () => mkdir(extensionRoot, { recursive: true }),
            catch: (cause) => cause,
          }).pipe(
            Effect.mapError((cause) =>
              installFailure(
                entry,
                extensionRoot,
                "filesystem",
                "could not create Profile extension shelf",
                cause,
              ),
            ),
          );
          yield* Effect.tryPromise({
            try: () => rename(stagedPackage, destinationPath),
            catch: (cause) => cause,
          }).pipe(
            Effect.mapError((cause) =>
              installFailure(
                entry,
                destinationPath,
                "filesystem",
                "could not publish Profile extension",
                cause,
              ),
            ),
          );
          return destinationPath;
        }),
      cleanup,
    );
  });
};

export const makeExtensionInstaller = (
  client: ExtensionArchiveClientShape,
  extractor: ExtensionArchiveExtractor = systemTarExtractor,
) => ({
  installBundled: (
    profilePath: string,
    repositoryRoot: string,
    entry: BundledExtensionCatalogEntry,
  ) => publishSource(profilePath, entry, path.resolve(repositoryRoot, entry.path)),
  installGitHub: (profilePath: string, entry: GitHubExtensionCatalogEntry) =>
    Effect.gen(function* () {
      const temporaryRoot = yield* Effect.tryPromise({
        try: () => mkdtemp(path.join(profilePath, ".ziggy-download-")),
        catch: (cause) => cause,
      }).pipe(
        Effect.mapError((cause) =>
          installFailure(
            entry,
            profilePath,
            "filesystem",
            "could not create download staging directory",
            cause,
          ),
        ),
      );
      return yield* Effect.acquireUseRelease(
        Effect.succeed(temporaryRoot),
        (downloadRoot) =>
          Effect.gen(function* () {
            const archivePath = path.join(downloadRoot, "package.tar.gz");
            const checkoutPath = path.join(downloadRoot, "checkout");
            yield* Effect.tryPromise({
              try: () => mkdir(checkoutPath),
              catch: (cause) => cause,
            }).pipe(
              Effect.mapError((cause) =>
                installFailure(
                  entry,
                  checkoutPath,
                  "filesystem",
                  "could not create archive staging directory",
                  cause,
                ),
              ),
            );
            const archive = yield* client
              .download(entry)
              .pipe(
                Effect.mapError((cause) =>
                  installFailure(entry, archivePath, "download", cause.message, cause),
                ),
              );
            if (createHash("sha256").update(archive).digest("hex") !== entry.archiveSha256) {
              return yield* Effect.fail(
                installFailure(
                  entry,
                  archivePath,
                  "checksum",
                  "extension archive checksum mismatch",
                  undefined,
                ),
              );
            }
            yield* Effect.tryPromise({
              try: () => writeFile(archivePath, archive),
              catch: (cause) => cause,
            }).pipe(
              Effect.mapError((cause) =>
                installFailure(
                  entry,
                  archivePath,
                  "filesystem",
                  "could not stage extension archive",
                  cause,
                ),
              ),
            );
            yield* extractor.extract(archivePath, checkoutPath);
            const sourcePath = path.resolve(checkoutPath, entry.path);
            const relative = path.relative(checkoutPath, sourcePath);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            ) {
              return yield* Effect.fail(
                installFailure(
                  entry,
                  sourcePath,
                  "archive",
                  "catalogue path escapes downloaded archive",
                  undefined,
                ),
              );
            }
            return yield* publishSource(profilePath, entry, sourcePath);
          }),
        cleanup,
      );
    }),
});
