import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import { ExtensionUpdateError } from "../../domain/extension-update";
import { fileSystemCauseDetails } from "./cause";

const Id = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  id: Id,
  source: Schema.Literal("bundled"),
  packageVersion: Schema.String,
  contentHash: Hash,
});

const Journal = Schema.Struct({
  version: Schema.Literal(1),
  id: Id,
  transactionId: Id,
  phase: Schema.Literals(["prepared", "committed"]),
  oldHash: Hash,
  receipt: Receipt,
});

type UpdateState = typeof Receipt.Type | typeof Journal.Type;

const decodeId = Schema.decodeUnknownEffect(Id);

const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));

const decodeJournal = Schema.decodeUnknownEffect(Schema.fromJsonString(Journal));

const failure = (profilePath: string, id: string, message: string, cause?: unknown) =>
  new ExtensionUpdateError({ profilePath, id, reason: "filesystem", message, cause });

const disk = <A>(profilePath: string, id: string, message: string, operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => failure(profilePath, id, message, cause) });

const exists = (profilePath: string, id: string, path: string) =>
  Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause }).pipe(
    Effect.map(() => true),
    Effect.catch((cause) =>
      fileSystemCauseDetails(cause).code === "ENOENT"
        ? Effect.succeed(false)
        : Effect.fail(failure(profilePath, id, "Could not inspect extension update path.", cause)),
    ),
  );

const physicalDirectory = (profilePath: string, id: string, path: string) =>
  disk(profilePath, id, "Could not inspect extension update directory.", () => lstat(path)).pipe(
    Effect.flatMap((status) =>
      status.isDirectory() && !status.isSymbolicLink()
        ? Effect.void
        : Effect.fail(
            failure(profilePath, id, "Extension update directories must be physical directories."),
          ),
    ),
  );

const ensureDirectory = (profilePath: string, id: string, path: string) =>
  Effect.gen(function* () {
    if (!(yield* exists(profilePath, id, path))) {
      yield* disk(profilePath, id, "Could not create extension update directory.", () =>
        mkdir(path),
      );
    }

    yield* physicalDirectory(profilePath, id, path);
  });

const updateRoot = (profilePath: string) => join(profilePath, ".runtime", "extension-updates");

const packageRoot = (profilePath: string, id: string) => join(updateRoot(profilePath), id);

const prepareRoot = (profilePath: string, id: string) =>
  Effect.gen(function* () {
    yield* physicalDirectory(profilePath, id, profilePath);
    yield* ensureDirectory(profilePath, id, join(profilePath, ".runtime"));
    yield* ensureDirectory(profilePath, id, updateRoot(profilePath));
    yield* ensureDirectory(profilePath, id, packageRoot(profilePath, id));
  });

const writeJson = (profilePath: string, id: string, path: string, value: UpdateState) =>
  disk(profilePath, id, "Could not durably write extension update state.", async () => {
    const temporary = `${path}.tmp-${randomUUID()}`;
    const handle = await open(temporary, "wx", 0o600);

    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporary, path);
    const directory = await open(dirname(path), "r");

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  });

const renameDurably = (profilePath: string, id: string, from: string, to: string) =>
  disk(profilePath, id, "Could not durably rename extension package.", async () => {
    await rename(from, to);

    for (const parent of new Set([dirname(from), dirname(to)])) {
      const directory = await open(parent, "r");

      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  });

const hashTree = (
  profilePath: string,
  id: string,
  root: string,
): Effect.Effect<string, ExtensionUpdateError> =>
  Effect.gen(function* () {
    const hash = createHash("sha256");

    const walk = (path: string, relative: string): Effect.Effect<void, ExtensionUpdateError> =>
      Effect.gen(function* () {
        const status = yield* disk(profilePath, id, "Could not inspect package content.", () =>
          lstat(path),
        );

        if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
          return yield* failure(profilePath, id, "Package contains a symlink or special file.");
        }

        hash.update(
          JSON.stringify([
            relative,
            status.isDirectory() ? "directory" : "file",
            status.mode & 0o777,
          ]),
        );

        if (status.isDirectory()) {
          const names = yield* disk(profilePath, id, "Could not list package content.", () =>
            readdir(path),
          );

          for (const name of names.sort()) yield* walk(join(path, name), `${relative}/${name}`);
        } else {
          const bytes = yield* disk(profilePath, id, "Could not read package content.", () =>
            readFile(path),
          );

          hash.update(createHash("sha256").update(bytes).digest("hex"));
        }
      });

    yield* walk(root, "");

    return hash.digest("hex");
  });

const readState = (profilePath: string, id: string, path: string) =>
  disk(profilePath, id, "Could not read extension update state.", () => readFile(path, "utf8"));

const remove = (profilePath: string, id: string, path: string) =>
  disk(profilePath, id, "Could not clean extension update transaction.", () =>
    rm(path, { recursive: true, force: true }),
  );

const recoverOne = (profilePath: string, id: string) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const root = packageRoot(profilePath, id);
      yield* physicalDirectory(profilePath, id, root);
      const journalPath = join(root, "journal.json");

      if (!(yield* exists(profilePath, id, journalPath))) return;

      const journal = yield* readState(profilePath, id, journalPath).pipe(
        Effect.flatMap((text) => decodeJournal(text, { onExcessProperty: "error" })),
        Effect.mapError((cause) =>
          failure(profilePath, id, "Extension update journal is invalid; recovery stopped.", cause),
        ),
      );

      if (journal.id !== id || journal.receipt.id !== id)
        return yield* failure(profilePath, id, "Extension update journal identity mismatch.");
      const transaction = join(root, journal.transactionId);
      yield* physicalDirectory(profilePath, id, transaction);
      const backup = join(transaction, "backup");
      const destination = join(profilePath, "extensions", id);
      yield* physicalDirectory(profilePath, id, join(profilePath, "extensions"));

      if (journal.phase === "committed") {
        if ((yield* hashTree(profilePath, id, destination)) !== journal.receipt.contentHash) {
          return yield* failure(
            profilePath,
            id,
            "Committed package changed before recovery; preserving all files.",
          );
        }

        yield* writeJson(profilePath, id, join(root, "receipt.json"), journal.receipt);
      } else if (yield* exists(profilePath, id, backup)) {
        if ((yield* hashTree(profilePath, id, backup)) !== journal.oldHash) {
          return yield* failure(profilePath, id, "Extension backup changed; recovery stopped.");
        }

        if (yield* exists(profilePath, id, destination)) {
          if ((yield* hashTree(profilePath, id, destination)) !== journal.receipt.contentHash) {
            return yield* failure(
              profilePath,
              id,
              "Package changed during interrupted update; preserving all files.",
            );
          }

          yield* remove(profilePath, id, destination);
        }

        yield* disk(profilePath, id, "Could not restore extension backup.", () =>
          rename(backup, destination),
        );
      } else if ((yield* hashTree(profilePath, id, destination)) !== journal.oldHash) {
        return yield* failure(profilePath, id, "Original package missing during update recovery.");
      }

      yield* remove(profilePath, id, journalPath);
    }),
  );

export const hasPendingExtensionUpdates = (profilePath: string) =>
  Effect.gen(function* () {
    const root = updateRoot(profilePath);

    if (!(yield* exists(profilePath, "", root))) return false;
    yield* physicalDirectory(profilePath, "", root);

    const names = yield* disk(profilePath, "", "Could not list extension update journals.", () =>
      readdir(root),
    );

    for (const id of names) {
      yield* physicalDirectory(profilePath, id, join(root, id));

      if (yield* exists(profilePath, id, join(root, id, "journal.json"))) return true;
    }

    return false;
  });

export const recoverExtensionUpdates = (profilePath: string) =>
  Effect.gen(function* () {
    const root = updateRoot(profilePath);

    if (!(yield* exists(profilePath, "", root))) return;
    yield* physicalDirectory(profilePath, "", root);

    const names = yield* disk(profilePath, "", "Could not list extension update journals.", () =>
      readdir(root),
    );

    for (const id of names) {
      yield* decodeId(id).pipe(
        Effect.mapError((cause) =>
          failure(profilePath, id, "Invalid extension journal directory name.", cause),
        ),
      );
      yield* recoverOne(profilePath, id);
    }
  });

export const makeExtensionUpdateStore = (profilePath: string, id: string) => ({
  stageContext: (stagingProfile: string) =>
    disk(profilePath, id, "Could not copy Profile context for staged validation.", () =>
      cp(join(profilePath, "SOUL.md"), join(stagingProfile, "SOUL.md"), {
        dereference: false,
        errorOnExist: true,
        force: false,
      }),
    ),
  discard: (transactionId: string) =>
    Effect.gen(function* () {
      const transaction = join(packageRoot(profilePath, id), transactionId);

      if (yield* exists(profilePath, id, join(packageRoot(profilePath, id), "journal.json")))
        return;

      if (yield* exists(profilePath, id, join(transaction, "backup"))) {
        yield* remove(profilePath, id, join(transaction, "stage"));
      } else yield* remove(profilePath, id, transaction);
    }),
  hash: (path: string) => hashTree(profilePath, id, path),
  prepare: () =>
    Effect.gen(function* () {
      yield* prepareRoot(profilePath, id);
      yield* recoverOne(profilePath, id);
      yield* physicalDirectory(profilePath, id, join(profilePath, "extensions"));
      yield* physicalDirectory(profilePath, id, join(profilePath, "extensions", id));
      const root = packageRoot(profilePath, id);
      const receiptPath = join(root, "receipt.json");

      const receipt = (yield* exists(profilePath, id, receiptPath))
        ? yield* readState(profilePath, id, receiptPath).pipe(
            Effect.flatMap((text) => decodeReceipt(text, { onExcessProperty: "error" })),
            Effect.mapError((cause) =>
              failure(profilePath, id, "Managed extension receipt is invalid.", cause),
            ),
          )
        : undefined;

      if (receipt !== undefined && receipt.id !== id)
        return yield* failure(profilePath, id, "Managed extension receipt identity mismatch.");
      const transactionId = randomUUID();
      const transaction = join(root, transactionId);
      yield* ensureDirectory(profilePath, id, transaction);
      const stagingProfile = join(transaction, "stage");
      yield* ensureDirectory(profilePath, id, stagingProfile);

      return {
        receipt,
        transactionId,
        transaction,
        stagingProfile,
        backupPath: join(transaction, "backup"),
      };
    }),
  commit: <A, E, R>(input: {
    readonly transactionId: string;
    readonly oldHash: string;
    readonly newHash: string;
    readonly packageVersion: string;
    readonly validate: Effect.Effect<A, E, R>;
  }) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const root = packageRoot(profilePath, id);
        const transaction = join(root, input.transactionId);
        const destination = join(profilePath, "extensions", id);
        const staged = join(transaction, "stage", "extensions", id);

        const receipt = {
          version: 1 as const,
          id,
          source: "bundled" as const,
          packageVersion: input.packageVersion,
          contentHash: input.newHash,
        };

        const journal = {
          version: 1 as const,
          id,
          transactionId: input.transactionId,
          phase: "prepared" as const,
          oldHash: input.oldHash,
          receipt,
        };

        if ((yield* hashTree(profilePath, id, destination)) !== input.oldHash)
          return yield* failure(profilePath, id, "Package changed after update preparation.");
        yield* writeJson(profilePath, id, join(root, "journal.json"), journal);
        yield* Effect.gen(function* () {
          yield* renameDurably(profilePath, id, destination, join(transaction, "backup"));
          yield* renameDurably(profilePath, id, staged, destination);
          yield* input.validate;
          yield* writeJson(profilePath, id, join(root, "journal.json"), {
            ...journal,
            phase: "committed",
          });
        }).pipe(
          Effect.catch((cause) =>
            recoverOne(profilePath, id).pipe(Effect.andThen(Effect.fail(cause))),
          ),
        );
        yield* writeJson(profilePath, id, join(root, "receipt.json"), receipt);
        yield* remove(profilePath, id, join(root, "journal.json"));
      }),
    ),
  adoptCurrent: (contentHash: string, packageVersion: string) =>
    writeJson(profilePath, id, join(packageRoot(profilePath, id), "receipt.json"), {
      version: 1,
      id,
      source: "bundled",
      packageVersion,
      contentHash,
    }),
});
