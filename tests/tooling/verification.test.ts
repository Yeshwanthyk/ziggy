import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyRuntimeObservations } from "../testkit/verification-observations.ts";
import {
  assertNoLeaks,
  commandEvidence,
  digest,
  publishEvidence,
  redactString,
  redactValue,
  validateReplay,
  type EvidenceInput,
} from "../../tooling/verification/evidence.ts";

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("verification evidence", () => {
  test("redacts structured argv, credential families, auth forms, and private paths with scanner parity", () => {
    const root = "/Users/fixture-owner/code/ziggy";
    const markers = [
      "fixture-following-value",
      "fixture-equals-value",
      "fixture-header-value",
      "fixture-query-value",
      "fixture-json-value",
      "fixture-env-value",
      "fixture-cookie-value",
      "fixture-token-file-value",
    ];
    const evidence = commandEvidence(
      [
        "fixture",
        "--database-password",
        markers[0] ?? "missing",
        `--service_api_token=${markers[1]}`,
        "--header",
        `Authorization: Bearer ${markers[2]}`,
        `https://fixture.test/?client_secret=${markers[3]}&safe=yes`,
        `{"nested":{"github-token":"${markers[4]}"}}`,
        `MY_APP_CREDENTIAL=${markers[5]}`,
        "--github-token-file",
        markers[7] ?? "missing",
      ],
      {
        exitCode: 0,
        stdout: [
          `Proxy-Authorization: Basic ${markers[2]}`,
          `Set-Cookie: sid=${markers[6]}`,
          `Profile path: /Users/fixture-owner/private/Profile`,
          `/private/tmp/ziggy-fixture/output`,
          `${root}/Profile`,
        ].join("\n"),
        stderr: "",
        timedOut: false,
      },
      root,
    );
    const redacted = JSON.stringify(
      redactValue({ "service-access_token": "fixture-object-value", evidence }, root),
    );
    for (const marker of [...markers, "fixture-object-value", root, "/private/tmp/"]) {
      expect(redacted).not.toContain(marker);
    }
    expect(evidence.argv[2]).toStartWith("<redacted:");
    expect(evidence.argv[3]).toContain("=<redacted:");
    expect(evidence.argv[10]).toStartWith("<redacted:");
    expect(() => assertNoLeaks(redacted, root)).not.toThrow();

    for (const leak of [
      "--team_refresh-token=fixture-leak",
      "Authorization: Bearer fixture-leak",
      '{"x_api_key":"fixture-leak"}',
      "https://fixture.test/?account-password=fixture-leak",
      "Profile path: /opt/private/Profile",
      "/tmp/ziggy-fixture/output",
    ]) {
      expect(() => assertNoLeaks(leak, root)).toThrow("leak");
      expect(() => assertNoLeaks(redactString(leak, root), root)).not.toThrow();
    }
  });

  test("keeps only bounded redacted output diagnostics with recomputable digests", () => {
    const output = commandEvidence(
      ["fixture"],
      {
        exitCode: 0,
        stdout: `token=fixture-output-value ${"x".repeat(9_000)}`,
        stderr: "",
        timedOut: false,
      },
      "/fixture/repo",
    ).stdout;
    expect(output.diagnostic).toHaveLength(8_192);
    expect(output.diagnosticDigest).toBe(digest(output.diagnostic));
    expect(output.truncated).toBe(true);
    expect(JSON.stringify(output)).not.toContain("fixture-output-value");
    expect(Object.keys(output).sort()).toEqual(["diagnostic", "diagnosticDigest", "truncated"]);
  });

  test("publishes atomically, stores bounded redacted diagnostics, and validates current replay inputs", async () => {
    const root = await temporaryRoot();
    const input = evidenceInput(root);
    const published = await publishEvidence(root, input);
    await expect(validateReplay(published.directory, root)).resolves.toBeUndefined();

    const summary = await Bun.file(join(published.directory, "summary.json")).text();
    expect(summary).not.toContain(root);
    expect(summary).not.toContain("fixture-secret");
    expect(summary).not.toContain('"stdout": "');
    expect(summary).toContain('"diagnostic"');
    expect(summary).not.toContain('"bytes"');
    expect(summary).not.toContain('"digest"');
    const result = await Bun.file(join(published.directory, "result.json")).text();
    expect(result).toContain('"canonicalEventTrace"');
    expect(result).toContain('"agentFindings"');

    await expect(publishEvidence(root, input)).rejects.toThrow("already exists");
    const siblings = await readdir(join(root, ".artifacts/verification"));
    expect(siblings.some((name) => name.includes(".tmp-"))).toBe(false);
  });

  test("retains redacted structured observations and agent finding dispositions", async () => {
    const root = await temporaryRoot();
    const input = evidenceInput(root);
    const published = await publishEvidence(root, {
      ...input,
      scenarios: input.scenarios.map((scenario) => ({
        ...scenario,
        observations: {
          ...emptyRuntimeObservations(),
          canonicalEventTrace: [
            {
              schemaVersion: 1,
              seq: 1,
              emittedAt: "2026-07-19T00:00:00.000Z",
              eventType: "turn-started",
              sessionId: "fixture-session",
            },
          ],
          providerInputs: [
            {
              callIndex: 0,
              sessionId: "fixture-session",
              cacheRetention: "long",
              provider: "scripted",
              model: "scripted-model",
              systemPromptCodePoints: 42,
              messageRoles: ["user"],
              toolNames: ["memory"],
            },
          ],
          faultSchedule: [
            {
              boundary: "Memory-batch",
              point: "afterPrepare",
              occurrence: 1,
              outcome: "recovered",
            },
          ],
          filesystemDiffs: [
            {
              path: "memory/MEMORY.md",
              change: "modified",
              beforeDigest: digest("before"),
              afterDigest: digest("after"),
            },
          ],
        },
      })),
      agentFindings: [
        {
          id: "review.fixture",
          role: "review",
          severity: "warning",
          summary: "Authorization: Bearer fixture-review-secret",
          disposition: {
            status: "fixed",
            rationale: "Covered by deterministic replay.",
            regressionScenarioId: "s0.fixture",
          },
        },
      ],
    });
    const result = await Bun.file(join(published.directory, "result.json")).text();
    expect(result).toContain('"afterPrepare"');
    expect(result).toContain('"status": "fixed"');
    expect(result).not.toContain("fixture-review-secret");
    await expect(validateReplay(published.directory, root)).resolves.toBeUndefined();
  });

  test("schema validation rejects invalid dates, fractional exits, numeric argv, duplicates, and extras", async () => {
    const root = await temporaryRoot();
    const published = await publishEvidence(root, evidenceInput(root));
    const summaryPath = join(published.directory, "summary.json");
    const resultPath = join(published.directory, "result.json");

    for (const mutate of [
      (value: Record<string, unknown>) => ({ ...value, startedAt: "not-a-date" }),
      (value: Record<string, unknown>) => mutateFirstCommand(value, { exitCode: 0.5 }),
      (value: Record<string, unknown>) => mutateFirstCommand(value, { argv: [123] }),
      (value: Record<string, unknown>) =>
        mutateFirstOutput(value, { digest: digest("raw-output"), bytes: 1 }),
      (value: Record<string, unknown>) => ({ ...value, extra: true }),
    ]) {
      const original = parseRecord(await Bun.file(summaryPath).text());
      await Bun.write(summaryPath, `${JSON.stringify(mutate(original), null, 2)}\n`);
      await expect(validateReplay(published.directory, root)).rejects.toThrow("schema validation");
      await Bun.write(summaryPath, `${JSON.stringify(original, null, 2)}\n`);
    }

    const result = parseRecord(await Bun.file(resultPath).text());
    const scenarios = result.scenarios;
    if (!Array.isArray(scenarios) || scenarios[0] === undefined) {
      throw new Error("missing result scenario fixture");
    }
    await Bun.write(
      resultPath,
      `${JSON.stringify({ ...result, scenarios: [scenarios[0], scenarios[0]] }, null, 2)}\n`,
    );
    await expect(validateReplay(published.directory, root)).rejects.toThrow("duplicate");
  });

  test("summary, diagnostic, result, and workspace hash tampering fail coherently", async () => {
    const root = await temporaryRoot();
    const published = await publishEvidence(root, evidenceInput(root));
    const summaryPath = join(published.directory, "summary.json");
    const resultPath = join(published.directory, "result.json");
    const replayPath = join(published.directory, "replay.json");
    const originalSummary = await Bun.file(summaryPath).text();
    const originalResult = await Bun.file(resultPath).text();
    const originalReplay = await Bun.file(replayPath).text();

    const changedSummary = jsonText(
      mutateFirstOutput(parseRecord(originalSummary), { diagnostic: "changed" }),
    );
    await Bun.write(summaryPath, changedSummary);
    await expect(validateReplay(published.directory, root)).rejects.toThrow(
      "summary digest mismatch",
    );

    await rewriteReplayDigest(replayPath, "summaryDigest", changedSummary);
    await expect(validateReplay(published.directory, root)).rejects.toThrow(
      "diagnostic digest mismatch",
    );
    await Bun.write(summaryPath, originalSummary);
    await Bun.write(replayPath, originalReplay);

    await Bun.write(resultPath, originalResult.replace('"result": "passed"', '"result": "failed"'));
    await expect(validateReplay(published.directory, root)).rejects.toThrow(
      "result digest mismatch",
    );
    await Bun.write(resultPath, originalResult);

    const inputPath = join(root, "package.json");
    const originalInput = await Bun.file(inputPath).text();
    await Bun.write(inputPath, `${originalInput}\n`);
    await expect(validateReplay(published.directory, root)).rejects.toThrow(
      "workspace input digest",
    );
    await Bun.write(inputPath, originalInput);
  });

  test("cross-validates replay command, exact scenarios, and aggregate results", async () => {
    const root = await temporaryRoot();
    const published = await publishEvidence(root, evidenceInput(root));
    const summaryPath = join(published.directory, "summary.json");
    const resultPath = join(published.directory, "result.json");
    const replayPath = join(published.directory, "replay.json");
    const originalSummary = await Bun.file(summaryPath).text();
    const originalResult = await Bun.file(resultPath).text();
    const originalReplay = await Bun.file(replayPath).text();

    const replay = parseRecord(originalReplay);
    await Bun.write(replayPath, jsonText({ ...replay, command: "bun run verify:other" }));
    await expect(validateReplay(published.directory, root)).rejects.toThrow("command mismatch");
    await Bun.write(replayPath, originalReplay);

    const result = parseRecord(originalResult);
    const resultScenarios = requireArray(result.scenarios, "result scenarios");
    const firstScenario = parseRecord(JSON.stringify(resultScenarios[0]));
    await Bun.write(
      resultPath,
      jsonText({ ...result, scenarios: [{ ...firstScenario, id: "s0.other" }] }),
    );
    await rewriteReplayDigest(replayPath, "resultDigest", await Bun.file(resultPath).text());
    await expect(validateReplay(published.directory, root)).rejects.toThrow("scenario mismatch");
    await Bun.write(resultPath, originalResult);
    await Bun.write(replayPath, originalReplay);

    const aggregateMutations = [
      (summary: Record<string, unknown>) => mutateFirstCommand(summary, { exitCode: 1 }),
      (summary: Record<string, unknown>) => mutateFirstPhase(summary, { result: "failed" }),
      (summary: Record<string, unknown>) => ({ ...summary, result: "failed" }),
    ];
    for (const mutate of aggregateMutations) {
      const changed = jsonText(mutate(parseRecord(originalSummary)));
      await Bun.write(summaryPath, changed);
      await rewriteReplayDigest(replayPath, "summaryDigest", changed);
      await expect(validateReplay(published.directory, root)).rejects.toThrow("aggregate result");
      await Bun.write(summaryPath, originalSummary);
      await Bun.write(replayPath, originalReplay);
    }

    const failedResult = jsonText({
      ...result,
      scenarios: [{ ...firstScenario, result: "failed" }],
    });
    await Bun.write(resultPath, failedResult);
    await rewriteReplayDigest(replayPath, "resultDigest", failedResult);
    await expect(validateReplay(published.directory, root)).rejects.toThrow("aggregate result");
  });

  test("rejects inverted, out-of-run, and unordered timestamps", async () => {
    const root = await temporaryRoot();
    const cases: ReadonlyArray<(input: EvidenceInput) => EvidenceInput> = [
      (input) => ({ ...input, startedAt: "2026-07-19T00:00:02.000Z" }),
      (input) => replaceFirstPhase(input, { startedAt: "2026-07-18T23:59:59.000Z" }),
      reverseFirstTwoPhases,
    ];
    for (const mutate of cases) {
      await expect(publishEvidence(root, mutate(evidenceInput(root)))).rejects.toThrow("timestamp");
    }
  });

  test("rejects symlinks in workspace and bundle replay inputs", async () => {
    const root = await temporaryRoot();
    await symlink("package.json", join(root, "linked-package.json"));
    await expect(publishEvidence(root, evidenceInput(root))).rejects.toThrow("symlink rejected");
    await rm(join(root, "linked-package.json"));

    const published = await publishEvidence(root, evidenceInput(root));
    const summaryPath = join(published.directory, "summary.json");
    const storedSummaryPath = join(published.directory, "stored-summary.json");
    await rename(summaryPath, storedSummaryPath);
    await symlink("stored-summary.json", summaryPath);
    await expect(validateReplay(published.directory, root)).rejects.toThrow("symlink");
  });

  test("redaction/schema failure writes no raw secret or temporary artifact", async () => {
    const root = await temporaryRoot();
    const invalid = { ...evidenceInput(root), startedAt: "invalid-date" };
    await expect(publishEvidence(root, invalid)).rejects.toThrow("schema validation");
    expect(await Bun.file(join(root, ".artifacts")).exists()).toBe(false);
  });

  test("redaction handles standalone encoded diagnostics", () => {
    const diagnostic = redactString(
      '{"Authorization":"Bearer private","query":"?access_token=private"}',
      "/fixture/repo",
    );
    expect(diagnostic).not.toContain("private");
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ziggy-verification-test-"));
  temporaryDirectories.push(directory);
  await cp(join(repositoryRoot, "verification/schemas"), join(directory, "verification/schemas"), {
    recursive: true,
  });
  await Bun.write(join(directory, "package.json"), '{"fixture":true}\n');
  await Bun.write(join(directory, "bun.lock"), "fixture-lock\n");
  return directory;
}

function evidenceInput(root: string): EvidenceInput {
  const processResult = {
    exitCode: 0,
    stdout: `token=fixture-secret ${root}/Profile`,
    stderr: "",
    timedOut: false,
  };
  return {
    runId: "fixture-run",
    stage: "s0",
    command: "bun run verify:s0",
    scenarios: [
      {
        id: "s0.fixture",
        file: "tests/fixture.test.ts",
        result: "passed",
        seed: "fixture-seed",
        schedule: "fixture-schedule",
        boundaryConfiguration: "fixture-boundaries",
        observations: emptyRuntimeObservations(),
      },
    ],
    startedAt: "2026-07-19T00:00:00.000Z",
    finishedAt: "2026-07-19T00:00:01.000Z",
    gitRevision: null,
    gitDirty: true,
    toolVersions: { bun: "1.3.13" },
    phases: [
      {
        name: "preflight",
        result: "passed",
        startedAt: "2026-07-19T00:00:00.000Z",
        finishedAt: "2026-07-19T00:00:00.100Z",
        diagnostic: "ok",
      },
      {
        name: "gate",
        result: "passed",
        startedAt: "2026-07-19T00:00:00.100Z",
        finishedAt: "2026-07-19T00:00:00.800Z",
        diagnostic: "ok",
      },
      {
        name: "scenario",
        result: "passed",
        startedAt: "2026-07-19T00:00:00.200Z",
        finishedAt: "2026-07-19T00:00:00.700Z",
        diagnostic: "ok",
      },
      {
        name: "publication",
        result: "passed",
        startedAt: "2026-07-19T00:00:00.800Z",
        finishedAt: "2026-07-19T00:00:01.000Z",
        diagnostic: "ok",
      },
    ],
    commands: [commandEvidence(["fixture"], processResult, root)],
    result: "passed",
  };
}

function parseRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fixture must be an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function mutateFirstCommand(
  value: Record<string, unknown>,
  replacement: Record<string, unknown>,
): Record<string, unknown> {
  const commands = requireArray(value.commands, "commands");
  const command = parseRecord(JSON.stringify(commands[0]));
  return { ...value, commands: [{ ...command, ...replacement }, ...commands.slice(1)] };
}

function mutateFirstOutput(
  value: Record<string, unknown>,
  replacement: Record<string, unknown>,
): Record<string, unknown> {
  const commands = requireArray(value.commands, "commands");
  const command = parseRecord(JSON.stringify(commands[0]));
  const stdout = parseRecord(JSON.stringify(command.stdout));
  return {
    ...value,
    commands: [{ ...command, stdout: { ...stdout, ...replacement } }, ...commands.slice(1)],
  };
}

function mutateFirstPhase(
  value: Record<string, unknown>,
  replacement: Record<string, unknown>,
): Record<string, unknown> {
  const phases = requireArray(value.phases, "phases");
  const phase = parseRecord(JSON.stringify(phases[0]));
  return { ...value, phases: [{ ...phase, ...replacement }, ...phases.slice(1)] };
}

function replaceFirstPhase(
  input: EvidenceInput,
  replacement: Partial<EvidenceInput["phases"][number]>,
): EvidenceInput {
  const first = input.phases[0];
  if (first === undefined) {
    throw new Error("missing phase fixture");
  }
  return { ...input, phases: [{ ...first, ...replacement }, ...input.phases.slice(1)] };
}

function reverseFirstTwoPhases(input: EvidenceInput): EvidenceInput {
  const first = input.phases[0];
  const second = input.phases[1];
  if (first === undefined || second === undefined) {
    throw new Error("missing phase fixtures");
  }
  return { ...input, phases: [second, first, ...input.phases.slice(2)] };
}

async function rewriteReplayDigest(
  replayPath: string,
  field: "summaryDigest" | "resultDigest",
  content: string,
): Promise<void> {
  const replay = parseRecord(await Bun.file(replayPath).text());
  await Bun.write(replayPath, jsonText({ ...replay, [field]: digest(content) }));
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value[0] === undefined) {
    throw new Error(`missing ${label} fixture`);
  }
  return value;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
