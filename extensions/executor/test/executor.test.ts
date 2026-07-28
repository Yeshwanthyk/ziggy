/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests exercise the Pi Promise adapter boundary. */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runExecutorCommand } from "../index.ts";

describe("Executor command boundary", () => {
  test("passes cwd, signal, and timeout and bounds successful output", async () => {
    const controller = new AbortController();
    let observed:
      | {
          command: string;
          args: string[];
          options: Parameters<ExtensionAPI["exec"]>[2];
        }
      | undefined;
    const exec: ExtensionAPI["exec"] = async (command, args, options) => {
      observed = { command, args, options };
      return { stdout: "x".repeat(40_000), stderr: "", code: 0, killed: false };
    };

    const result = await runExecutorCommand(exec, {
      command: "executor",
      args: ["tools", "search", "mail"],
      cwd: "/profile",
      signal: controller.signal,
      timeout: 30_000,
    });

    expect(observed).toEqual({
      command: "executor",
      args: ["tools", "search", "mail"],
      options: { cwd: "/profile", signal: controller.signal, timeout: 30_000 },
    });
    expect(result.details.stdout.length).toBeLessThan(33_000);
    expect(result.details.stdout).toContain("characters omitted");
  });

  test("throws a clear bounded nonzero-exit error", async () => {
    const exec: ExtensionAPI["exec"] = async () => ({
      stdout: "partial",
      stderr: "failure",
      code: 7,
      killed: false,
    });

    expect(
      runExecutorCommand(exec, {
        command: "executor",
        args: ["call"],
        cwd: "/profile",
        signal: undefined,
        timeout: 120_000,
      }),
    ).rejects.toThrow("executor exited with code 7\nstderr:\nfailure\n\nstdout:\npartial");
  });
});
