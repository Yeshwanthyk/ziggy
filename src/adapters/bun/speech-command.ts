import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Option } from "effect";
import { SpeechFailed, type Transcriber, wavFromPcm16 } from "../../devices/index";
import { killProcess } from "./process";

/** More text than any recording's transcript; the rest is dropped. */
const MAX_TRANSCRIPT_BYTES = 64 * 1_024;

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

/**
 * Runs `command` per recording: `{wav}` in an argument becomes the path of the recording as a
 * WAV file, and the trimmed stdout is the transcript.
 */
export const commandTranscriber =
  (command: readonly [string, ...Array<string>], timeoutSeconds = 60): Transcriber =>
  (pcm) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "ziggy-speech-")),
        catch: (cause) =>
          new SpeechFailed({
            message: `could not make a folder for the recording: ${String(cause)}`,
          }),
      }),
      (folder) =>
        Effect.gen(function* () {
          const wav = join(folder, "recording.wav");

          yield* Effect.tryPromise({
            try: () => writeFile(wav, wavFromPcm16(pcm)),
            catch: (cause) =>
              new SpeechFailed({ message: `could not write the recording: ${String(cause)}` }),
          });

          const child = yield* Effect.try({
            try: () =>
              Bun.spawn(
                command.map((argument) => argument.replaceAll("{wav}", wav)),
                { cwd: folder, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
              ),
            catch: (cause) =>
              new SpeechFailed({ message: `could not start ${command[0]}: ${String(cause)}` }),
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

              return new SpeechFailed({ message: `${command[0]} failed: ${String(cause)}` });
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

          return stdout.trim();
        }),
      (folder) => Effect.promise(() => rm(folder, { recursive: true, force: true })),
    );
