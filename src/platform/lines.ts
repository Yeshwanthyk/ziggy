import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Effect, Schema } from "effect";

const READ_CHUNK_BYTES = 64 * 1024;

export class LineReadFailed extends Schema.TaggedErrorClass<LineReadFailed>()("LineReadFailed", {
  path: Schema.String,
  reason: Schema.Literals(["read", "wrong-type", "line-too-large"]),
  /** The 1-based line being read when it failed, for `line-too-large`. */
  line: Schema.optional(Schema.Number),
  cause: Schema.Defect(),
}) {}

/** What a line visitor returns: nothing to go on, `"stop"` to end early, or a value to fail with. */
export type LineVisit<E> = E | "stop" | undefined;

const readLines = async (
  file: string,
  maxLineBytes: number,
  signal: AbortSignal,
  visit: (line: string) => boolean,
) => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    if (!(await handle.stat()).isFile())
      throw new LineReadFailed({ path: file, reason: "wrong-type", cause: undefined });

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let parts: Array<Buffer> = [];
    let bytes = 0;
    let line = 0;
    let position = 0;

    /** Hand one line on; true means stop reading. */
    const emit = () => {
      line += 1;
      const text = Buffer.concat(parts, bytes).toString("utf8");
      parts = [];
      bytes = 0;

      return visit(text);
    };

    const take = (part: Buffer) => {
      bytes += part.byteLength;

      if (bytes > maxLineBytes)
        throw new LineReadFailed({
          path: file,
          reason: "line-too-large",
          line: line + 1,
          cause: { maximum: maxLineBytes },
        });

      if (part.byteLength > 0) parts.push(Buffer.from(part));
    };

    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);

      if (bytesRead === 0) break;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;

      for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, start)) {
        take(chunk.subarray(start, newline));
        start = newline + 1;

        if (emit()) return;
      }

      take(chunk.subarray(start));
    }

    if (bytes > 0) emit();
  } finally {
    await handle.close();
  }
};

/**
 * Stream a file's lines in bounded chunks through an O_NOFOLLOW handle. A file may grow without
 * bound, but no single line may pass `maxLineBytes`, so a bad file cannot pin memory.
 */
export const scanLines = <E>(
  file: string,
  maxLineBytes: number,
  visit: (line: string) => LineVisit<E>,
): Effect.Effect<void, E | LineReadFailed> =>
  Effect.gen(function* () {
    let rejected: { readonly value: E } | undefined;

    yield* Effect.tryPromise({
      try: (signal) =>
        readLines(file, maxLineBytes, signal, (line) => {
          const result = visit(line);

          if (result === undefined) return false;

          if (result === "stop") return true;
          rejected = { value: result };

          return true;
        }),
      catch: (cause) =>
        cause instanceof LineReadFailed
          ? cause
          : new LineReadFailed({ path: file, reason: "read", cause }),
    });

    if (rejected !== undefined) return yield* Effect.fail(rejected.value);
  });
