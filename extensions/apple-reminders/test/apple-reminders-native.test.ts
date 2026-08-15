/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests exercise the Pi Promise adapter boundary. */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { appleRemindersArguments, appleRemindersScriptPath, runAppleReminders } from "../index.ts";

describe("Apple Reminders native boundary", () => {
  test("passes model data as distinct argv values after a fixed script", async () => {
    const controller = new AbortController();
    const untrustedName = 'Buy milk" & do shell script "false';
    const untrustedList = "Personal'; rm -rf /";
    let observed:
      | {
          command: string;
          args: string[];
          options: Parameters<ExtensionAPI["exec"]>[2];
        }
      | undefined;
    const exec: ExtensionAPI["exec"] = async (command, args, options) => {
      observed = { command, args, options };
      return {
        stdout: `Created “${untrustedName}” in ${untrustedList}\n`,
        stderr: "",
        code: 0,
        killed: false,
      };
    };

    const result = await runAppleReminders(
      exec,
      {
        operation: "create",
        name: untrustedName,
        list: untrustedList,
        due: { kind: "timed", year: 2026, month: 8, day: 10, hour: 9, minute: 30 },
      },
      "/profile",
      controller.signal,
    );

    expect(observed).toEqual({
      command: "/usr/bin/osascript",
      args: [
        appleRemindersScriptPath,
        "create",
        untrustedName,
        untrustedList,
        "timed",
        "2026",
        "8",
        "10",
        "9",
        "30",
      ],
      options: { cwd: "/profile", signal: controller.signal, timeout: 45_000 },
    });
    expect(result.content[0]?.text).toContain(untrustedName);
  });

  test("rejects impossible calendar components before invoking osascript", async () => {
    let calls = 0;
    const exec: ExtensionAPI["exec"] = async () => {
      calls += 1;
      return { stdout: "", stderr: "", code: 0, killed: false };
    };

    expect(
      runAppleReminders(
        exec,
        {
          operation: "reschedule",
          name: "Renew passport",
          due: { kind: "all-day", year: 2026, month: 2, day: 30 },
        },
        "/profile",
        undefined,
      ),
    ).rejects.toThrow("Invalid calendar date: 2026-2-30");
    expect(calls).toBe(0);
  });

  test("does not retry an ambiguous mutation failure", async () => {
    let calls = 0;
    const exec: ExtensionAPI["exec"] = async () => {
      calls += 1;
      return {
        stdout: "",
        stderr: "execution error: VERIFY_FAILED: Could not resolve by ID (-2700)",
        code: 1,
        killed: false,
      };
    };

    expect(
      runAppleReminders(
        exec,
        {
          operation: "complete",
          name: "Renew passport",
          source_list: "Personal",
        },
        "/profile",
        undefined,
      ),
    ).rejects.toThrow(
      "The mutation was not retried. Inspect Reminders before attempting another write.",
    );
    expect(calls).toBe(1);
  });

  test("encodes delete confirmation and absolute all-day components", () => {
    expect(
      appleRemindersArguments({
        operation: "delete",
        name: "Disposable proof",
        source_list: "Personal",
        confirmed: true,
      }),
    ).toEqual(["delete", "Disposable proof", "Personal", "confirmed"]);
    expect(
      appleRemindersArguments({
        operation: "create",
        name: "Renew passport",
        list: "Personal",
        due: { kind: "all-day", year: 2026, month: 8, day: 12 },
      }),
    ).toEqual(["create", "Renew passport", "Personal", "all-day", "2026", "8", "12", "0", "0"]);
  });

  test("the fixed AppleScript program compiles without contacting Reminders", () => {
    const result = spawnSync("/usr/bin/osacompile", ["-o", "/dev/null", appleRemindersScriptPath], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("list moves fail closed before contacting Reminders", () => {
    const result = spawnSync(
      "/usr/bin/osascript",
      [appleRemindersScriptPath, "move", "Disposable", "Reminders", "Errands"],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MOVE_UNSUPPORTED");
    expect(result.stderr).toContain("no change was made");
  });
});
