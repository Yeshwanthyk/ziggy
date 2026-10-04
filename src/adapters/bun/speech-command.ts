import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Option } from "effect";
import {
  MAX_SPOKEN_BYTES,
  type Speaker,
  SpeechFailed,
  type Transcriber,
  isMp3,
  wavFromPcm16,
} from "../../devices/index";
import { killProcess } from "./process";

/** More text than any recording's transcript; the rest is dropped. */
const MAX_TRANSCRIPT_BYTES = 64 * 1_024;

type SpeechCommand = readonly [string, ...Array<string>];

const failed = (message: string) => (cause: unknown) =>
  new SpeechFailed({ message: `${message}: ${String(cause)}` });

/** Keeps the first `limit` bytes of a stream as text, reading it to the end. */
const readCapped = async (stream: ReadableStream<Uint8Array>, limit: number) => {
  const kept: Array<Uint8Array> = [];

  let size = 0;

  for await (const chunk of stream) {
    if (size < limit) kept.push(chunk.subarray(0, limit - size));

    size += chunk.length;
  }

  return Buffer.concat(kept).toString("utf8");
};

/** Runs `use` with a fresh temporary folder, removed afterwards. */
const inFolder = <A>(use: (folder: string) => Effect.Effect<A, SpeechFailed>) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "ziggy-speech-")),
      catch: failed("could not make a folder for speech"),
    }),
    use,
    (folder) => Effect.promise(() => rm(folder, { recursive: true, force: true })),
  );

/**
 * Runs `command` without a shell, with each `{name}` in an argument replaced from `values`, and
 * gives its stdout. A non-zero exit or the timeout fails, with the start of stderr.
 */
const run = (
  command: SpeechCommand,
  values: Readonly<Record<string, string>>,
  folder: string,
  timeoutSeconds: number,
) =>
  Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn(
          command.map((argument) =>
            Object.entries(values).reduce(
              (replaced, [name, value]) => replaced.replaceAll(`{${name}}`, value),
              argument,
            ),
          ),
          { cwd: folder, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        ),
      catch: failed(`could not start ${command[0]}`),
    });

    const finished = yield* Effect.tryPromise({
      try: (signal) => {
        const kill = () => killProcess(child);

        signal.addEventListener("abort", kill, { once: true });

        return Promise.all([
          child.exited,
          readCapped(child.stdout, MAX_TRANSCRIPT_BYTES),
          readCapped(child.stderr, 2_048),
        ]).finally(() => signal.removeEventListener("abort", kill));
      },
      catch: (cause) => {
        killProcess(child);

        return failed(`${command[0]} failed`)(cause);
      },
    }).pipe(Effect.timeoutOption(Duration.seconds(timeoutSeconds)));

    if (Option.isNone(finished))
      return yield* new SpeechFailed({
        message: `${command[0]} took longer than ${timeoutSeconds} s`,
      });

    const [exitCode, stdout, stderr] = finished.value;

    if (exitCode !== 0)
      return yield* new SpeechFailed({
        message: `${command[0]} exited ${exitCode}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
      });

    return stdout;
  });

/**
 * Runs `command` per recording: `{wav}` in an argument becomes the path of the recording as a
 * WAV file, and the trimmed stdout is the transcript.
 */
export const commandTranscriber =
  (command: SpeechCommand, timeoutSeconds = 60): Transcriber =>
  (pcm) =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const wav = join(folder, "recording.wav");

        yield* Effect.tryPromise({
          try: () => writeFile(wav, wavFromPcm16(pcm)),
          catch: failed("could not write the recording"),
        });

        return (yield* run(command, { wav }, folder, timeoutSeconds)).trim();
      }),
    );

/**
 * Runs `command` per reply: `{text}` in an argument becomes the reply and `{mp3}` the path the
 * command writes its MP3 to.
 */
export const commandSpeaker =
  (command: SpeechCommand, timeoutSeconds = 60): Speaker =>
  (text) =>
    inFolder((folder) =>
      Effect.gen(function* () {
        const mp3 = join(folder, "reply.mp3");

        yield* run(command, { text, mp3 }, folder, timeoutSeconds);

        const audio = yield* Effect.tryPromise({
          try: () => readFile(mp3),
          catch: () => new SpeechFailed({ message: `${command[0]} wrote no file at {mp3}` }),
        });

        if (!isMp3(audio))
          return yield* new SpeechFailed({ message: `${command[0]} did not write an MP3` });

        if (audio.length > MAX_SPOKEN_BYTES)
          return yield* new SpeechFailed({
            message: `${command[0]} wrote ${audio.length} bytes, more than ${MAX_SPOKEN_BYTES}`,
          });

        return new Uint8Array(audio);
      }),
    );
