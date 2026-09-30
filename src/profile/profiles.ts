import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { fileSystemCauseDetails } from "../platform/cause";
import { ZiggyPaths, ZiggyPathsLive } from "../platform/paths";
import { ProfileFileSystemError, ProfileTargetNotDirectory, type ProfileTarget } from "./types";

export interface InitializedProfile {
  readonly path: string;
  readonly created: boolean;
  readonly createdDirectories: ReadonlyArray<"agents" | "automations">;
}

export interface InitProfileOptions {
  readonly createStarterDirectories?: boolean;
}

export interface ProfileListing {
  readonly name: string;
  readonly path: string;
}

export type ProfileError = ProfileFileSystemError | ProfileTargetNotDirectory;

interface FileStatus {
  readonly isDirectory: () => boolean;
  readonly isSymbolicLink: () => boolean;
  readonly isFile: () => boolean;
}

const failure = (operation: string, target: string, cause: unknown): ProfileFileSystemError => {
  const details = fileSystemCauseDetails(cause);

  return new ProfileFileSystemError({
    operation,
    path: target,
    message: details.message,
    code: details.code,
    cause,
  });
};

const invalid = (operation: string, target: string, message: string): ProfileFileSystemError =>
  new ProfileFileSystemError({
    operation,
    path: target,
    message,
    code: undefined,
    cause: undefined,
  });

// oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- the one node:fs Promise boundary for Profile files.
const io = <A>(operation: string, target: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => failure(operation, target, cause) });

const lstatPath = (target: string): Effect.Effect<FileStatus, ProfileFileSystemError> =>
  io("inspect", target, () => lstat(target));

const makeDirectory = (
  target: string,
  options: { readonly recursive?: boolean; readonly mode?: number },
) => io("create directory", target, () => mkdir(target, options)).pipe(Effect.asVoid);

const createFile = (target: string, content: string, mode?: number) =>
  io("write", target, () => writeFile(target, content, { flag: "wx", mode }));

const isMissing = (error: ProfileFileSystemError): boolean => error.code === "ENOENT";

const orUndefinedWhenMissing = <A>(effect: Effect.Effect<A, ProfileFileSystemError>) =>
  effect.pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));

const physicalDirectory = (target: string) => (status: FileStatus) =>
  status.isDirectory() && !status.isSymbolicLink()
    ? Effect.void
    : Effect.fail(
        invalid("validate directory", target, `${target} must be a regular non-symlink directory`),
      );

const physicalFile = (target: string) => (status: FileStatus) =>
  status.isFile() && !status.isSymbolicLink()
    ? Effect.void
    : Effect.fail(invalid("validate file", target, `${target} must be a regular non-symlink file`));

const isInitializedProfile = (
  profilePath: string,
): Effect.Effect<boolean, ProfileFileSystemError> =>
  Effect.gen(function* () {
    const profile = yield* lstatPath(profilePath);

    if (!profile.isDirectory() || profile.isSymbolicLink()) return false;
    const soul = yield* lstatPath(path.join(profilePath, "SOUL.md"));

    return soul.isFile() && !soul.isSymbolicLink();
  }).pipe(Effect.catchIf(isMissing, () => Effect.succeed(false)));

const readRegistry = (registryPath: string) =>
  io("read", registryPath, () => readFile(registryPath, "utf8")).pipe(
    Effect.catchIf(isMissing, () => Effect.succeed("")),
  );

/** Create a starter directory; `true` when this call created it. */
const ensureStarterDirectory = (
  profilePath: string,
  name: "agents" | "automations",
): Effect.Effect<boolean, ProfileFileSystemError> => {
  const directory = path.join(profilePath, name);

  return lstatPath(directory).pipe(
    Effect.flatMap(physicalDirectory(directory)),
    Effect.as(false),
    Effect.catchIf(isMissing, () =>
      makeDirectory(directory, { mode: 0o700 }).pipe(Effect.as(true)),
    ),
  );
};

const memoryReadme = `# Profile memory

Memory uses one entry per block, separated by a line containing §. The shared document is
MEMORY.md; person and group documents live under memory/users/ and memory/groups/.

See docs/operations/memory.md for scope rules, caps, backups, and safe hand-editing.
`;

const ensureMemoryDirectory = (profilePath: string, relative: string) => {
  const directory = path.join(profilePath, relative);
  const validate = lstatPath(directory).pipe(Effect.flatMap(physicalDirectory(directory)));

  return validate.pipe(
    Effect.catchIf(isMissing, () =>
      makeDirectory(directory, { mode: 0o700 }).pipe(
        Effect.catchIf(
          (error) => error.code === "EEXIST",
          () => validate,
        ),
      ),
    ),
  );
};

/** Create `relative` with `content` unless it exists; never rewrite an existing file. */
const ensureFile = (profilePath: string, relative: string, content: string) => {
  const file = path.join(profilePath, relative);
  const validate = lstatPath(file).pipe(Effect.flatMap(physicalFile(file)));

  return validate.pipe(
    Effect.catchIf(isMissing, () =>
      createFile(file, content, 0o600).pipe(
        Effect.catchIf(
          (error) => error.code === "EEXIST",
          () => validate,
        ),
      ),
    ),
  );
};

const ensureMemoryScaffold = (profilePath: string): Effect.Effect<void, ProfileFileSystemError> =>
  Effect.gen(function* () {
    yield* ensureMemoryDirectory(profilePath, "memory");
    yield* ensureMemoryDirectory(profilePath, path.join("memory", "users"));
    yield* ensureMemoryDirectory(profilePath, path.join("memory", "groups"));
    yield* ensureFile(profilePath, "MEMORY.md", "");
    yield* ensureFile(profilePath, path.join("memory", "README.md"), memoryReadme);
  });

/** Profiles on disk: create one, and read or append the Profile registry. */
export class Profiles extends Context.Service<Profiles>()("ziggy/Profiles", {
  make: Effect.gen(function* () {
    const paths = yield* ZiggyPaths;

    /** Create the folder and `SOUL.md` if missing. An existing `SOUL.md` is never rewritten. */
    const init = Effect.fn("Profiles.init")(function* (
      target: ProfileTarget,
      options: InitProfileOptions = {},
    ) {
      const targetStatus = yield* orUndefinedWhenMissing(lstatPath(target.path));

      if (
        targetStatus !== undefined &&
        (!targetStatus.isDirectory() || targetStatus.isSymbolicLink())
      ) {
        return yield* new ProfileTargetNotDirectory({ path: target.path });
      }

      if (targetStatus === undefined) {
        yield* makeDirectory(target.path, { recursive: true, mode: 0o700 });
      }

      const soulPath = path.join(target.path, "SOUL.md");
      const soulStatus = yield* orUndefinedWhenMissing(lstatPath(soulPath));

      if (soulStatus !== undefined && (!soulStatus.isFile() || soulStatus.isSymbolicLink())) {
        return yield* new ProfileTargetNotDirectory({ path: soulPath });
      }

      const created =
        soulStatus === undefined &&
        (yield* createFile(soulPath, soulTemplate(target.name)).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => error.code === "EEXIST",
            () =>
              lstatPath(soulPath).pipe(Effect.flatMap(physicalFile(soulPath)), Effect.as(false)),
          ),
        ));

      const createdDirectories: Array<"agents" | "automations"> = [];

      if (options.createStarterDirectories === true) {
        yield* ensureMemoryScaffold(target.path);

        for (const name of ["agents", "automations"] as const) {
          if (yield* ensureStarterDirectory(target.path, name)) createdDirectories.push(name);
        }
      }

      return { path: target.path, created, createdDirectories } satisfies InitializedProfile;
    });

    /** Append `profilePath` to the registry unless it is already listed. */
    const register = Effect.fn("Profiles.register")(function* (profilePath: string) {
      const registryPath = paths.profilesRegistry;
      yield* makeDirectory(path.dirname(registryPath), { recursive: true });

      const registry = yield* readRegistry(registryPath);

      if (registry.split("\n").includes(profilePath)) return;

      const prefix = registry.length > 0 && !registry.endsWith("\n") ? "\n" : "";
      yield* io("append", registryPath, () =>
        appendFile(registryPath, `${prefix}${profilePath}\n`, "utf8"),
      );
    });

    /** Initialized Profiles from the registry and the Profiles directory. Writes nothing. */
    const list = Effect.fn("Profiles.list")(function* (): Effect.fn.Return<
      ReadonlyArray<ProfileListing>,
      ProfileFileSystemError
    > {
      const registryEntries = (yield* readRegistry(paths.profilesRegistry))
        .split("\n")
        .filter((entry) => path.isAbsolute(entry))
        .map((entry) => path.resolve(entry));

      const entries = yield* io("list", paths.profilesDirectory, () =>
        readdir(paths.profilesDirectory, { withFileTypes: true }),
      ).pipe(Effect.catchIf(isMissing, () => Effect.succeed([])));

      const directoryPaths = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.resolve(paths.profilesDirectory, entry.name));

      const listings = yield* Effect.forEach(
        [...new Set([...registryEntries, ...directoryPaths])],
        (profilePath) =>
          isInitializedProfile(profilePath).pipe(
            Effect.map(
              (initialized): ReadonlyArray<ProfileListing> =>
                initialized ? [{ name: path.basename(profilePath), path: profilePath }] : [],
            ),
          ),
      );

      return listings
        .flat()
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
        );
    });

    return { init, register, list } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(ZiggyPathsLive));
}

export type ProfilesApi = (typeof Profiles)["Service"];

export const soulTemplate = (name: string): string => `# ${name}

You are ${name}. You live in this folder — it is your whole world: your soul, memory,
sessions, and skills are all plain files here.

## Voice

Warm, direct, brief. No filler, no corporate tone.

## Behavior

- Help with whatever your person brings you. Act when intent is clear; ask when it isn't.
- Remember what matters: durable facts go to memory, not the transcript.
- Never invent facts about people. If it isn't in memory or the conversation, say so.

Shape this file however you like — it is yours.
`;
