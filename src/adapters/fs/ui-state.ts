import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Schema, Semaphore } from "effect";
import { fileSystemCauseDetails } from "./cause";
import {
  UiGroupNotFound,
  UiGroupState,
  UiPinState,
  UiStateCommandConflict,
  UiStateConflict,
  UiStateReadError,
  UiStateWriteError,
  type UiGroupState as UiGroupStateValue,
  type UiPinState as UiPinStateValue,
} from "../../domain/ui-state";
import type { UiCommandId, UiGroupRecord, UiPin, UiPinId } from "../../domain/ui-gateway";

/** Profile-local machine state; deliberately separate from the resident runtime tree. */
const STATE_DIRECTORY = ".ziggy";
const PIN_FILE = "ui-pins.json";
const GROUP_FILE = "ui-groups.json";
const decodePinStateJson = Schema.decodeUnknownSync(Schema.fromJsonString(UiPinState));
const decodeGroupStateJson = Schema.decodeUnknownSync(Schema.fromJsonString(UiGroupState));

export const uiPinStatePath = (profilePath: string): string =>
  path.join(profilePath, STATE_DIRECTORY, PIN_FILE);
export const uiGroupStatePath = (profilePath: string): string =>
  path.join(profilePath, STATE_DIRECTORY, GROUP_FILE);

const isMissing = (cause: unknown): boolean => fileSystemCauseDetails(cause).code === "ENOENT";

const readState = <A>(
  file: string,
  decode: (source: string) => A,
  empty: A,
): Effect.Effect<A, UiStateReadError> =>
  Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      isMissing(cause) ? Effect.succeed(JSON.stringify(empty)) : Effect.fail(cause),
    ),
    Effect.flatMap((source) =>
      Effect.try({
        try: () => decode(source),
        catch: (cause) =>
          new UiStateReadError({ operation: "decode", message: "UI state file is invalid", cause }),
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof UiStateReadError
        ? cause
        : new UiStateReadError({
            operation: "read",
            message: "UI state file could not be read",
            cause,
          }),
    ),
  );

const ensureStateDirectory = (profilePath: string): Effect.Effect<string, UiStateWriteError> => {
  const runtime = path.join(profilePath, STATE_DIRECTORY);
  return Effect.tryPromise({
    try: async () => {
      await physicalDirectoryPromise(profilePath);
      await mkdir(runtime, { recursive: true });
      await physicalDirectoryPromise(runtime);
      return runtime;
    },
    catch: (cause) =>
      new UiStateWriteError({
        operation: "mkdir",
        message: "UI state directory could not be created",
        cause,
      }),
  });
};

const physicalDirectoryPromise = async (directory: string): Promise<void> => {
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error(`${directory} is not physical`);
};

const writeState = <A>(
  profilePath: string,
  file: string,
  state: A,
): Effect.Effect<void, UiStateWriteError> =>
  Effect.gen(function* () {
    const runtime = yield* ensureStateDirectory(profilePath);
    const temporary = path.join(runtime, `.${path.basename(file)}.${randomUUID()}.tmp`);
    const source = JSON.stringify(state);
    yield* Effect.tryPromise({
      try: async () => {
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(source, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        new UiStateWriteError({
          operation: "write",
          message: "UI state could not be written",
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () => rename(temporary, file),
      catch: (cause) =>
        new UiStateWriteError({
          operation: "rename",
          message: "UI state could not be committed",
          cause,
        }),
    });
  });

const emptyPins: UiPinStateValue = { version: 1, revision: 0, pins: [], commands: [] };
const mutationPermits = new Map<string, Semaphore.Semaphore>();
const emptyGroups: UiGroupStateValue = { version: 1, groups: [], commands: [] };

const permitFor = (file: string): Semaphore.Semaphore => {
  const existing = mutationPermits.get(file);
  if (existing !== undefined) return existing;
  const created = Semaphore.makeUnsafe(1);
  mutationPermits.set(file, created);
  return created;
};

const rememberPinCommand = (
  state: UiPinStateValue,
  commandId: UiCommandId,
  fingerprint: string,
  revision: number,
): UiPinStateValue => ({
  ...state,
  commands: [
    ...state.commands.filter((entry) => entry.commandId !== commandId),
    { commandId, fingerprint, revision },
  ].slice(-128),
});
const rememberGroupCommand = (
  state: UiGroupStateValue,
  commandId: UiCommandId,
  fingerprint: string,
  groupId: string,
  revision: number,
): UiGroupStateValue => ({
  ...state,
  commands: [
    ...state.commands.filter((entry) => entry.commandId !== commandId),
    { commandId, fingerprint, groupId, revision },
  ].slice(-128),
});

export interface UiPinStore {
  readonly read: (profilePath: string) => Effect.Effect<UiPinStateValue, UiStateReadError>;
  readonly set: (
    profilePath: string,
    pin: UiPin,
    expectedRevision: number,
    commandId: UiCommandId,
  ) => Effect.Effect<
    UiPinStateValue,
    UiStateReadError | UiStateWriteError | UiStateConflict | UiStateCommandConflict
  >;
  readonly remove: (
    profilePath: string,
    pinId: UiPinId,
    expectedRevision: number,
    commandId: UiCommandId,
  ) => Effect.Effect<
    UiPinStateValue,
    UiStateReadError | UiStateWriteError | UiStateConflict | UiStateCommandConflict
  >;
}

export const makeUiPinStore = (): UiPinStore => {
  const read = (profilePath: string) =>
    readState(uiPinStatePath(profilePath), decodePinStateJson, emptyPins);
  const mutate = (
    profilePath: string,
    commandId: UiCommandId,
    fingerprint: string,
    expectedRevision: number,
    change: (state: UiPinStateValue) => UiPinStateValue,
  ) =>
    permitFor(uiPinStatePath(profilePath)).withPermit(
      Effect.gen(function* () {
        const current = yield* read(profilePath);
        const previous = current.commands.find((entry) => entry.commandId === commandId);
        if (previous !== undefined) {
          if (previous.fingerprint !== fingerprint)
            return yield* new UiStateCommandConflict({
              commandId,
              message: "command id was already used for a different UI pin mutation",
            });
          return current;
        }
        if (current.revision !== expectedRevision)
          return yield* new UiStateConflict({
            expectedRevision,
            actualRevision: current.revision,
            message: "UI pins changed; reload before retrying",
          });
        const next = change({ ...current, revision: current.revision + 1 });
        const persisted = rememberPinCommand(next, commandId, fingerprint, next.revision);
        yield* writeState(profilePath, uiPinStatePath(profilePath), persisted);
        return persisted;
      }),
    );
  return {
    read,
    set: (profilePath, pin, expectedRevision, commandId) =>
      mutate(
        profilePath,
        commandId,
        JSON.stringify({ action: "set", pin }),
        expectedRevision,
        (state) => ({
          ...state,
          pins: [...state.pins.filter((candidate) => candidate.id !== pin.id), pin].sort(
            (left, right) => left.order - right.order || left.id.localeCompare(right.id),
          ),
        }),
      ),
    remove: (profilePath, pinId, expectedRevision, commandId) =>
      mutate(
        profilePath,
        commandId,
        JSON.stringify({ action: "remove", pinId }),
        expectedRevision,
        (state) => ({ ...state, pins: state.pins.filter((pin) => pin.id !== pinId) }),
      ),
  };
};

export interface UiGroupStore {
  readonly read: (profilePath: string) => Effect.Effect<UiGroupStateValue, UiStateReadError>;
  readonly upsert: (
    profilePath: string,
    group: UiGroupRecord,
    expectedRevision: number,
    commandId: UiCommandId,
  ) => Effect.Effect<
    UiGroupStateValue,
    UiStateReadError | UiStateWriteError | UiStateConflict | UiStateCommandConflict
  >;
  readonly remove: (
    profilePath: string,
    groupId: string,
    expectedRevision: number,
    commandId: UiCommandId,
  ) => Effect.Effect<
    UiGroupStateValue,
    | UiStateReadError
    | UiStateWriteError
    | UiStateConflict
    | UiStateCommandConflict
    | UiGroupNotFound
  >;
}

export const makeUiGroupStore = (): UiGroupStore => {
  const read = (profilePath: string) =>
    readState(uiGroupStatePath(profilePath), decodeGroupStateJson, emptyGroups);
  const mutate = (
    profilePath: string,
    commandId: UiCommandId,
    fingerprint: string,
    expectedRevision: number,
    groupId: string,
    change: (state: UiGroupStateValue) => UiGroupStateValue,
  ) =>
    permitFor(uiGroupStatePath(profilePath)).withPermit(
      Effect.gen(function* () {
        const current = yield* read(profilePath);
        const previousCommand = current.commands.find((entry) => entry.commandId === commandId);
        if (previousCommand !== undefined) {
          if (previousCommand.fingerprint !== fingerprint)
            return yield* new UiStateCommandConflict({
              commandId,
              message: "command id was already used for a different group mutation",
            });
          return current;
        }
        const existing = current.groups.find((candidate) => candidate.groupId === groupId);
        const actualRevision = existing?.revision ?? 0;
        if (actualRevision !== expectedRevision)
          return yield* new UiStateConflict({
            expectedRevision,
            actualRevision,
            message: "group changed; reload before retrying",
          });
        const next = change(current);
        const changedGroup = next.groups.find((candidate) => candidate.groupId === groupId);
        const revision = changedGroup?.revision ?? actualRevision;
        const remembered = rememberGroupCommand(next, commandId, fingerprint, groupId, revision);
        yield* writeState(profilePath, uiGroupStatePath(profilePath), remembered);
        return remembered;
      }),
    );
  return {
    read,
    upsert: (profilePath, group, expectedRevision, commandId) =>
      mutate(
        profilePath,
        commandId,
        JSON.stringify({ action: "upsert", group }),
        expectedRevision,
        group.groupId,
        (state) => ({
          ...state,
          groups: [
            ...state.groups.filter((candidate) => candidate.groupId !== group.groupId),
            { ...group, revision: expectedRevision + 1 },
          ].sort((left, right) => left.groupId.localeCompare(right.groupId)),
        }),
      ),
    remove: (profilePath, groupId, expectedRevision, commandId) =>
      mutate(
        profilePath,
        commandId,
        JSON.stringify({ action: "remove", groupId }),
        expectedRevision,
        groupId,
        (state) => ({
          ...state,
          groups: state.groups.filter((group) => group.groupId !== groupId),
        }),
      ),
  };
};

export const uiPinStore = makeUiPinStore();
export const uiGroupStore = makeUiGroupStore();
