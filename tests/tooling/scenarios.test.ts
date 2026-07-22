import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "../../tooling/verification/compile-smoke.ts";
import { executeScenarios } from "../../tooling/verification/scenarios.ts";
import { CommandRecorder } from "../testkit/boundaries.ts";
import type { ScenarioDeclaration } from "../scenarios/registry.ts";
import {
  emptyRuntimeObservations,
  VERIFICATION_OBSERVATION_MARKER,
  type RuntimeObservations,
} from "../testkit/verification-observations.ts";

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
    const marker = `${VERIFICATION_OBSERVATION_MARKER}${JSON.stringify({
      scenarioId: scenario.id,
      observations: emptyRuntimeObservations(),
    })}`;
    const runner = new CommandRecorder({
      exitCode: 0,
      stdout: `tests/fixture.test.ts\n(pass) fixture\n 1 pass\n${marker}\n`,
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
      observations: emptyRuntimeObservations(),
    });
  });

  test("requires and decodes one bounded structured runtime marker for every stage", async () => {
    const s1 = { ...scenario, id: "s1.fixture", stage: "s1" } satisfies ScenarioDeclaration;
    const observations: RuntimeObservations = {
      ...emptyRuntimeObservations(),
      faultSchedule: [
        {
          boundary: "Session-log",
          point: "torn-final-line",
          occurrence: 1,
          outcome: "failed",
        },
      ],
    };
    const marker = `${VERIFICATION_OBSERVATION_MARKER}${JSON.stringify({
      scenarioId: s1.id,
      observations,
    })}`;
    const passed = await executeScenarios(
      "/fixture/repo",
      [s1],
      new CommandRecorder({
        exitCode: 0,
        stdout: `tests/fixture.test.ts\n(pass) fixture\n1 pass\n${marker}\n`,
        stderr: "",
        timedOut: false,
      }),
    );
    expect(passed[0]?.result).toBe("passed");
    expect(passed[0]?.observations).toEqual(observations);
    expect(passed[0]?.process.stdout).not.toContain(VERIFICATION_OBSERVATION_MARKER);

    for (const stage of ["s1", "s2", "s3"] as const) {
      const required = { ...s1, id: `${stage}.fixture`, stage } satisfies ScenarioDeclaration;
      const requiredMarker = marker.replace(s1.id, required.id);
      const mismatchedMarker = requiredMarker.replace(required.id, `${stage}.other`);
      const unknownFieldMarker = requiredMarker.replace(
        '"observations":',
        '"unexpected":true,"observations":',
      );
      for (const output of [
        "tests/fixture.test.ts\n(pass) fixture\n1 pass\n",
        `tests/fixture.test.ts\n(pass) fixture\n1 pass\n${requiredMarker}\n${requiredMarker}\n`,
        `tests/fixture.test.ts\n(pass) fixture\n1 pass\n${mismatchedMarker}\n`,
        `tests/fixture.test.ts\n(pass) fixture\n1 pass\n${unknownFieldMarker}\n`,
        `tests/fixture.test.ts\n(pass) fixture\n1 pass\n${VERIFICATION_OBSERVATION_MARKER}{}\n`,
        `tests/fixture.test.ts\n(pass) fixture\n1 pass\n${VERIFICATION_OBSERVATION_MARKER}${"x".repeat(32_769)}\n`,
      ]) {
        const result = await executeScenarios(
          "/fixture/repo",
          [required],
          new CommandRecorder({ exitCode: 0, stdout: output, stderr: "", timedOut: false }),
        );
        expect(result[0]?.result).toBe("failed");
      }
    }
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
