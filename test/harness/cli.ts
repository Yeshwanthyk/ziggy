/** Runs the real `bun src/main.ts` against a scratch `ZIGGY_HOME`. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScratchProfile } from "./profile";

const repository = join(import.meta.dir, "..", "..");

const main = join(repository, "src", "main.ts");

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One transpiler cache for every child, outside any scratch home, so cold starts stay cheap. It is
 * the only state proofs share; bun keys it by content, so parallel workers can share it safely.
 */
const transpilerCache = join(tmpdir(), "ziggy-e2e-bun-cache");

const environment = (profile: ScratchProfile) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: profile.root,
  ZIGGY_HOME: profile.home,
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCache,
  NO_COLOR: "1",
});

export const ziggy = async (
  profile: ScratchProfile,
  ...args: ReadonlyArray<string>
): Promise<CliResult> => {
  const child = Bun.spawn([process.execPath, main, ...args], {
    cwd: profile.root,
    env: environment(profile),
    // Killed before bun's 5 s test timeout, so a hung command never outlives its proof.
    timeout: 4_500,
    killSignal: "SIGKILL",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
};

/** A long-running `ziggy ...` child, such as `serve` or `acp`; its stdin stays open for `acp`. */
export const spawnZiggy = (profile: ScratchProfile, ...args: ReadonlyArray<string>) =>
  Bun.spawn([process.execPath, main, ...args], {
    cwd: profile.root,
    env: environment(profile),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
