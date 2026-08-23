/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Standalone build/smoke helpers fail closed at the process boundary. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Assertion failures terminate this executable boundary. */
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";

export const PINNED_BUN_VERSION = "1.3.13";
export const STANDALONE_TARGET = "bun-darwin-arm64";

const StandaloneBuildReport = Schema.Struct({
  formatVersion: Schema.Literal(1),
  artifact: Schema.String,
  artifactBytes: Schema.Number,
  artifactSha256: Schema.String,
  buildMode: Schema.Literals(["development", "release"]),
  releaseReady: Schema.Boolean,
  sourceCommit: Schema.String,
  sourceDirty: Schema.Boolean,
  dirtyEntries: Schema.Array(Schema.String),
  bunVersion: Schema.String,
  target: Schema.Literal(STANDALONE_TARGET),
  buildArguments: Schema.Array(Schema.String),
  lockSha256: Schema.String,
  catalogFingerprint: Schema.String,
  piDocsFingerprint: Schema.String,
  piVersion: Schema.String,
  piDocsCount: Schema.Number,
});

export const decodeStandaloneBuildReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(StandaloneBuildReport),
);

export const compileArguments = () => [
  "build",
  "src/main.ts",
  "--compile",
  `--target=${STANDALONE_TARGET}`,
  "--root=.",
  "--asset-naming=[dir]/[name].[ext]",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-tsconfig",
  "--no-compile-autoload-package-json",
];

export const parseStandaloneBuildArguments = (arguments_, repositoryRoot) => {
  let development = false;
  let outputPath = path.join(repositoryRoot, "dist", "ziggy");
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--development") {
      development = true;
      continue;
    }
    if (argument === "--output" && arguments_[index + 1] !== undefined) {
      outputPath = path.resolve(repositoryRoot, arguments_[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(
      "usage: bun tooling/build-standalone-executable.mjs [--development] [--output <path>]",
    );
  }
  return { development, outputPath };
};

export const assertSafeStandaloneOutputPath = (outputPath, repositoryRoot) => {
  const normalizedOutput = path.resolve(outputPath);
  if (
    normalizedOutput === repositoryRoot ||
    normalizedOutput === path.parse(normalizedOutput).root
  ) {
    throw new Error("refusing unsafe standalone output path");
  }
  if (existsSync(normalizedOutput)) {
    const outputMetadata = lstatSync(normalizedOutput);
    if (!outputMetadata.isFile() || outputMetadata.isSymbolicLink()) {
      throw new Error("standalone output must be a regular file or a new path");
    }
  }
  return normalizedOutput;
};

export const assertStandaloneWorktreePolicy = (development, dirtyEntries) => {
  if (!development && dirtyEntries.length > 0) {
    throw new Error("release build requires a clean worktree");
  }
};

const sandboxString = (value) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export const sandboxProfile = (deniedCheckouts, network) =>
  [
    "(version 1)",
    "(allow default)",
    ...deniedCheckouts.flatMap((checkout) => [
      `(deny file-read* (subpath "${sandboxString(checkout)}"))`,
      `(deny file-write* (subpath "${sandboxString(checkout)}"))`,
    ]),
    ...(network ? [] : ["(deny network*)"]),
  ].join("\n");
