#!/usr/bin/env bun
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- The build boundary fails closed and reports command evidence. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Build assertion failures are process-boundary errors. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { BUILTIN_CATALOG_FINGERPRINT } from "../src/generated/builtin-catalog-metadata.ts";
import {
  PI_DOC_FILES,
  PI_DOCS_FINGERPRINT,
  PI_DOCS_VERSION,
} from "../src/adapters/pi/generated/pi-docs.ts";
import {
  PINNED_BUN_VERSION,
  STANDALONE_TARGET,
  assertSafeStandaloneOutputPath,
  assertStandaloneWorktreePolicy,
  compileArguments,
  parseStandaloneBuildArguments,
} from "./standalone-executable.mjs";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const { development, outputPath } = parseStandaloneBuildArguments(
  process.argv.slice(2),
  repositoryRoot,
);
const normalizedOutput = assertSafeStandaloneOutputPath(outputPath, repositoryRoot);
const reportPath = `${normalizedOutput}.build.json`;
const temporaryOutput = `${normalizedOutput}.tmp-${process.pid}`;
const temporaryReport = `${reportPath}.tmp-${process.pid}`;

const text = (bytes) => new TextDecoder().decode(bytes);
const run = (command, label) => {
  const result = Bun.spawnSync({
    cmd: command,
    cwd: repositoryRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = text(result.stdout);
  const stderr = text(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit ${result.exitCode}\n${stdout}${stderr}`);
  }
  return stdout.trim();
};

const sha256File = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");
const buildArguments = compileArguments();

try {
  if (Bun.version !== PINNED_BUN_VERSION) {
    throw new Error(`Bun ${PINNED_BUN_VERSION} is required; found ${Bun.version}`);
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      `first release target requires darwin-arm64; found ${process.platform}-${process.arch}`,
    );
  }
  const sourceCommit = run(["git", "rev-parse", "HEAD"], "read source commit");
  const dirtyEntries = run(
    ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    "inspect worktree",
  )
    .split("\n")
    .filter((line) => line.length > 0);
  assertStandaloneWorktreePolicy(development, dirtyEntries);

  run([process.execPath, "run", "check"], "bun run check");
  run([process.execPath, "test", "./test", "./extensions", "./tooling"], "focused Bun tests");
  run([process.execPath, "run", "test:helpers"], "helper tests");

  mkdirSync(path.dirname(normalizedOutput), { recursive: true });
  rmSync(temporaryOutput, { force: true });
  rmSync(temporaryReport, { force: true });
  run([process.execPath, ...buildArguments, `--outfile=${temporaryOutput}`], "standalone compile");
  chmodSync(temporaryOutput, 0o755);
  const report = {
    formatVersion: 1,
    artifact: path.relative(repositoryRoot, normalizedOutput) || normalizedOutput,
    artifactBytes: statSync(temporaryOutput).size,
    artifactSha256: sha256File(temporaryOutput),
    buildMode: development ? "development" : "release",
    releaseReady: !development,
    sourceCommit,
    sourceDirty: dirtyEntries.length > 0,
    dirtyEntries,
    bunVersion: Bun.version,
    target: STANDALONE_TARGET,
    buildArguments,
    lockSha256: sha256File(path.join(repositoryRoot, "bun.lock")),
    catalogFingerprint: BUILTIN_CATALOG_FINGERPRINT,
    piDocsFingerprint: PI_DOCS_FINGERPRINT,
    piVersion: PI_DOCS_VERSION,
    piDocsCount: PI_DOC_FILES.size,
  };
  writeFileSync(temporaryReport, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  renameSync(temporaryOutput, normalizedOutput);
  renameSync(temporaryReport, reportPath);
  console.log(`artifact=${normalizedOutput}`);
  console.log(`report=${reportPath}`);
  console.log(`sha256=${report.artifactSha256}`);
  console.log(`release_ready=${report.releaseReady}`);
} finally {
  rmSync(temporaryOutput, { force: true });
  rmSync(temporaryReport, { force: true });
}
