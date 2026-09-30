import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Effect, Schema } from "effect";
import { fileSystemCauseDetails } from "./cause";

class TreeRefused extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

/**
 * A tree operation failed. `refused` means the content broke a package rule (a symlink,
 * a missing or escaping file); otherwise the filesystem itself failed and `code` says how.
 */
export class TreeFailed extends Schema.TaggedErrorClass<TreeFailed>()("TreeFailed", {
  path: Schema.String,
  refused: Schema.Boolean,
  message: Schema.String,
  code: Schema.UndefinedOr(Schema.String),
  cause: Schema.Defect(),
}) {}

const run = <A>(path: string, operation: () => Promise<A>): Effect.Effect<A, TreeFailed> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => {
      if (cause instanceof TreeRefused) {
        return new TreeFailed({
          path: cause.path,
          refused: true,
          message: cause.message,
          code: undefined,
          cause,
        });
      }

      const details = fileSystemCauseDetails(cause);

      return new TreeFailed({
        path,
        refused: false,
        message: details.message,
        code: details.code,
        cause,
      });
    },
  });

/**
 * Hash a directory by relative path, kind, permission bits and file bytes.
 * Update receipts store this digest, so the algorithm must never change.
 */
const hashTreeAsync = async (root: string): Promise<string> => {
  const hash = createHash("sha256");

  const walk = async (path: string, relative: string): Promise<void> => {
    const status = await lstat(path);

    if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
      throw new TreeRefused(path, "Package contains a symlink or special file.");
    }

    hash.update(
      JSON.stringify([relative, status.isDirectory() ? "directory" : "file", status.mode & 0o777]),
    );

    if (status.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await walk(join(path, name), `${relative}/${name}`);
      }
    } else {
      hash.update(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      );
    }
  };

  await walk(root, "");

  return hash.digest("hex");
};

/** Refuse symlinks and special files anywhere below `root`. */
const inspectTreeAsync = async (root: string): Promise<void> => {
  const status = await lstat(root);

  if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
    throw new TreeRefused(root, "extension contains a symbolic link or special file");
  }

  if (!status.isDirectory()) return;

  for (const child of await readdir(root)) await inspectTreeAsync(join(root, child));
};

/**
 * Write embedded package files into `target`, keeping their modes.
 * `files` are logical paths under `sourcePath`; `locate` maps one to a real file.
 */
const copyEmbeddedPackageAsync = async (
  target: string,
  sourcePath: string,
  files: ReadonlyArray<string>,
  locate: (logicalPath: string) => string | undefined,
): Promise<void> => {
  for (const file of files) {
    const embedded = locate(file);

    if (embedded === undefined) {
      throw new TreeRefused(file, `bundled extension file is missing: ${file}`);
    }

    const relative = posix.relative(sourcePath, file);

    if (relative === "" || relative.startsWith("..")) {
      throw new TreeRefused(file, `bundled extension file escapes package: ${file}`);
    }

    const destination = join(target, ...relative.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(embedded), { mode: (await stat(embedded)).mode });
  }
};

/**
 * Read a file that must be a physical (non-symlink) regular file.
 * Returns `undefined` when it does not exist.
 */
const readPhysicalFileAsync = async (path: string): Promise<Uint8Array | undefined> => {
  const status = await lstat(path).catch((cause: unknown) =>
    fileSystemCauseDetails(cause).code === "ENOENT" ? undefined : Promise.reject(cause),
  );

  if (status === undefined) return undefined;

  if (status.isSymbolicLink() || !status.isFile()) {
    throw new TreeRefused(path, "must be a physical file");
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (cause: unknown) =>
      Promise.reject(
        fileSystemCauseDetails(cause).code === "ELOOP"
          ? new TreeRefused(path, "must be a physical file")
          : cause,
      ),
  );

  try {
    if (!(await handle.stat()).isFile()) throw new TreeRefused(path, "must be a physical file");

    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
};

export const hashTree = (root: string): Effect.Effect<string, TreeFailed> =>
  run(root, () => hashTreeAsync(root));

export const inspectTree = (root: string): Effect.Effect<void, TreeFailed> =>
  run(root, () => inspectTreeAsync(root));

export const copyEmbeddedPackage = (
  target: string,
  sourcePath: string,
  files: ReadonlyArray<string>,
  locate: (logicalPath: string) => string | undefined,
): Effect.Effect<void, TreeFailed> =>
  run(target, () => copyEmbeddedPackageAsync(target, sourcePath, files, locate));

export const readPhysicalFile = (path: string): Effect.Effect<Uint8Array | undefined, TreeFailed> =>
  run(path, () => readPhysicalFileAsync(path));
