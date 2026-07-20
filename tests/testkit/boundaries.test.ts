import { describe, expect, test } from "bun:test";
import { CommandRecorder, FilesystemFaultPlan, FixedClock, SequenceIds } from "./boundaries.ts";

describe("deterministic boundary testkit", () => {
  test("fixed clock advances only when directed", () => {
    const clock = new FixedClock("2026-07-19T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-07-19T00:00:00.000Z");
    clock.advance(250);
    expect(clock.now().toISOString()).toBe("2026-07-19T00:00:00.250Z");
    expect(() => clock.advance(-1)).toThrow("non-negative");
  });

  test("sequence IDs fail closed when exhausted", () => {
    const ids = new SequenceIds(["id-a", "id-b"]);
    expect(ids.next()).toBe("id-a");
    expect(ids.next()).toBe("id-b");
    expect(() => ids.next()).toThrow("exhausted");
  });

  test("filesystem fault plan triggers named points in order", () => {
    const faults = new FilesystemFaultPlan(["stage", "commit"]);
    faults.reach("other");
    expect(() => faults.reach("stage")).toThrow("stage");
    expect(faults.pending()).toEqual(["commit"]);
    expect(() => faults.reach("commit")).toThrow("commit");
  });

  test("command recorder captures immutable argv and controlled results", async () => {
    const recorder = new CommandRecorder({
      exitCode: 3,
      stdout: "out",
      stderr: "err",
      timedOut: false,
    });
    const argv = ["tool", "check"];
    const result = await recorder.run({ argv, cwd: "/fixture/repo", timeoutMs: 123 });
    argv.push("mutated");

    expect(recorder.commands).toEqual([
      { argv: ["tool", "check"], cwd: "/fixture/repo", timeoutMs: 123 },
    ]);
    expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "err", timedOut: false });
    recorder.respondWith({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    expect(await recorder.run({ argv: ["next"], cwd: "/fixture/repo", timeoutMs: 456 })).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    });
  });
});
