import type { ScenarioDeclaration } from "../../tests/scenarios/registry.ts";
import type { ProcessResult, ProcessRunner } from "../../tests/testkit/boundaries.ts";

export interface ScenarioExecution {
  readonly id: string;
  readonly file: string;
  readonly result: "passed" | "failed";
  readonly seed: string;
  readonly schedule: string;
  readonly boundaryConfiguration: string;
  readonly process: ProcessResult;
}

export async function executeScenarios(
  root: string,
  scenarios: ReadonlyArray<ScenarioDeclaration>,
  runner: ProcessRunner,
): Promise<ReadonlyArray<ScenarioExecution>> {
  const results: ScenarioExecution[] = [];
  for (const scenario of scenarios) {
    const process = await runner.run({
      argv: ["bun", "test", scenario.file],
      cwd: root,
      timeoutMs: 120_000,
    });
    const output = `${process.stdout}\n${process.stderr}`;
    const hasTests = /\b[1-9]\d* pass\b/.test(output) || /\(pass\)/.test(output);
    const skipped = /\([Ss]kip\)|\b[1-9]\d* skip\b|\b0 pass\b/.test(output);
    const namesDeclaredFile = output.includes(scenario.file);
    const passed =
      process.exitCode === 0 && !process.timedOut && hasTests && !skipped && namesDeclaredFile;
    results.push({
      id: scenario.id,
      file: scenario.file,
      result: passed ? "passed" : "failed",
      seed: scenario.seed,
      schedule: scenario.schedule,
      boundaryConfiguration: scenario.boundaryConfiguration,
      process,
    });
  }
  return results;
}
