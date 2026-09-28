import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { fileSystemCauseDetails } from "./cause";
import { ProfileFileSystemError } from "../../domain/profile";
import { ProfileStore, type ProfileFilesApi } from "../../application/profiles";

const failure = (operation: string, path: string, cause: unknown): ProfileFileSystemError => {
  const details = fileSystemCauseDetails(cause);

  return new ProfileFileSystemError({
    operation,
    path,
    message: details.message,
    code: details.code,
    cause,
  });
};

const files: ProfileFilesApi = {
  lstat: (path) =>
    Effect.tryPromise({
      try: () => lstat(path),
      catch: (cause) => failure("inspect", path, cause),
    }),
  mkdir: (path, options) =>
    Effect.tryPromise({
      try: () => mkdir(path, options),
      catch: (cause) => failure("create directory", path, cause),
    }).pipe(Effect.asVoid),
  read: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => failure("read", path, cause),
    }),
  write: (path, content, options) =>
    Effect.tryPromise({
      try: () => writeFile(path, content, options),
      catch: (cause) => failure("write", path, cause),
    }),
  append: (path, content) =>
    Effect.tryPromise({
      try: () => appendFile(path, content, "utf8"),
      catch: (cause) => failure("append", path, cause),
    }),
  readdir: (path) =>
    Effect.tryPromise({
      try: () => readdir(path, { withFileTypes: true }),
      catch: (cause) => failure("list", path, cause),
    }),
};

export const ProfileStoreLive = Layer.succeed(ProfileStore, files);
