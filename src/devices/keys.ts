/**
 * The hub's static Noise key, one per Profile. It lives in the macOS Keychain (service
 * `ziggy-device-hub`, account derived from the Profile path); elsewhere, or with
 * `ZIGGY_DEVICE_KEYSTORE=file`, in `<profile>/.gateway/device-hub.key` (0600).
 */
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Config, Effect, Option, Schema } from "effect";
import { writeFileAtomic } from "../platform/atomic-write";
import { withFileLock } from "../platform/file-lock";
import { readGenericPassword, writeGenericPassword } from "../platform/keychain";
import {
  generateNoiseKeyPair,
  noiseKeyPairFromPrivate,
  type NoiseKeyPair,
} from "../platform/noise";
import { readPhysicalFile } from "../platform/tree";

export class DeviceKeyFailed extends Schema.TaggedErrorClass<DeviceKeyFailed>()("DeviceKeyFailed", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const DEVICE_HUB_KEY_SERVICE = "ziggy-device-hub";

const STORED_KEY = /^[A-Za-z0-9_-]{43}$/u;

const failed = (message: string, cause?: unknown) => new DeviceKeyFailed({ message, cause });

/** Where the key is kept: the Keychain on macOS unless `ZIGGY_DEVICE_KEYSTORE=file`. */
const keystore = Effect.gen(function* () {
  const configured = yield* Config.string("ZIGGY_DEVICE_KEYSTORE").pipe(Config.option);

  if (Option.getOrUndefined(configured) === "file") return "file" as const;

  return process.platform === "darwin" ? ("keychain" as const) : ("file" as const);
}).pipe(Effect.mapError((cause) => failed("ZIGGY_DEVICE_KEYSTORE is unreadable", cause)));

const keychainAccount = (profilePath: string) =>
  `profile-${createHash("sha256").update(profilePath).digest("hex").slice(0, 32)}`;

const keyFile = (profilePath: string) => join(profilePath, ".gateway", "device-hub.key");

const fromStored = (stored: string) =>
  STORED_KEY.test(stored)
    ? Effect.try({
        try: () => noiseKeyPairFromPrivate(new Uint8Array(Buffer.from(stored, "base64url"))),
        catch: (cause) => failed("the stored hub key is not an X25519 key", cause),
      })
    : Effect.fail(failed("the stored hub key is not an X25519 key"));

const readStored = (store: "keychain" | "file", profilePath: string) =>
  store === "keychain"
    ? readGenericPassword(DEVICE_HUB_KEY_SERVICE, keychainAccount(profilePath)).pipe(
        Effect.mapError((cause) => failed(cause.message, cause)),
      )
    : readPhysicalFile(keyFile(profilePath)).pipe(
        Effect.mapError((cause) => failed(cause.message, cause)),
        Effect.map((bytes) =>
          bytes === undefined ? undefined : new TextDecoder().decode(bytes).trim(),
        ),
      );

const writeStored = (store: "keychain" | "file", profilePath: string, stored: string) =>
  store === "keychain"
    ? writeGenericPassword(DEVICE_HUB_KEY_SERVICE, keychainAccount(profilePath), stored).pipe(
        Effect.mapError((cause) => failed(cause.message, cause)),
      )
    : Effect.gen(function* () {
        const directory = join(profilePath, ".gateway");

        yield* Effect.tryPromise({
          try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
          catch: (cause) => failed(`could not create ${directory}`, cause),
        });

        const status = yield* Effect.tryPromise({
          try: () => lstat(directory),
          catch: (cause) => failed(`could not inspect ${directory}`, cause),
        });

        if (!status.isDirectory() || status.isSymbolicLink())
          return yield* failed(`${directory} must be a physical directory`);

        yield* writeFileAtomic(keyFile(profilePath), `${stored}\n`, 0o600).pipe(
          Effect.mapError((cause) => failed(cause.message, cause)),
        );
      });

/** The Profile's hub key, created on first use. */
export const deviceHubKey = (profilePath: string): Effect.Effect<NoiseKeyPair, DeviceKeyFailed> =>
  Effect.gen(function* () {
    const store = yield* keystore;

    const existing = yield* readStored(store, profilePath);

    if (existing !== undefined) return yield* fromStored(existing);

    return yield* withFileLock(
      { root: profilePath, file: ".runtime/devices.sqlite", waitMs: 2000 },
      Effect.gen(function* () {
        // Another process may have created it while this one waited for the lock.
        const raced = yield* readStored(store, profilePath);

        if (raced !== undefined) return yield* fromStored(raced);

        const keyPair = generateNoiseKeyPair();

        yield* writeStored(
          store,
          profilePath,
          Buffer.from(keyPair.privateKey).toString("base64url"),
        );

        return keyPair;
      }),
      (cause) => failed("the device registry is busy", cause),
    );
  });
