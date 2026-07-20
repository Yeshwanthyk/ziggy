export interface ScenarioDeclaration {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly stage: "s0" | "s1" | "s2" | "s3" | "s4" | "s5" | "s6" | "s7";
  readonly file: string;
  readonly seed: string;
  readonly schedule: string;
  readonly boundaryConfiguration: string;
}

export const scenarioRegistry: ReadonlyArray<ScenarioDeclaration> = [
  {
    schemaVersion: 1,
    id: "s0.boundary-testkit",
    stage: "s0",
    file: "tests/testkit/boundaries.test.ts",
    seed: "s0-boundary-v1",
    schedule: "serial-controlled-boundaries",
    boundaryConfiguration: "fixed-clock-sequence-ids-fault-plan-command-recorder",
  },
  {
    schemaVersion: 1,
    id: "s0.compile-smoke-flags",
    stage: "s0",
    file: "tests/tooling/compile-smoke.test.ts",
    seed: "s0-compile-v1",
    schedule: "controlled-process-runner",
    boundaryConfiguration: "isolated-temp-process-timeout",
  },
  {
    schemaVersion: 1,
    id: "s0.package-graph",
    stage: "s0",
    file: "tests/tooling/package-graph.test.ts",
    seed: "s0-package-graph-v1",
    schedule: "static-fixture-mutations",
    boundaryConfiguration: "typescript-ast-repository-graph",
  },
  {
    schemaVersion: 1,
    id: "s0.verification-integrity",
    stage: "s0",
    file: "tests/tooling/verification.test.ts",
    seed: "s0-verification-v1",
    schedule: "isolated-artifact-publication",
    boundaryConfiguration: "synthetic-evidence-and-replay-inputs",
  },
  {
    schemaVersion: 1,
    id: "s0.world-contract",
    stage: "s0",
    file: "tests/testkit/world/world-contract.test.ts",
    seed: "s0-world-v1",
    schedule: "required-memory-commit-cut-points",
    boundaryConfiguration: "fixed-clock-in-memory-semantic-world",
  },
];
