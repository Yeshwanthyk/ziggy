import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Effect } from "effect";
import { SessionReadFailed } from "../../domain/session";

const READ_CHUNK_BYTES = 64 * 1024;

// A transcript may grow without bound, but one JSONL record must remain bounded so a
// malformed file cannot make the streaming reader retain arbitrary memory.
export const MAX_TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024;

export class TranscriptLineRejected {
  readonly _tag = "TranscriptLineRejected";

  constructor(readonly failure: SessionReadFailed) {}
}

const readFailure = (file: string, message: string, cause: unknown) =>
  new SessionReadFailed({ path: file, operation: "read", message, cause });

const scanPhysical = async (
  file: string,
  signal: AbortSignal,
  visit: (line: string, lineNumber: number) => boolean | void,
): Promise<string> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const status = await handle.stat();

    if (!status.isFile()) {
      throw readFailure(file, "Pi session transcript is not a regular file", {
        kind: "wrong-type",
      });
    }

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let lineParts: Array<Uint8Array> = [];
    let lineBytes = 0;
    let lineNumber = 0;
    let position = 0;

    const emitLine = (): boolean => {
      lineNumber += 1;
      const line = Buffer.concat(lineParts, lineBytes).toString("utf8");
      lineParts = [];
      lineBytes = 0;

      return visit(line, lineNumber) !== false;
    };

    while (true) {
      signal.throwIfAborted();
      const result = await handle.read(buffer, 0, buffer.byteLength, position);

      if (result.bytesRead === 0) break;
      position += result.bytesRead;
      const chunk = buffer.subarray(0, result.bytesRead);
      digest.update(chunk);
      let start = 0;

      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const part = chunk.subarray(start, index);
        lineBytes += part.byteLength;

        if (lineBytes > MAX_TRANSCRIPT_LINE_BYTES) {
          throw readFailure(file, "Pi session transcript contains an oversized JSONL record", {
            kind: "line-too-large",
            line: lineNumber + 1,
            maximum: MAX_TRANSCRIPT_LINE_BYTES,
          });
        }

        if (part.byteLength > 0) lineParts.push(Buffer.from(part));

        if (!emitLine()) return digest.digest("hex");
        start = index + 1;
      }

      const remainder = chunk.subarray(start);
      lineBytes += remainder.byteLength;

      if (lineBytes > MAX_TRANSCRIPT_LINE_BYTES) {
        throw readFailure(file, "Pi session transcript contains an oversized JSONL record", {
          kind: "line-too-large",
          line: lineNumber + 1,
          maximum: MAX_TRANSCRIPT_LINE_BYTES,
        });
      }

      if (remainder.byteLength > 0) lineParts.push(Buffer.from(remainder));
    }

    if (lineBytes > 0) emitLine();

    return digest.digest("hex");
  } finally {
    await handle.close();
  }
};

export const scanTranscriptLines = (
  file: string,
  visit: (line: string, lineNumber: number) => boolean | void,
): Effect.Effect<string, SessionReadFailed> =>
  Effect.tryPromise({
    try: (signal) => scanPhysical(file, signal, visit),
    catch: (cause) => {
      if (cause instanceof TranscriptLineRejected) return cause.failure;

      if (cause instanceof SessionReadFailed) return cause;

      return readFailure(file, "could not stream Pi session transcript", cause);
    },
  });
