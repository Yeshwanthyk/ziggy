import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { CommandRecorder, type ProcessRequest } from "../testkit/boundaries.ts";
import {
  buildCompileArgv,
  runCompileSmoke,
  validateCompileArgv,
} from "../../tooling/verification/compile-smoke.ts";

describe("compile smoke verifier", () => {
  test("constructs the locked argv", () => {
    expect(buildCompileArgv("/fixture/ziggy-smoke")).toEqual([
      "bun",
      "build",
      "--compile",
      "packages/ziggy/src/main.ts",
      "--outfile",
      "/fixture/ziggy-smoke",
    ]);
  });

  test("rejects minify without invoking Bun's known crash", () => {
    expect(() =>
      validateCompileArgv(
        [
          "bun",
          "build",
          "--compile",
          "--minify",
          "packages/ziggy/src/main.ts",
          "--outfile",
          "/fixture/ziggy-smoke",
        ],
        "/fixture/ziggy-smoke",
      ),
    ).toThrow("forbids --minify");
    expect(() =>
      validateCompileArgv(
        [
          "bun",
          "build",
          "--compile",
          "packages/ziggy/src/main.ts",
          "--outfile",
          "/fixture/ziggy-smoke",
          "--bytecode",
        ],
        "/fixture/ziggy-smoke",
      ),
    ).toThrow("locked command");
  });

  test("requires the compiled binary to emit version 0.0.0", async () => {
    const recorder = new CommandRecorder({
      exitCode: 0,
      stdout: "0.0.0\n",
      stderr: "",
      timedOut: false,
    });
    const runner = {
      run(request: ProcessRequest) {
        recorder.respondWith({
          exitCode: 0,
          stdout:
            request.argv[1] === "--runtime-mode"
              ? "compiled\n"
              : request.argv[1] === "--oauth-loader-smoke"
                ? "oauth-loaders:ok\n"
                : "0.0.0\n",
          stderr: "",
          timedOut: false,
        });
        return recorder.run(request);
      },
    };
    await runCompileSmoke("/fixture/repo", runner);
    expect(recorder.commands).toHaveLength(4);
    const compile = recorder.commands[0];
    const version = recorder.commands[1];
    const runtimeMode = recorder.commands[2];
    const oauthLoader = recorder.commands[3];
    if (
      compile === undefined ||
      version === undefined ||
      runtimeMode === undefined ||
      oauthLoader === undefined
    ) {
      throw new Error("expected compile, version, runtime-mode, and OAuth-loader commands");
    }
    const compiledOutfile = compile.argv[5];
    if (compiledOutfile === undefined) throw new Error("expected compiled outfile");
    expect(compile.argv.slice(0, 5)).toEqual([
      "bun",
      "build",
      "--compile",
      "packages/ziggy/src/main.ts",
      "--outfile",
    ]);
    expect(version.argv[0]).toBe(compiledOutfile);
    expect(version.argv[1]).toBe("--version");
    expect(runtimeMode.argv).toEqual([compiledOutfile, "--runtime-mode"]);
    expect(oauthLoader.argv).toEqual([compiledOutfile, "--oauth-loader-smoke"]);
    expect(compile.timeoutMs).toBe(120_000);
    expect(version.timeoutMs).toBe(10_000);
    expect(runtimeMode.timeoutMs).toBe(10_000);
    expect(oauthLoader.timeoutMs).toBe(10_000);
  });

  test("fails bounded timeouts and always removes the isolated directory", async () => {
    const recorder = new CommandRecorder({
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    await expect(
      runCompileSmoke("/fixture/repo", recorder, { compileMs: 5, versionMs: 5 }),
    ).rejects.toThrow("timed out");
    const command = recorder.commands[0];
    const outfile = command?.argv[5];
    if (outfile === undefined) {
      throw new Error("missing compile outfile fixture");
    }
    expect(command?.timeoutMs).toBe(5);
    expect(existsSync(dirname(outfile))).toBe(false);
  });
});
