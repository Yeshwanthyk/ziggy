import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeExtensionApprovalsJson,
  decodeExtensionProvenanceJson,
  ExtensionToolLoadError,
  loadInstalledExtensionTools,
  sha256,
} from "../../packages/core/src/index.ts";
import { Effect } from "effect";
import {
  collectProcess,
  runProcess,
  spawnProcess,
  waitForFile,
} from "../testkit/compiled-process.ts";
import {
  createS4ExtensionFixture,
  installS4Fixture,
  requireApprovalRequirements,
  useS4Lifecycle,
} from "../testkit/s4-extension-fixture.ts";
import { runEffect, runScopedEffect } from "../testkit/effect.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
} from "../testkit/verification-observations.ts";

const repositoryRoot = join(import.meta.dir, "..", "..");

test("compiled Ziggy loads an approved post-build TypeScript Tool from sealed snapshot bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-s4-tool-compiled-"));
  const executable = join(root, "ziggy");
  const profile = join(root, "profile");
  const marker = join(root, "tool-imported.txt");
  try {
    const boundaryMarker = join(root, "boundary-imported.txt");
    const boundary = await createS4ExtensionFixture("tool-boundary", {
      skills: [],
      tools: [{ id: "fixture", path: "tools/fixture" }],
      files: {
        "tools/fixture/dependency.ts": `export const value = "sealed-boundary";\n`,
        "tools/fixture/tool.ts": `
import { value } from "./dependency.ts";
await Bun.write(${JSON.stringify(boundaryMarker)}, value);
export default {
  name: "fixture",
  description: "Boundary Tool",
  inputSchema: { type: "object", additionalProperties: false },
  async execute() { return { value }; },
};
`,
      },
    });
    const boundaryRequirements = requireApprovalRequirements(
      await installS4Fixture(boundary.profile, boundary.source, []),
    );
    expect(await Bun.file(boundaryMarker).exists()).toBeFalse();
    const sourceEntry = await readFile(join(boundary.source, "tools", "fixture", "tool.ts"));
    const sourceDependency = await readFile(
      join(boundary.source, "tools", "fixture", "dependency.ts"),
    );
    expect(boundaryRequirements[0]?.executableSha256).toBe(sha256(sourceEntry));
    const boundaryFingerprints = boundaryRequirements.map((requirement) => requirement.fingerprint);
    await installS4Fixture(boundary.profile, boundary.source, boundaryFingerprints);
    await useS4Lifecycle(boundary.profile, (service) =>
      service.enable({ extensionId: "fixture", approvals: boundaryFingerprints }),
    );
    const provenance = await runEffect(
      decodeExtensionProvenanceJson(
        await readFile(
          join(boundary.profile, ".runtime", "extensions", "fixture", "provenance.json"),
          "utf8",
        ),
      ),
    );
    expect(
      provenance.files.find((file) => file.path === "tools/fixture/dependency.ts")?.sha256,
    ).toBe(sha256(sourceDependency));
    expect(
      await runScopedEffect(loadInstalledExtensionTools(boundary.profile, "0.0.0")),
    ).toHaveLength(1);
    expect(await readFile(boundaryMarker, "utf8")).toBe("sealed-boundary");

    let mutationImporterCalls = 0;
    await expect(
      runScopedEffect(
        loadInstalledExtensionTools(boundary.profile, "0.0.0", {
          beforeFinalLiveSealCheck: () =>
            Effect.tryPromise({
              try: () =>
                writeFile(
                  join(
                    boundary.profile,
                    "extensions",
                    "fixture",
                    "tools",
                    "fixture",
                    "dependency.ts",
                  ),
                  `export const value = "mutated";\n`,
                ),
              catch: (cause) =>
                new ExtensionToolLoadError({ message: "scenario mutation failed", cause }),
            }),
          importModule: () => {
            mutationImporterCalls += 1;
            return Effect.succeed({});
          },
        }),
      ),
    ).rejects.toThrow("invalidated");
    expect(mutationImporterCalls).toBe(0);
    const invalidated = await runEffect(
      decodeExtensionApprovalsJson(
        await readFile(
          join(boundary.profile, ".runtime", "extensions", "fixture", "approvals.json"),
          "utf8",
        ),
      ),
    );
    expect(invalidated).toMatchObject({ epoch: 1, invalidated: true, approvals: [] });

    const escape = await createS4ExtensionFixture("tool-import-escape", {
      skills: [],
      tools: [{ id: "fixture", path: "tools/fixture" }],
      files: {
        "tools/fixture/tool.ts": `
import "../outside.ts";
export default {
  name: "fixture",
  description: "Escaping Tool",
  inputSchema: { type: "object", additionalProperties: false },
  async execute() { return {}; },
};
`,
      },
    });
    const escapeRequirements = requireApprovalRequirements(
      await installS4Fixture(escape.profile, escape.source, []),
    );
    const escapeFingerprints = escapeRequirements.map((requirement) => requirement.fingerprint);
    await installS4Fixture(escape.profile, escape.source, escapeFingerprints);
    await useS4Lifecycle(escape.profile, (service) =>
      service.enable({ extensionId: "fixture", approvals: escapeFingerprints }),
    );
    let escapingImporterCalls = 0;
    await expect(
      runScopedEffect(
        loadInstalledExtensionTools(escape.profile, "0.0.0", {
          importModule: () => {
            escapingImporterCalls += 1;
            return Effect.succeed({});
          },
        }),
      ),
    ).rejects.toThrow("escaping import-statement");
    expect(escapingImporterCalls).toBe(0);

    const compiled = await runProcess(
      ["bun", "build", "--compile", "packages/ziggy/src/main.ts", "--outfile", executable],
      { cwd: repositoryRoot, timeoutMs: 120_000 },
    );
    expect(compiled).toMatchObject({ exitCode: 0 });
    const initialized = await runProcess([executable, "init", profile, "--voice", "operator"], {
      cwd: repositoryRoot,
      timeoutMs: 20_000,
    });
    expect(initialized).toMatchObject({ exitCode: 0 });

    const fixture = await createS4ExtensionFixture("compiled-tool", {
      skills: [],
      tools: [{ id: "fixture", path: "tools/fixture" }],
      files: {
        "tools/fixture/dependency.ts": `export const value = "post-build-sealed";\n`,
        "tools/fixture/nested/helper.ts": `
import { value } from "../dependency.ts";
export { value };
`,
        "tools/fixture/tool.ts": `
import { value } from "./nested/helper.ts";
await Bun.write(${JSON.stringify(marker)}, value);
export default {
  name: "fixture",
  description: "Compiled post-build Tool",
  inputSchema: { type: "object", additionalProperties: false },
  async execute() { return { value }; },
};
`,
      },
    });
    const requirements = requireApprovalRequirements(
      await installS4Fixture(profile, fixture.source, []),
    );
    const fingerprints = requirements.map((requirement) => requirement.fingerprint);
    await installS4Fixture(profile, fixture.source, fingerprints);
    await useS4Lifecycle(profile, (service) =>
      service.enable({ extensionId: "fixture", approvals: fingerprints }),
    );

    const daemon = spawnProcess([executable, "serve", "--profile", profile], {
      cwd: repositoryRoot,
      env: {},
    });
    const markerContents = await waitForFile(
      marker,
      (contents) => contents === "post-build-sealed",
    );
    daemon.kill("SIGINT");
    const stopped = await collectProcess(daemon);
    expect(stopped.exitCode).toBe(130);
    expect(markerContents).toBe("post-build-sealed");
    expect(await readFile(marker, "utf8")).toBe("post-build-sealed");

    emitVerificationObservation("s4.extension-tool-boundary", {
      ...emptyRuntimeObservations(),
      faultSchedule: [
        {
          boundary: "extension-tool-import",
          point: "before-exact-approval",
          occurrence: 1,
          outcome: "failed",
        },
        {
          boundary: "extension-tool-import",
          point: "exact-approval-and-sealed-snapshot",
          occurrence: 1,
          outcome: "continued",
        },
        {
          boundary: "extension-tool-import",
          point: "mutation-before-final-live-seal-check",
          occurrence: 1,
          outcome: "failed",
        },
        {
          boundary: "extension-tool-import",
          point: "sealed-relative-import-escape",
          occurrence: 1,
          outcome: "failed",
        },
        {
          boundary: "extension-tool-import",
          point: "compiled-post-build-typescript",
          occurrence: 1,
          outcome: "continued",
        },
      ],
      filesystemDiffs: [
        {
          path: "tools/fixture/tool.ts",
          change: "unchanged",
          beforeDigest: sha256(sourceEntry),
          afterDigest: boundaryRequirements[0]?.executableSha256 ?? null,
        },
        {
          path: "tools/fixture/dependency.ts",
          change: "unchanged",
          beforeDigest: sha256(sourceDependency),
          afterDigest:
            provenance.files.find((file) => file.path === "tools/fixture/dependency.ts")?.sha256 ??
            null,
        },
        {
          path: "tool-imported.txt",
          change: "created",
          beforeDigest: fixtureDigest(""),
          afterDigest: fixtureDigest(markerContents),
        },
      ],
      metrics: [
        { name: "preapproval-imports", value: 0 },
        { name: "mutation-cutpoint-imports", value: mutationImporterCalls },
        { name: "escaping-imports", value: escapingImporterCalls },
        { name: "sealed-file-digests-matched", value: 2 },
        { name: "provider-calls", value: 0 },
        { name: "approved-tool-imports", value: 1 },
      ],
    });
    await rm(boundary.root, { recursive: true, force: true });
    await rm(escape.root, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
