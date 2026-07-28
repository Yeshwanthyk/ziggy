/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests exercise the Pi Promise adapter boundary. */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { linearScriptPath, runLinearCommand } from "../index.ts";

describe("Linear command boundary", () => {
  test("resolves and executes the package-local helper from the Profile cwd", async () => {
    let command = "";
    const exec: ExtensionAPI["exec"] = async (observedCommand, args, options) => {
      command = observedCommand;
      expect(args).toEqual(["list-teams"]);
      expect(options).toEqual({ cwd: "/profile", timeout: 30_000 });
      return { stdout: '{"teams":[]}\n', stderr: "", code: 0, killed: false };
    };

    const result = await runLinearCommand(exec, ["list-teams"], "/profile", undefined);

    expect(command).toBe(linearScriptPath);
    expect(command).toEndWith("/extensions/linear/scripts/linear_api.py");
    expect(result.details.stdout).toBe('{"teams":[]}\n');
  });

  test("reports helper failures with output", async () => {
    const exec: ExtensionAPI["exec"] = async () => ({
      stdout: '{"ok":false}',
      stderr: "",
      code: 1,
      killed: false,
    });

    expect(runLinearCommand(exec, ["whoami"], "/profile", undefined)).rejects.toThrow(
      'Linear helper exited with code 1\nstdout:\n{"ok":false}',
    );
  });
});
