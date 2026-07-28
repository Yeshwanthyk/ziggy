/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests exercise the Pi Promise adapter boundary. */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGithubCommand } from "../index.ts";

describe("GitHub command boundary", () => {
  test("executes gh in the Profile cwd with cancellation and timeout", async () => {
    const controller = new AbortController();
    let cwd: string | undefined;
    const exec: ExtensionAPI["exec"] = async (_command, _args, options) => {
      cwd = options?.cwd;
      expect(options).toEqual({
        cwd: "/profile",
        signal: controller.signal,
        timeout: 30_000,
      });
      return { stdout: "[]\n", stderr: "", code: 0, killed: false };
    };

    const result = await runGithubCommand(exec, ["issue", "list"], "/profile", controller.signal);

    expect(cwd).toBe("/profile");
    expect(result.content[0]?.text).toBe("[]\n");
  });

  test("reports a terminated command as an error", async () => {
    const exec: ExtensionAPI["exec"] = async () => ({
      stdout: "",
      stderr: "cancelled",
      code: 143,
      killed: true,
    });

    expect(runGithubCommand(exec, ["api", "user"], "/profile", undefined)).rejects.toThrow(
      "gh was terminated\nstderr:\ncancelled",
    );
  });
});
