import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect, Exit, Schema } from "effect";

export type AutomationPublicationPoint =
  | "after-temporary-write"
  | "before-expected-read"
  | "after-expected-read"
  | "before-create-temporary-remove";

export interface AutomationAuthoringNodeHooks {
  readonly onPublicationPoint?: (point: AutomationPublicationPoint) => void;
}

export class AutomationNodeError extends Schema.TaggedErrorClass<AutomationNodeError>(
  "@ziggy/core/automations/AutomationNodeError",
)("AutomationNodeError", {
  operation: Schema.String,
  code: Schema.Literals(["conflict", "not-found", "operation-failed"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface AutomationAuthoringNodeAdapter {
  readonly initialize: Effect.Effect<void, AutomationNodeError>;
  readonly listNames: Effect.Effect<ReadonlyArray<string>, AutomationNodeError>;
  read(id: string): Effect.Effect<Uint8Array | undefined, AutomationNodeError>;
  create(id: string, content: Uint8Array): Effect.Effect<void, AutomationNodeError>;
  update(
    id: string,
    content: Uint8Array,
    expectedContent: Uint8Array,
  ): Effect.Effect<void, AutomationNodeError>;
  delete(id: string, expectedContent: Uint8Array): Effect.Effect<void, AutomationNodeError>;
}

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface FileSnapshot {
  readonly bytes: Uint8Array;
  readonly status: BigIntStats;
}

const TEMPORARY_NAME_PATTERN =
  /^\.([a-z0-9]+(?:-[a-z0-9]+)*)\.md\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export function createAutomationAuthoringNodeAdapter(
  profilePath: string,
  hooks: AutomationAuthoringNodeHooks = {},
): AutomationAuthoringNodeAdapter {
  const directory = join(profilePath, "automations");
  const pathFor = (id: string) => join(directory, `${id}.md`);
  const ensureDirectory = nodeMkdir(directory).pipe(
    Effect.andThen(inspectSafeDirectory(directory)),
    Effect.asVoid,
  );
  return {
    initialize: ensureDirectory.pipe(Effect.andThen(recoverTemporaryFiles(directory))),
    listNames: listNames(directory),
    read: (id) =>
      inspectSafeDirectory(directory).pipe(
        Effect.flatMap((identity) => readSnapshot(directory, identity, pathFor(id))),
        Effect.map((snapshot) => snapshot?.bytes),
      ),
    create: (id, content) => publish(pathFor(id), content, undefined, hooks),
    update: (id, content, expectedContent) => publish(pathFor(id), content, expectedContent, hooks),
    delete: (id, expectedContent) =>
      removeDefinition(directory, pathFor(id), expectedContent, hooks),
  };
}

function publish(
  path: string,
  content: Uint8Array,
  expectedContent: Uint8Array | undefined,
  hooks: AutomationAuthoringNodeHooks,
): Effect.Effect<void, AutomationNodeError> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  return inspectSafeDirectory(directory).pipe(
    Effect.flatMap((identity) =>
      Effect.acquireUseRelease(
        nodeOpen(
          temporaryPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        ),
        (temporaryHandle) =>
          Effect.gen(function* () {
            yield* nodeWrite(temporaryHandle, content).pipe(
              Effect.andThen(
                nodeSync(temporaryHandle, `sync temporary Automation ${temporaryPath}`),
              ),
            );
            yield* runHook(hooks, "after-temporary-write");
            const temporary = yield* readSnapshot(directory, identity, temporaryPath);
            if (temporary === undefined || !equalBytes(temporary.bytes, content)) {
              return yield* conflict("Automation temporary content changed before publication");
            }
            yield* runHook(hooks, "before-expected-read");
            const current = yield* readSnapshot(directory, identity, path);
            if (expectedContent === undefined) {
              if (current !== undefined) return yield* conflict("Automation already exists");
            } else {
              if (current === undefined)
                return yield* notFound("Automation disappeared before update");
              if (!equalBytes(current.bytes, expectedContent)) {
                return yield* conflict("Automation changed before update");
              }
            }
            yield* runHook(hooks, "after-expected-read");
            yield* commitPublication(
              directory,
              identity,
              path,
              temporaryPath,
              temporary.status,
              current,
              expectedContent === undefined,
              hooks,
            ).pipe(Effect.uninterruptible);
          }),
        (temporaryHandle, exit) =>
          releaseTemporary(temporaryHandle, temporaryPath, Exit.isSuccess(exit)),
      ),
    ),
  );
}

function commitPublication(
  directory: string,
  identity: DirectoryIdentity,
  path: string,
  temporaryPath: string,
  temporaryStatus: BigIntStats,
  current: FileSnapshot | undefined,
  creating: boolean,
  hooks: AutomationAuthoringNodeHooks,
): Effect.Effect<void, AutomationNodeError> {
  return Effect.gen(function* () {
    yield* requireDirectoryIdentity(directory, identity);
    yield* requirePathSnapshot(temporaryPath, temporaryStatus);
    if (creating) {
      yield* nodeLink(temporaryPath, path).pipe(
        Effect.catch((error) =>
          hasNodeCode(error.cause, "EEXIST")
            ? conflict("Automation already exists")
            : Effect.fail(error),
        ),
      );
      yield* runHook(hooks, "before-create-temporary-remove").pipe(
        Effect.andThen(nodeRemove(temporaryPath, false)),
        Effect.catch((error) =>
          rollbackLinkedCreate(directory, path, temporaryPath).pipe(
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
    } else {
      if (current === undefined) return yield* notFound("Automation disappeared before update");
      yield* requirePathSnapshot(path, current.status);
      yield* nodeRename(temporaryPath, path);
    }
    yield* requireDirectoryIdentity(directory, identity);
    yield* syncDirectory(directory);
  });
}

function removeDefinition(
  directory: string,
  path: string,
  expectedContent: Uint8Array,
  hooks: AutomationAuthoringNodeHooks,
): Effect.Effect<void, AutomationNodeError> {
  return Effect.gen(function* () {
    const identity = yield* inspectSafeDirectory(directory);
    yield* runHook(hooks, "before-expected-read");
    const current = yield* readSnapshot(directory, identity, path);
    if (current === undefined) return yield* notFound("Automation disappeared before delete");
    if (!equalBytes(current.bytes, expectedContent)) {
      return yield* conflict("Automation changed before delete");
    }
    yield* runHook(hooks, "after-expected-read");
    yield* Effect.gen(function* () {
      yield* requireDirectoryIdentity(directory, identity);
      yield* requirePathSnapshot(path, current.status);
      yield* nodeRemove(path, false);
      yield* syncDirectory(directory);
    }).pipe(Effect.uninterruptible);
  });
}

function readSnapshot(
  directory: string,
  identity: DirectoryIdentity,
  path: string,
): Effect.Effect<FileSnapshot | undefined, AutomationNodeError> {
  return Effect.gen(function* () {
    yield* requireDirectoryIdentity(directory, identity);
    const before = yield* safeLstat(path);
    if (before === undefined) {
      yield* requireDirectoryIdentity(directory, identity);
      return undefined;
    }
    yield* requireSafeFile(before, path);
    return yield* withHandle(path, constants.O_RDONLY | constants.O_NOFOLLOW, undefined, (handle) =>
      Effect.gen(function* () {
        const opened = yield* nodeHandleStat(handle, `inspect open Automation ${path}`);
        yield* requireSameFileIdentity(opened, before);
        const bytes = yield* nodeRead(handle, path);
        const after = yield* nodeHandleStat(handle, `reinspect open Automation ${path}`);
        yield* requireSameFileSnapshot(after, opened);
        if (after.size !== BigInt(bytes.byteLength)) {
          return yield* conflict(`Automation changed while reading: ${path}`);
        }
        yield* requirePathSnapshot(path, after);
        yield* requireDirectoryIdentity(directory, identity);
        return { bytes, status: after };
      }),
    );
  });
}

function recoverTemporaryFiles(directory: string): Effect.Effect<void, AutomationNodeError> {
  return Effect.gen(function* () {
    const identity = yield* inspectSafeDirectory(directory);
    const names = yield* nodeReaddir(directory);
    yield* Effect.forEach(
      names.filter((name) => TEMPORARY_NAME_PATTERN.test(name)),
      (name) => recoverTemporaryFile(directory, identity, name),
      { discard: true },
    );
    yield* requireDirectoryIdentity(directory, identity);
  });
}

function recoverTemporaryFile(
  directory: string,
  identity: DirectoryIdentity,
  name: string,
): Effect.Effect<void, AutomationNodeError> {
  return Effect.gen(function* () {
    const match = TEMPORARY_NAME_PATTERN.exec(name);
    const id = match?.[1];
    if (id === undefined) return;
    const temporaryPath = join(directory, name);
    const temporary = yield* nodeLstat(temporaryPath);
    if (!temporary.isFile() || temporary.isSymbolicLink()) {
      return yield* operationFailed(`Unsafe Automation temporary path: ${temporaryPath}`);
    }
    if (temporary.nlink === 1n) {
      yield* Effect.gen(function* () {
        yield* requireDirectoryIdentity(directory, identity);
        yield* requirePathSnapshotAllowLinked(temporaryPath, temporary, 1n);
        yield* nodeRemove(temporaryPath, false);
        yield* syncDirectory(directory);
      }).pipe(Effect.uninterruptible);
      return;
    }
    if (temporary.nlink !== 2n) {
      return yield* operationFailed(`Unexpected Automation temporary link count: ${temporaryPath}`);
    }
    const finalPath = join(directory, `${id}.md`);
    yield* Effect.gen(function* () {
      yield* requirePathSnapshotAllowLinked(finalPath, temporary, 2n);
      yield* requireDirectoryIdentity(directory, identity);
      yield* requirePathSnapshotAllowLinked(temporaryPath, temporary, 2n);
      yield* nodeRemove(temporaryPath, false);
      yield* syncDirectory(directory);
    }).pipe(Effect.uninterruptible);
  });
}

function listNames(directory: string): Effect.Effect<ReadonlyArray<string>, AutomationNodeError> {
  return inspectSafeDirectory(directory).pipe(
    Effect.flatMap((identity) =>
      nodeReaddir(directory).pipe(
        Effect.tap(() => requireDirectoryIdentity(directory, identity)),
        Effect.map((names) => names.toSorted()),
      ),
    ),
  );
}

function inspectSafeDirectory(path: string): Effect.Effect<DirectoryIdentity, AutomationNodeError> {
  return nodeLstat(path).pipe(
    Effect.flatMap((status) =>
      !status.isDirectory() || status.isSymbolicLink()
        ? operationFailed(`Automation directory is not a safe directory: ${path}`)
        : Effect.succeed(identityOf(status)),
    ),
  );
}

function requireDirectoryIdentity(
  path: string,
  identity: DirectoryIdentity,
): Effect.Effect<void, AutomationNodeError> {
  return inspectSafeDirectory(path).pipe(
    Effect.flatMap((current) =>
      current.device === identity.device && current.inode === identity.inode
        ? Effect.void
        : operationFailed(`Automation directory identity changed: ${path}`),
    ),
  );
}

function requirePathSnapshot(
  path: string,
  expected: BigIntStats,
): Effect.Effect<void, AutomationNodeError> {
  return safeLstat(path).pipe(
    Effect.flatMap((current) =>
      current === undefined
        ? conflict(`Automation path disappeared: ${path}`)
        : requireSafeFile(current, path).pipe(
            Effect.andThen(requireSameFileSnapshot(current, expected)),
          ),
    ),
  );
}

function requirePathSnapshotAllowLinked(
  path: string,
  expected: BigIntStats,
  links: bigint,
): Effect.Effect<void, AutomationNodeError> {
  return nodeLstat(path).pipe(
    Effect.flatMap((current) =>
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.nlink === links &&
      sameFileSnapshot(current, expected)
        ? Effect.void
        : operationFailed(`Automation recovery path changed: ${path}`),
    ),
  );
}

function requireSafeFile(
  status: BigIntStats,
  path: string,
): Effect.Effect<void, AutomationNodeError> {
  return status.isFile() && !status.isSymbolicLink() && status.nlink === 1n
    ? Effect.void
    : operationFailed(`Automation path is not an unaliased regular file: ${path}`);
}

function requireSameFileIdentity(
  actual: BigIntStats,
  expected: BigIntStats,
): Effect.Effect<void, AutomationNodeError> {
  return actual.dev === expected.dev && actual.ino === expected.ino
    ? Effect.void
    : conflict("Automation file identity changed");
}

function requireSameFileSnapshot(
  actual: BigIntStats,
  expected: BigIntStats,
): Effect.Effect<void, AutomationNodeError> {
  return sameFileSnapshot(actual, expected) ? Effect.void : conflict("Automation file changed");
}

function sameFileSnapshot(actual: BigIntStats, expected: BigIntStats): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.ctimeNs === expected.ctimeNs
  );
}

function identityOf(status: BigIntStats): DirectoryIdentity {
  return { device: status.dev, inode: status.ino };
}

function syncDirectory(path: string): Effect.Effect<void, AutomationNodeError> {
  return withHandle(path, constants.O_RDONLY | constants.O_NOFOLLOW, undefined, (handle) =>
    nodeSync(handle, `sync Automation directory ${path}`),
  );
}

function rollbackLinkedCreate(
  directory: string,
  path: string,
  temporaryPath: string,
): Effect.Effect<void, AutomationNodeError> {
  return Effect.gen(function* () {
    const temporary = yield* nodeLstat(temporaryPath);
    yield* requirePathSnapshotAllowLinked(path, temporary, 2n);
    yield* requirePathSnapshotAllowLinked(temporaryPath, temporary, 2n);
    yield* nodeRemove(path, false);
    yield* syncDirectory(directory);
  });
}

function releaseTemporary(
  handle: FileHandle,
  path: string,
  propagateFailure: boolean,
): Effect.Effect<void, AutomationNodeError> {
  const release = nodeClose(handle, path).pipe(
    Effect.catch((closeError) =>
      nodeRemove(path, true).pipe(
        Effect.catch(() => Effect.fail(closeError)),
        Effect.andThen(Effect.fail(closeError)),
      ),
    ),
    Effect.andThen(nodeRemove(path, true)),
  );
  return propagateFailure ? release : release.pipe(Effect.orElseSucceed(() => undefined));
}

function withHandle<Value, Error, Requirements>(
  path: string,
  flags: number,
  mode: number | undefined,
  use: (handle: FileHandle) => Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, AutomationNodeError | Error, Requirements> {
  return Effect.acquireUseRelease(nodeOpen(path, flags, mode), use, (handle, exit) =>
    Exit.isSuccess(exit)
      ? nodeClose(handle, path)
      : nodeClose(handle, path).pipe(Effect.orElseSucceed(() => undefined)),
  );
}

function safeLstat(path: string): Effect.Effect<BigIntStats | undefined, AutomationNodeError> {
  return nodeLstat(path).pipe(
    Effect.catch((error) =>
      hasNodeCode(error.cause, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
}

function runHook(
  hooks: AutomationAuthoringNodeHooks,
  point: AutomationPublicationPoint,
): Effect.Effect<void, AutomationNodeError> {
  return Effect.try({
    try: () => hooks.onPublicationPoint?.(point),
    catch: (cause) =>
      new AutomationNodeError({
        operation: "publication-hook",
        code: "operation-failed",
        message: `Automation publication hook failed at ${point}`,
        cause,
      }),
  });
}

function nodeMkdir(path: string): Effect.Effect<void, AutomationNodeError> {
  return nodePromise("create Automation directory", () => mkdir(path, { recursive: true })).pipe(
    Effect.asVoid,
  );
}

function nodeReaddir(path: string): Effect.Effect<ReadonlyArray<string>, AutomationNodeError> {
  return nodePromise("read Automation directory", () => readdir(path));
}

function nodeLstat(path: string): Effect.Effect<BigIntStats, AutomationNodeError> {
  return nodePromise("inspect Automation path", () => lstat(path, { bigint: true }));
}

function nodeOpen(
  path: string,
  flags: number,
  mode: number | undefined,
): Effect.Effect<FileHandle, AutomationNodeError> {
  return nodePromise("open Automation path", () => open(path, flags, mode));
}

function nodeHandleStat(
  handle: FileHandle,
  operation: string,
): Effect.Effect<BigIntStats, AutomationNodeError> {
  return nodePromise(operation, () => handle.stat({ bigint: true }));
}

function nodeRead(
  handle: FileHandle,
  path: string,
): Effect.Effect<Uint8Array, AutomationNodeError> {
  return nodePromise(`read Automation ${path}`, () => handle.readFile());
}

function nodeWrite(
  handle: FileHandle,
  content: Uint8Array,
): Effect.Effect<void, AutomationNodeError> {
  return nodePromise("write Automation temporary file", () => handle.writeFile(content));
}

function nodeSync(handle: FileHandle, operation: string): Effect.Effect<void, AutomationNodeError> {
  return nodePromise(operation, () => handle.sync());
}

function nodeClose(handle: FileHandle, path: string): Effect.Effect<void, AutomationNodeError> {
  return nodePromise(`close Automation path ${path}`, () => handle.close());
}

function nodeLink(source: string, target: string): Effect.Effect<void, AutomationNodeError> {
  return nodePromise("atomically create Automation", () => link(source, target));
}

function nodeRename(source: string, target: string): Effect.Effect<void, AutomationNodeError> {
  return nodePromise("atomically replace Automation", () => rename(source, target));
}

function nodeRemove(path: string, force: boolean): Effect.Effect<void, AutomationNodeError> {
  return nodePromise("remove Automation path", () => rm(path, { force }));
}

function nodePromise<Value>(
  operation: string,
  run: () => Promise<Value>,
): Effect.Effect<Value, AutomationNodeError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new AutomationNodeError({
        operation,
        code: "operation-failed",
        message: `${operation} failed`,
        cause,
      }),
  }).pipe(Effect.uninterruptible);
}

function conflict(message: string): Effect.Effect<never, AutomationNodeError> {
  return Effect.fail(
    new AutomationNodeError({ operation: "publication", code: "conflict", message }),
  );
}

function notFound(message: string): Effect.Effect<never, AutomationNodeError> {
  return Effect.fail(
    new AutomationNodeError({ operation: "publication", code: "not-found", message }),
  );
}

function operationFailed(message: string): Effect.Effect<never, AutomationNodeError> {
  return Effect.fail(
    new AutomationNodeError({ operation: "filesystem", code: "operation-failed", message }),
  );
}

function hasNodeCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    cause.code === code
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}
