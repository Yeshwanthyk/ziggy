/**
 * `<profile>/devices.json` turns the device hub on. Without it the resident opens no port.
 */
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { readPhysicalFile } from "../platform/tree";

/** A program run per recording: `{wav}` in an argument becomes the recording's WAV path. */
const SpeechCommand = Schema.Struct({
  command: Schema.NonEmptyArray(Schema.NonEmptyString),
  /** Default 60. */
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
  ),
});

export const DevicesConfig = Schema.Struct({
  version: Schema.Literal(1),
  listen: Schema.Struct({
    /** `0.0.0.0` for the LAN, `127.0.0.1` for this machine (or a tunnel) only. */
    host: Schema.NonEmptyString,
    /** `0` picks a free port. */
    port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
  }),
  speech: Schema.optionalKey(
    Schema.Struct({
      /** Prints the recording's text on stdout, e.g. `whisper-cli -m <model> -nt -np -f {wav}`. */
      transcribe: Schema.optionalKey(SpeechCommand),
    }),
  ),
});

export type DevicesConfig = typeof DevicesConfig.Type;

export class DevicesConfigInvalid extends Schema.TaggedErrorClass<DevicesConfigInvalid>()(
  "DevicesConfigInvalid",
  { path: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(DevicesConfig), {
  onExcessProperty: "error",
});

export const devicesConfigPath = (profilePath: string): string => join(profilePath, "devices.json");

/** The Profile's devices config, or undefined when devices are off. */
export const readDevicesConfig = (
  profilePath: string,
): Effect.Effect<DevicesConfig | undefined, DevicesConfigInvalid> =>
  Effect.gen(function* () {
    const path = devicesConfigPath(profilePath);

    const bytes = yield* readPhysicalFile(path).pipe(
      Effect.mapError((cause) => new DevicesConfigInvalid({ path, message: cause.message, cause })),
    );

    if (bytes === undefined) return undefined;

    return yield* decodeConfig(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError(
        (cause) => new DevicesConfigInvalid({ path, message: `${path}: ${cause.message}`, cause }),
      ),
    );
  });
