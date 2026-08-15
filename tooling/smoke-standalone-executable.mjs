#!/usr/bin/env bun
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- This executable boundary reports failed smoke assertions by exit status and always removes its disposable tree. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Assertion failures terminate this build/smoke executable boundary. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeStandaloneBuildReport, sandboxProfile } from "./standalone-executable.mjs";

const repositoryRoot = path.resolve(import.meta.dir, "..");
let artifactPath = path.join(repositoryRoot, "dist", "ziggy");
let allowDevelopment = false;
const arguments_ = process.argv.slice(2);
for (let index = 0; index < arguments_.length; index += 1) {
  const argument = arguments_[index];
  if (argument === "--allow-development") {
    allowDevelopment = true;
    continue;
  }
  if (argument === "--artifact" && arguments_[index + 1] !== undefined) {
    artifactPath = path.resolve(repositoryRoot, arguments_[index + 1]);
    index += 1;
    continue;
  }
  throw new Error(
    "usage: bun tooling/smoke-standalone-executable.mjs [--artifact <path>] [--allow-development]",
  );
}

const reportPath = `${artifactPath}.build.json`;
if (!existsSync(artifactPath) || !existsSync(reportPath)) {
  throw new Error("build artifact and report are required; run bun run build:binary first");
}
const report = decodeStandaloneBuildReport(readFileSync(reportPath, "utf8"));
const artifactSha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
if (report.artifactSha256 !== artifactSha256) {
  throw new Error("artifact SHA-256 does not match its build report");
}
if (!allowDevelopment && report.releaseReady !== true) {
  throw new Error("smoke requires a release-ready build report");
}

const probeRoot = mkdtempSync(path.join(tmpdir(), "ziggy-standalone-smoke-"));
const runDirectory = path.join(probeRoot, "run");
const homeDirectory = path.join(probeRoot, "home");
const temporaryDirectory = path.join(probeRoot, "tmp");
const copiedExecutable = path.join(runDirectory, "ziggy");
const profilePath = path.join(homeDirectory, "profile");
const text = (bytes) => new TextDecoder().decode(bytes);

const run = (command, cwd, env) => {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: text(result.stdout),
    stderr: text(result.stderr),
  };
};

const requireSuccess = (label, result) => {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${result.exitCode}\n${result.stdout}${result.stderr}`,
    );
  }
};

const gitWorktrees = run(["git", "worktree", "list", "--porcelain"], repositoryRoot, process.env);
requireSuccess("list source worktrees", gitWorktrees);
const deniedCheckouts = gitWorktrees.stdout
  .split("\n")
  .filter((line) => line.startsWith("worktree "))
  .map((line) => line.slice("worktree ".length));

const isolatedEnvironment = {
  HOME: homeDirectory,
  LANG: "C",
  LC_ALL: "C",
  NO_COLOR: "1",
  PATH: "/usr/bin:/bin",
  TERM: "dumb",
  TMPDIR: temporaryDirectory,
  XDG_CACHE_HOME: path.join(homeDirectory, ".cache"),
  XDG_CONFIG_HOME: path.join(homeDirectory, ".config"),
  ZIGGY_HOME: path.join(homeDirectory, ".ziggy"),
};

const runExecutable = (arguments__, cwd = runDirectory) =>
  run(
    [
      "/usr/bin/sandbox-exec",
      "-p",
      sandboxProfile(deniedCheckouts, false),
      copiedExecutable,
      ...arguments__,
    ],
    cwd,
    isolatedEnvironment,
  );

const makeTreeRemovable = (root) => {
  if (!existsSync(root)) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) makeTreeRemovable(path.join(root, entry.name));
  }
};

try {
  mkdirSync(runDirectory);
  mkdirSync(homeDirectory);
  mkdirSync(temporaryDirectory);
  copyFileSync(artifactPath, copiedExecutable);
  const adjacentFiles = readdirSync(runDirectory).sort();
  if (adjacentFiles.length !== 1 || adjacentFiles[0] !== "ziggy") {
    throw new Error(`run directory must contain only the executable: ${adjacentFiles.join(", ")}`);
  }

  console.log(`artifact_sha256=${artifactSha256}`);
  console.log(`build_mode=${report.buildMode}`);
  console.log(`source_commit=${report.sourceCommit}`);
  console.log(`denied_checkouts=${deniedCheckouts.length}`);

  const version = runExecutable(["version"]);
  requireSuccess("version", version);
  if (version.stdout.trim() !== "0.1.0") throw new Error("unexpected version output");
  const help = runExecutable(["help"]);
  requireSuccess("complete help", help);
  if (!help.stdout.includes("ziggy extensions list|show|add|remove")) {
    throw new Error("help omitted the extension command surface");
  }

  const extensions = runExecutable(["extensions", "list"]);
  requireSuccess("extensions list", extensions);
  if (!extensions.stdout.includes("self-improvement\tskill+code\toptional\tbundled")) {
    throw new Error("embedded extension catalog is incomplete");
  }
  const shown = runExecutable(["extensions", "show", "self-improvement"]);
  requireSuccess("extensions show", shown);
  if (!shown.stdout.includes("id\tself-improvement") || !shown.stdout.includes("skill\tcurator")) {
    throw new Error("extensions show omitted bundled self-improvement metadata");
  }

  requireSuccess("minimal init", runExecutable(["init", profilePath, "--minimal"]));
  requireSuccess(
    "extensions add",
    runExecutable(["extensions", "add", profilePath, "self-improvement"]),
  );
  const installedPackage = path.join(profilePath, "extensions", "self-improvement");
  if (!existsSync(path.join(installedPackage, "package.json"))) {
    throw new Error("extensions add did not copy self-improvement into the Profile");
  }
  const expectedCurator = readFileSync(
    path.join(repositoryRoot, "extensions/self-improvement/skills/curator/SKILL.md"),
  );
  const installedCurator = readFileSync(
    path.join(installedPackage, "skills", "curator", "SKILL.md"),
  );
  if (!installedCurator.equals(expectedCurator)) {
    throw new Error("copied binary did not materialize curator SKILL.md bytes");
  }
  if (!text(installedCurator).includes("self_improvement_status")) {
    throw new Error("copied curator SKILL.md omitted expected curator workflow content");
  }
  const curatorAutomation = readFileSync(
    path.join(profilePath, "automations", "self-improvement-curator.md"),
    "utf8",
  );
  if (!curatorAutomation.includes("owner: extension:self-improvement")) {
    throw new Error("curator automation was not provisioned from the bundled package");
  }

  const doctor = runExecutable(["doctor", profilePath]);
  if (
    doctor.exitCode !== 1 ||
    !doctor.stdout.includes("OK\tresources\t") ||
    !doctor.stdout.includes("0 bundled factories, 1 Profile extension entrypoints") ||
    !doctor.stdout.includes(
      `OK\tpi_docs\t@earendil-works/pi-coding-agent@${report.piVersion} fingerprint=${report.piDocsFingerprint} count=${report.piDocsCount}`,
    )
  ) {
    throw new Error(`doctor did not report Profile resources and pinned Pi docs\n${doctor.stdout}`);
  }

  const models = runExecutable(["models", "status", profilePath]);
  requireSuccess("model status", models);
  if (
    !models.stdout.includes("provider\tnone") ||
    !models.stdout.includes("auth\tnot configured")
  ) {
    throw new Error(`unexpected models status\n${models.stdout}`);
  }

  const finalAdjacentFiles = readdirSync(runDirectory).filter((entry) => entry !== "ziggy");
  if (finalAdjacentFiles.length > 0) {
    throw new Error(
      `standalone runtime created an adjacent sidecar: ${finalAdjacentFiles.join(", ")}`,
    );
  }
  console.log("checkout_reads=denied");
  console.log("adjacent_sidecars=none");
  console.log("standalone_smoke=pass");
} finally {
  makeTreeRemovable(probeRoot);
  rmSync(probeRoot, { force: true, recursive: true });
}
