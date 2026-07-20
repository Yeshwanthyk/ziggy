import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../tests/testkit/boundaries.ts";

const entrypoint = "packages/ziggy/src/main.ts";
const defaultCompileTimeoutMs = 120_000;
const defaultVersionTimeoutMs = 10_000;

export interface CompileSmokeTimeouts {
  readonly compileMs: number;
  readonly versionMs: number;
}

export function buildCompileArgv(outfile: string): ReadonlyArray<string> {
  const argv = ["bun", "build", "--compile", entrypoint, "--outfile", outfile];
  validateCompileArgv(argv, outfile);
  return argv;
}

export function validateCompileArgv(argv: ReadonlyArray<string>, outfile: string): void {
  if (argv.includes("--minify") || argv.some((argument) => argument.startsWith("--minify="))) {
    throw new Error("compile smoke forbids --minify");
  }
  const expected = ["bun", "build", "--compile", entrypoint, "--outfile", outfile];
  if (
    argv.length !== expected.length ||
    argv.some((argument, index) => argument !== expected[index])
  ) {
    throw new Error("compile smoke argv differs from the locked command");
  }
}

export class BunProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error("process timeout must be a positive integer");
    }
    const child = Bun.spawn([...request.argv], {
      cwd: request.cwd,
      detached: true,
      stderr: "pipe",
      stdout: "pipe",
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      child.exited.then(() => false),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(true), request.timeoutMs);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (timedOut) {
      terminateProcessTree(child.pid);
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      stdoutPromise,
      stderrPromise,
    ]);
    return { exitCode, stdout, stderr, timedOut };
  }
}

export async function runCompileSmoke(
  root: string,
  runner: ProcessRunner = new BunProcessRunner(),
  timeouts: CompileSmokeTimeouts = {
    compileMs: defaultCompileTimeoutMs,
    versionMs: defaultVersionTimeoutMs,
  },
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ziggy-compile-smoke-"));
  const outfile = join(temporaryDirectory, "ziggy-smoke");
  try {
    const compile = await runner.run({
      argv: buildCompileArgv(outfile),
      cwd: root,
      timeoutMs: timeouts.compileMs,
    });
    requireSuccess("compile", compile);
    const version = await runner.run({
      argv: [outfile, "--version"],
      cwd: root,
      timeoutMs: timeouts.versionMs,
    });
    requireSuccess("version", version);
    if (version.stdout.trim() !== "0.0.0") {
      throw new Error(`compiled binary emitted unexpected version: ${version.stdout.trim()}`);
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function requireSuccess(label: string, result: ProcessResult): void {
  if (result.timedOut) {
    throw new Error(`${label} command timed out`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${label} command failed (${result.exitCode}): ${result.stderr}`);
  }
}

function terminateProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/pid", String(pid), "/t", "/f"], {
        stderr: "ignore",
        stdout: "ignore",
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

if (import.meta.main) {
  const root = new URL("../..", import.meta.url).pathname;
  await runCompileSmoke(root);
  console.log("compile smoke: ok");
}
