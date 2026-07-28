import { Inspectable, Option, Schema } from "effect";

const FileSystemCause = Schema.Struct({
  message: Schema.String,
  code: Schema.optional(Schema.String),
});

const decodeFileSystemCause = Schema.decodeUnknownOption(FileSystemCause);

export interface FileSystemCauseDetails {
  readonly message: string;
  readonly code: string | undefined;
}

export const fileSystemCauseDetails = (cause: unknown): FileSystemCauseDetails =>
  Option.match(decodeFileSystemCause(cause), {
    onNone: () => ({
      message: Inspectable.toStringUnknown(cause),
      code: undefined,
    }),
    onSome: ({ message, code }) => ({ message, code }),
  });
