/**
 * Paired devices and open pairing codes. Each device is `<profile>/devices/<id>.json` and holds
 * only public facts; codes are kept as SHA-256 hashes in `.gateway/device-pairing.json`. The CLI
 * and the resident both write here, always under one file lock.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { writeFileAtomic } from "../platform/atomic-write";
import { fileSystemCauseDetails } from "../platform/cause";
import { withFileLock } from "../platform/file-lock";
import { readPhysicalFile } from "../platform/tree";
import { normalizeZdpPairingCode } from "./protocol";

export class DeviceRegistryFailed extends Schema.TaggedErrorClass<DeviceRegistryFailed>()(
  "DeviceRegistryFailed",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const DeviceRecord = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/)),
  name: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  /** The device's static X25519 public key, base64url. */
  publicKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  pairedAt: Schema.String,
});

export type DeviceRecord = typeof DeviceRecord.Type;

const PairingFile = Schema.Struct({
  version: Schema.Literal(1),
  codes: Schema.Array(Schema.Struct({ hash: Schema.String, expiresAtMs: Schema.Int })),
});

type PairingFile = typeof PairingFile.Type;

const strict = { onExcessProperty: "error" } as const;

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(DeviceRecord), strict);

const decodePairing = Schema.decodeUnknownEffect(Schema.fromJsonString(PairingFile), strict);

export const PAIRING_TTL_MS = 10 * 60 * 1000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const LOCK_WAIT_MS = 2000;

export const devicesDirectory = (profilePath: string): string => join(profilePath, "devices");

const pairingPath = (profilePath: string) => join(profilePath, ".gateway", "device-pairing.json");

const recordPath = (profilePath: string, id: string) =>
  join(devicesDirectory(profilePath), `${id}.json`);

const failed = (operation: string, path: string, message: string, cause?: unknown) =>
  new DeviceRegistryFailed({ operation, path, message, cause });

const hashCode = (code: string) =>
  createHash("sha256").update(normalizeZdpPairingCode(code)).digest("hex");

const locked = <A, E>(profilePath: string, operation: string, use: Effect.Effect<A, E>) =>
  withFileLock(
    { root: profilePath, file: ".runtime/devices.sqlite", waitMs: LOCK_WAIT_MS },
    use,
    (cause) => failed(operation, profilePath, "the device registry is busy", cause),
  );

/** Creates a private directory unless a physical one is there; a symlink or file is refused. */
const ensureDirectory = (path: string, operation: string) =>
  Effect.tryPromise({
    try: () => mkdir(path, { recursive: true, mode: 0o700 }),
    catch: (cause) => failed(operation, path, "could not create the directory", cause),
  }).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => lstat(path),
        catch: (cause) => failed(operation, path, "could not inspect the directory", cause),
      }),
    ),
    Effect.flatMap((status) =>
      status.isDirectory() && !status.isSymbolicLink()
        ? Effect.void
        : Effect.fail(failed(operation, path, "must be a physical directory")),
    ),
  );

const readText = (path: string, operation: string) =>
  readPhysicalFile(path).pipe(
    Effect.mapError((cause) => failed(operation, path, cause.message, cause)),
    Effect.map((bytes) => (bytes === undefined ? undefined : new TextDecoder().decode(bytes))),
  );

const writeJson = (path: string, value: DeviceRecord | PairingFile, operation: string) =>
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600).pipe(
    Effect.mapError((cause) => failed(operation, path, cause.message, cause)),
  );

/** Every paired device, by id. */
export const listDevices = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<DeviceRecord>, DeviceRegistryFailed> =>
  Effect.gen(function* () {
    const directory = devicesDirectory(profilePath);

    const names = yield* Effect.tryPromise({
      try: () => readdir(directory),
      catch: (cause) => failed("list devices", directory, "could not read the directory", cause),
    }).pipe(
      Effect.catchIf(
        (failure) => fileSystemCauseDetails(failure.cause).code === "ENOENT",
        () => Effect.succeed([]),
      ),
    );

    const records = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".json")).toSorted(),
      (name) => readDevice(profilePath, name.slice(0, -".json".length), "list devices"),
    );

    return records.filter((record) => record !== undefined);
  });

const readDevice = (profilePath: string, id: string, operation: string) =>
  Effect.gen(function* () {
    const path = recordPath(profilePath, id);

    const text = yield* readText(path, operation);

    if (text === undefined) return undefined;

    const record = yield* decodeRecord(text).pipe(
      Effect.mapError((cause) => failed(operation, path, "is not a device record", cause)),
    );

    if (record.id !== id) return yield* failed(operation, path, `holds device ${record.id}`);

    return record;
  });

/** The paired device with this static key, if any. */
export const findDeviceByKey = (
  profilePath: string,
  publicKey: Uint8Array,
): Effect.Effect<DeviceRecord | undefined, DeviceRegistryFailed> => {
  const key = Buffer.from(publicKey).toString("base64url");

  return Effect.map(listDevices(profilePath), (records) =>
    records.find((record) => record.publicKey === key),
  );
};

const readCodes = (profilePath: string, now: number, operation: string) =>
  Effect.gen(function* () {
    const path = pairingPath(profilePath);

    const text = yield* readText(path, operation);

    if (text === undefined) return [];

    const file = yield* decodePairing(text).pipe(
      Effect.mapError((cause) => failed(operation, path, "is not a pairing file", cause)),
    );

    return file.codes.filter((code) => code.expiresAtMs > now);
  });

const writeCodes = (profilePath: string, codes: PairingFile["codes"], operation: string) =>
  Effect.gen(function* () {
    yield* ensureDirectory(join(profilePath, ".gateway"), operation);
    yield* writeJson(pairingPath(profilePath), { version: 1, codes }, operation);
  });

export interface IssuedPairingCode {
  /** Ten Crockford base32 characters. A secret until it is spent or expires. */
  readonly code: string;
  readonly expiresAtMs: number;
}

/** A one-time code, valid for ten minutes; only its hash is stored. */
export const issuePairingCode = (
  profilePath: string,
  now: number,
): Effect.Effect<IssuedPairingCode, DeviceRegistryFailed> =>
  locked(
    profilePath,
    "issue pairing code",
    Effect.gen(function* () {
      const code = [...randomBytes(10)].map((byte) => CROCKFORD[byte & 31]).join("");

      const expiresAtMs = now + PAIRING_TTL_MS;

      const codes = yield* readCodes(profilePath, now, "issue pairing code");

      yield* writeCodes(
        profilePath,
        [...codes, { hash: hashCode(code), expiresAtMs }],
        "issue pairing code",
      );

      return { code, expiresAtMs };
    }),
  );

/** Whether an unexpired code is open, so an unknown key may try to pair. */
export const pairingOpen = (
  profilePath: string,
  now: number,
): Effect.Effect<boolean, DeviceRegistryFailed> =>
  Effect.map(readCodes(profilePath, now, "check pairing"), (codes) => codes.length > 0);

const slug = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 24) || "device";

export interface PairingDevice {
  readonly name: string;
  readonly model: string;
  readonly publicKey: Uint8Array;
}

/**
 * Spends `code` and records the device. Undefined when the code is not open; a key that is
 * already paired keeps its record.
 */
export const redeemPairingCode = (
  profilePath: string,
  code: string,
  device: PairingDevice,
  now: number,
): Effect.Effect<DeviceRecord | undefined, DeviceRegistryFailed> =>
  locked(
    profilePath,
    "redeem pairing code",
    Effect.gen(function* () {
      const codes = yield* readCodes(profilePath, now, "redeem pairing code");

      const hash = hashCode(code);

      if (!codes.some((open) => open.hash === hash)) return undefined;

      yield* writeCodes(
        profilePath,
        codes.filter((open) => open.hash !== hash),
        "redeem pairing code",
      );

      const devices = yield* listDevices(profilePath);

      const publicKey = Buffer.from(device.publicKey).toString("base64url");

      const existing = devices.find((record) => record.publicKey === publicKey);

      if (existing !== undefined) return existing;

      const taken = new Set(devices.map((record) => record.id));

      const base = slug(device.name);

      let id = base;

      for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;

      const record: DeviceRecord = {
        version: 1,
        id,
        name: device.name,
        model: device.model,
        publicKey,
        pairedAt: new Date(now).toISOString(),
      };

      yield* ensureDirectory(devicesDirectory(profilePath), "redeem pairing code");
      yield* writeJson(recordPath(profilePath, id), record, "redeem pairing code");

      return record;
    }),
  );

/** Renames a device; undefined when there is no such device. */
export const renameDevice = (
  profilePath: string,
  id: string,
  name: string,
): Effect.Effect<DeviceRecord | undefined, DeviceRegistryFailed> =>
  locked(
    profilePath,
    "rename device",
    Effect.gen(function* () {
      const record = yield* readDevice(profilePath, id, "rename device");

      if (record === undefined) return undefined;

      const renamed = { ...record, name };

      yield* writeJson(recordPath(profilePath, id), renamed, "rename device");

      return renamed;
    }),
  );

/** Forgets a device; its key is refused from then on. False when there is no such device. */
export const revokeDevice = (
  profilePath: string,
  id: string,
): Effect.Effect<boolean, DeviceRegistryFailed> =>
  locked(
    profilePath,
    "revoke device",
    Effect.gen(function* () {
      const record = yield* readDevice(profilePath, id, "revoke device");

      if (record === undefined) return false;

      const path = recordPath(profilePath, id);

      yield* Effect.tryPromise({
        try: () => rm(path),
        catch: (cause) => failed("revoke device", path, "could not remove the record", cause),
      });

      return true;
    }),
  );
