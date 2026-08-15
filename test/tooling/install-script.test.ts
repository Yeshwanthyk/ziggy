/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-try-catch-or-throw -- installer tests own a local HTTP fixture and process spawn */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const repositoryRoot = join(import.meta.dir, "../..");
const installScript = join(repositoryRoot, "scripts/install.sh");
const fixture = "#!/bin/sh\necho ziggy-fixture\n";
const fixtureSha = createHash("sha256").update(fixture).digest("hex");

const runInstall = async (
  env: Record<string, string>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const child = Bun.spawn(["sh", installScript], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode: exitCode ?? 1, stdout, stderr };
};

describe("scripts/install.sh", () => {
  const roots: Array<string> = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("is a valid POSIX script", () => {
    const result = Bun.spawnSync({ cmd: ["sh", "-n", installScript] });
    expect(result.exitCode).toBe(0);
  });

  test("installs a checksum-pinned darwin-arm64 binary", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "ziggy-install-bin-"));
    roots.push(binDir);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/ziggy-darwin-arm64") return new Response(fixture);
        if (path === "/ziggy-darwin-arm64.sha256") return new Response(`${fixtureSha}\n`);
        return new Response("missing", { status: 404 });
      },
    });
    try {
      const result = await runInstall({
        ZIGGY_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}`,
        ZIGGY_BIN_DIR: binDir,
        ZIGGY_OS: "Darwin",
        ZIGGY_ARCH: "arm64",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`installed ${join(binDir, "ziggy")}`);
      expect(await readFile(join(binDir, "ziggy"), "utf8")).toBe(fixture);
    } finally {
      server.stop(true);
    }
  });

  test("rejects a checksum mismatch", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "ziggy-install-bad-"));
    roots.push(binDir);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/ziggy-darwin-arm64") return new Response(fixture);
        if (path === "/ziggy-darwin-arm64.sha256") return new Response(`${"0".repeat(64)}\n`);
        return new Response("missing", { status: 404 });
      },
    });
    try {
      const result = await runInstall({
        ZIGGY_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}`,
        ZIGGY_BIN_DIR: binDir,
        ZIGGY_OS: "Darwin",
        ZIGGY_ARCH: "arm64",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("checksum mismatch");
    } finally {
      server.stop(true);
    }
  });

  test("refuses to overwrite a symlink", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "ziggy-install-link-"));
    roots.push(binDir);
    await mkdir(join(binDir, "elsewhere"), { recursive: true });
    await writeFile(join(binDir, "elsewhere", "ziggy"), fixture, { mode: 0o755 });
    await symlink(join(binDir, "elsewhere", "ziggy"), join(binDir, "ziggy"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/ziggy-darwin-arm64") return new Response(fixture);
        if (path === "/ziggy-darwin-arm64.sha256") return new Response(`${fixtureSha}\n`);
        return new Response("missing", { status: 404 });
      },
    });
    try {
      const result = await runInstall({
        ZIGGY_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}`,
        ZIGGY_BIN_DIR: binDir,
        ZIGGY_OS: "Darwin",
        ZIGGY_ARCH: "arm64",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("refusing to overwrite symlink");
    } finally {
      server.stop(true);
    }
  });

  test("fails closed on unsupported platforms", async () => {
    const result = await runInstall({
      ZIGGY_OS: "linux",
      ZIGGY_ARCH: "x64",
      ZIGGY_BIN_DIR: tmpdir(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("darwin-arm64");
  });
});
