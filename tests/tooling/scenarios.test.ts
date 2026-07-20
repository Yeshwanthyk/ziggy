import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "../../tooling/verification/compile-smoke.ts";
import { executeScenarios } from "../../tooling/verification/scenarios.ts";
import { CommandRecorder } from "../testkit/boundaries.ts";
import type { ScenarioDeclaration } from "../scenarios/registry.ts";

const scenario: ScenarioDeclaration = {
  schemaVersion: 1,
  id: "s0.fixture",
  stage: "s0",
  file: "tests/fixture.test.ts",
  seed: "fixture-seed",
  schedule: "fixture-schedule",
  boundaryConfiguration: "fixture-boundaries",
};

describe("explicit scenario execution", () => {
  test("executes each declared module and preserves actual deterministic configuration", async () => {
    const runner = new CommandRecorder({
      exitCode: 0,
      stdout: "tests/fixture.test.ts\n(pass) fixture\n 1 pass\n",
      stderr: "",
      timedOut: false,
    });
    const results = await executeScenarios("/fixture/repo", [scenario], runner);

    expect(runner.commands).toEqual([
      {
        argv: ["bun", "test", "tests/fixture.test.ts"],
        cwd: "/fixture/repo",
        timeoutMs: 120_000,
      },
    ]);
    expect(results[0]).toMatchObject({
      id: "s0.fixture",
      file: "tests/fixture.test.ts",
      result: "passed",
      seed: "fixture-seed",
      schedule: "fixture-schedule",
      boundaryConfiguration: "fixture-boundaries",
    });
  });

  test("real Bun skipped and no-test modules fail the scenario gate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ziggy-real-scenarios-"));
    try {
      await Bun.write(
        join(directory, "skipped.test.ts"),
        'import { test } from "bun:test";\ntest.skip("skipped", () => {});\n',
      );
      await Bun.write(join(directory, "no-tests.test.ts"), "export {};\n");
      const results = await executeScenarios(
        directory,
        [
          { ...scenario, id: "s0.skipped", file: "skipped.test.ts" },
          { ...scenario, id: "s0.no-tests", file: "no-tests.test.ts" },
        ],
        new BunProcessRunner(),
      );

      expect(results.map((result) => result.result)).toEqual(["failed", "failed"]);
      expect(results.map((result) => result.process.exitCode)).toEqual([0, 0]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails skipped, no-test, command-failure, and output/file mismatch runs", async () => {
    for (const process of [
      {
        exitCode: 0,
        stdout: "tests/fixture.test.ts\n(skip) fixture\n0 pass\n",
        stderr: "",
        timedOut: false,
      },
      { exitCode: 0, stdout: "tests/fixture.test.ts\n0 pass\n", stderr: "", timedOut: false },
      {
        exitCode: 1,
        stdout: "tests/fixture.test.ts\n(pass) fixture\n1 pass\n",
        stderr: "",
        timedOut: false,
      },
      {
        exitCode: 0,
        stdout: "tests/other.test.ts\n(pass) fixture\n1 pass\n",
        stderr: "",
        timedOut: false,
      },
    ]) {
      const results = await executeScenarios(
        "/fixture/repo",
        [scenario],
        new CommandRecorder(process),
      );
      expect(results[0]?.result).toBe("failed");
    }
  });
});
