import { join } from "node:path";
import { scenarioRegistry } from "../../tests/scenarios/registry.ts";
import { BunProcessRunner } from "./compile-smoke.ts";
import {
  commandEvidence,
  publishEvidence,
  readAgentFindings,
  type AgentFindingEvidence,
  type CommandEvidence,
  type EvidenceInput,
  type PhaseEvidence,
  type ScenarioEvidence,
} from "./evidence.ts";
import {
  gateCommands,
  loadManifests,
  stages,
  transitiveManifests,
  validateManifestRegistry,
  type GateName,
  type Stage,
  type VerificationManifest,
} from "./manifests.ts";
import { executeScenarios } from "./scenarios.ts";
import { emptyRuntimeObservations } from "../../tests/testkit/verification-observations.ts";

const root = new URL("../..", import.meta.url).pathname;
const processRunner = new BunProcessRunner();
const gateTimeoutMs = 180_000;
const metadataTimeoutMs = 10_000;

export async function runVerification(
  target: Stage | "all",
  options: { readonly agentFindings?: ReadonlyArray<AgentFindingEvidence> } = {},
): Promise<void> {
  const startedAt = now();
  const command = target === "all" ? "bun run verify:all" : `bun run verify:${target}`;
  const runId = `${startedAt.replace(/[:.]/g, "-")}-${process.pid}`;
  const commands: CommandEvidence[] = [];
  const phases: PhaseEvidence[] = [];
  let applicable: ReadonlyArray<VerificationManifest> = [];
  let scenarioEvidence: ScenarioEvidence[] = [];
  let failure: Error | undefined;

  const preflightStarted = now();
  try {
    const manifests = await loadManifests(root);
    await validateManifestRegistry(root, manifests, scenarioRegistry);
    applicable = transitiveManifests(manifests, target === "all" ? stages : [target]);
    assertImplementedStageFindings(applicable, options.agentFindings);
    scenarioEvidence = declaredScenarios(applicable).map((scenario) => ({
      id: scenario.id,
      file: scenario.file,
      result: "not-run",
      seed: scenario.seed,
      schedule: scenario.schedule,
      boundaryConfiguration: scenario.boundaryConfiguration,
      observations: emptyRuntimeObservations(),
    }));
    phases.push(
      phase("preflight", "passed", preflightStarted, "manifest/schema/registry integrity"),
    );
  } catch (error) {
    failure = toError(error);
    phases.push(phase("preflight", "failed", preflightStarted, failure.message));
  }

  const gateStarted = now();
  let scenarioPhaseResult: PhaseEvidence["result"] = "not-run";
  let scenarioDiagnostic = "scenario gate not reached";
  if (failure === undefined) {
    const gates = declaredGates(applicable);
    for (const gate of gates) {
      try {
        if (gate === "scenarios") {
          const scenarioStarted = now();
          const declarations = declaredScenarios(applicable);
          const executions = await executeScenarios(root, declarations, processRunner);
          scenarioEvidence = executions.map((execution) => ({
            id: execution.id,
            file: execution.file,
            result: execution.result,
            seed: execution.seed,
            schedule: execution.schedule,
            boundaryConfiguration: execution.boundaryConfiguration,
            observations: execution.observations,
          }));
          for (const execution of executions) {
            commands.push(
              commandEvidence(["bun", "test", execution.file], execution.process, root),
            );
          }
          const failedScenario = executions.find((execution) => execution.result === "failed");
          if (failedScenario === undefined) {
            scenarioPhaseResult = "passed";
            scenarioDiagnostic = `${executions.length} declared scenarios passed`;
          } else {
            scenarioPhaseResult = "failed";
            scenarioDiagnostic = `scenario failed: ${failedScenario.id}`;
            failure = new Error(scenarioDiagnostic);
          }
          phases.push(phase("scenario", scenarioPhaseResult, scenarioStarted, scenarioDiagnostic));
        } else {
          const result = await executeGate(gate);
          commands.push(result.evidence);
          if (result.failed) {
            failure = new Error(`verification gate failed: ${gate}`);
          }
        }
      } catch (error) {
        failure = toError(error);
        if (gate === "scenarios") {
          scenarioPhaseResult = "failed";
          scenarioDiagnostic = failure.message;
        }
      }
      if (failure !== undefined) {
        break;
      }
    }
  }
  phases.push(
    phase(
      "gate",
      failure === undefined ? "passed" : "failed",
      gateStarted,
      failure === undefined ? "all declared gates passed" : failure.message,
    ),
  );
  if (!phases.some((item) => item.name === "scenario")) {
    phases.push(phase("scenario", scenarioPhaseResult, gateStarted, scenarioDiagnostic));
  }

  const publicationStarted = now();
  phases.push(
    phase("publication", "passed", publicationStarted, "atomic schema-valid redacted publication"),
  );
  const git = await readGitState();
  const evidenceInput: EvidenceInput = {
    runId,
    stage: target,
    command,
    scenarios: scenarioEvidence,
    startedAt,
    finishedAt: now(),
    gitRevision: git.revision,
    gitDirty: git.dirty,
    toolVersions: await readToolVersions(),
    phases: [...phases].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    commands,
    ...(options.agentFindings === undefined ? {} : { agentFindings: options.agentFindings }),
    result: failure === undefined ? "passed" : "failed",
  };

  let published;
  try {
    published = await publishEvidence(root, evidenceInput);
  } catch (publicationError) {
    const publicationFailure = toError(publicationError);
    throw new Error(`evidence publication failed: ${publicationFailure.message}`, {
      cause: publicationFailure,
    });
  }

  for (const line of manifestStatusLines(applicable)) {
    console.log(line);
  }
  console.log(`evidence: <repo>/${relativeArtifactPath(published.directory)}`);
  if (failure !== undefined) {
    throw failure;
  }
}

export function assertImplementedStageFindings(
  manifests: ReadonlyArray<VerificationManifest>,
  findings: ReadonlyArray<AgentFindingEvidence> | undefined,
): void {
  const closesS3 = manifests.some(
    (manifest) => manifest.stage === "s3" && manifest.status === "implemented",
  );
  if (!closesS3) return;
  if (findings === undefined || findings.length === 0) {
    throw new Error("implemented S3 verification requires attached independent agent findings");
  }
  const ids = new Set<string>();
  for (const finding of findings) {
    if (ids.has(finding.id)) {
      throw new Error(`implemented S3 verification requires unique finding IDs: ${finding.id}`);
    }
    ids.add(finding.id);
    if (finding.role !== "review") {
      throw new Error("implemented S3 verification requires independent review findings only");
    }
    if (finding.disposition.status !== "fixed" && finding.disposition.status !== "accepted") {
      throw new Error(
        "implemented S3 verification requires every finding disposition to be fixed or accepted",
      );
    }
  }
}

export function declaredGates(
  manifests: ReadonlyArray<VerificationManifest>,
): ReadonlyArray<GateName> {
  const seen = new Set<GateName>();
  const gates: GateName[] = [];
  for (const manifest of manifests) {
    for (const gate of manifest.gates) {
      if (!seen.has(gate)) {
        seen.add(gate);
        gates.push(gate);
      }
    }
  }
  return gates;
}

export function manifestStatusLines(
  manifests: ReadonlyArray<VerificationManifest>,
): ReadonlyArray<string> {
  return manifests.flatMap((manifest) => {
    if (manifest.status === "manifest-empty") {
      return [`${manifest.stage}: manifest-empty (not implemented; no behavior claimed)`];
    }
    return manifest.status === "pending"
      ? [`${manifest.stage}: pending (stage closure is not claimed)`]
      : [];
  });
}

function declaredScenarios(manifests: ReadonlyArray<VerificationManifest>) {
  const ids = new Set(manifests.flatMap((manifest) => manifest.scenarios));
  return scenarioRegistry.filter((scenario) => ids.has(scenario.id));
}

async function executeGate(
  gate: Exclude<GateName, "scenarios">,
): Promise<{ evidence: CommandEvidence; failed: boolean }> {
  if (gate === "manifest-integrity") {
    const argv = ["internal", "manifest-integrity"];
    const result = {
      exitCode: 0,
      stdout: "manifest, schema, registry, and predecessor integrity: ok\n",
      stderr: "",
      timedOut: false,
    };
    return { evidence: commandEvidence(argv, result, root), failed: false };
  }
  const argv = gateCommands[gate];
  if (argv === null) {
    throw new Error(`gate ${gate} has no command dispatcher`);
  }
  const result = await processRunner.run({ argv, cwd: root, timeoutMs: gateTimeoutMs });
  return {
    evidence: commandEvidence(argv, result, root),
    failed: result.exitCode !== 0 || result.timedOut,
  };
}

async function readGitState(): Promise<{ revision: string | null; dirty: boolean }> {
  const revisionResult = await processRunner.run({
    argv: ["git", "rev-parse", "HEAD"],
    cwd: root,
    timeoutMs: metadataTimeoutMs,
  });
  const statusResult = await processRunner.run({
    argv: ["git", "status", "--porcelain"],
    cwd: root,
    timeoutMs: metadataTimeoutMs,
  });
  return {
    revision:
      revisionResult.exitCode === 0 && !revisionResult.timedOut
        ? revisionResult.stdout.trim()
        : null,
    dirty:
      statusResult.exitCode !== 0 || statusResult.timedOut || statusResult.stdout.trim().length > 0,
  };
}

async function readToolVersions(): Promise<Readonly<Record<string, string>>> {
  const packageJson = JSON.parse(await Bun.file(join(root, "package.json")).text());
  if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
    throw new Error("root package.json must be an object");
  }
  const rootManifest = Object.fromEntries(Object.entries(packageJson));
  const development = rootManifest.devDependencies;
  if (typeof development !== "object" || development === null || Array.isArray(development)) {
    throw new Error("root devDependencies must be an object");
  }
  const dependencyRecord = Object.fromEntries(Object.entries(development));
  const versions: Record<string, string> = { bun: Bun.version };
  for (const name of ["ajv", "typescript", "oxc-parser", "oxlint", "oxfmt", "knip"]) {
    const value = dependencyRecord[name];
    if (typeof value !== "string") {
      throw new Error(`missing tool version for ${name}`);
    }
    versions[name] = value;
  }
  return versions;
}

function phase(
  name: PhaseEvidence["name"],
  result: PhaseEvidence["result"],
  startedAt: string,
  diagnostic: string,
): PhaseEvidence {
  return { name, result, startedAt, finishedAt: now(), diagnostic };
}

function relativeArtifactPath(directory: string): string {
  const marker = ".artifacts/";
  const index = directory.indexOf(marker);
  if (index < 0) {
    throw new Error("published evidence path is outside .artifacts");
  }
  return directory.slice(index);
}

function now(): string {
  return new Date().toISOString();
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("verification failed");
}

function parseTarget(value: string | undefined): Stage | "all" {
  if (value === "all") {
    return value;
  }
  for (const stage of stages) {
    if (value === stage) {
      return stage;
    }
  }
  throw new Error(usage());
}

function parseArguments(argv: ReadonlyArray<string>): {
  readonly target: Stage | "all";
  readonly agentFindingsPath: string | undefined;
} {
  if (argv.length === 1) {
    return { target: parseTarget(argv[0]), agentFindingsPath: undefined };
  }
  if (argv.length === 3 && argv[1] === "--agent-findings") {
    const path = argv[2];
    if (path === undefined || path.length === 0) {
      throw new Error(usage());
    }
    return { target: parseTarget(argv[0]), agentFindingsPath: path };
  }
  throw new Error(usage());
}

function usage(): string {
  return "usage: bun tooling/verification/runner.ts <s0|s1|...|s7|all> [--agent-findings <untracked-json-path>]";
}

if (import.meta.main) {
  try {
    const arguments_ = parseArguments(Bun.argv.slice(2));
    const agentFindings =
      arguments_.agentFindingsPath === undefined
        ? undefined
        : await readAgentFindings(root, arguments_.agentFindingsPath);
    await runVerification(arguments_.target, agentFindings === undefined ? {} : { agentFindings });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "verification failed");
    process.exit(1);
  }
}
