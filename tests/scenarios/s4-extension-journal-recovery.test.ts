import { expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionLifecycleNodeCheckpoint } from "../../packages/core/src/extensions/lifecycle-node-adapter.ts";
import {
  crashS4Install,
  createS4ExtensionFixture,
  installS4Fixture,
  recoveredS4Version,
  s4TransactionArtifacts,
  useS4Lifecycle,
} from "../testkit/s4-extension-fixture.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  type FaultScheduleObservation,
} from "../testkit/verification-observations.ts";

test("S4 process-stop recovery exposes complete generations and closes publication gaps", async () => {
  const commonPoints: ReadonlyArray<ExtensionLifecycleNodeCheckpoint> = [
    "activation-after-transaction-durable",
    "activation-after-new-package-publish",
    "activation-after-state-publish",
    "activation-after-provenance-publish",
    "activation-after-approvals-publish",
    "activation-before-commit",
    "activation-after-commit",
    "cleanup-after-tombstone-publish",
  ];
  const faultSchedule: FaultScheduleObservation[] = [];
  for (const point of commonPoints) {
    const fixture = await createS4ExtensionFixture(`initial-crash-${point}`);
    await crashS4Install(fixture.profile, fixture.source, point);
    const expected = isCommittedPoint(point) ? "1.0.0" : undefined;
    expect(await recoveredS4Version(fixture.profile)).toBe(expected);
    expect(await recoveredS4Version(fixture.profile)).toBe(expected);
    expect(await s4TransactionArtifacts(fixture.profile)).toEqual([]);
    faultSchedule.push({
      boundary: "initial-install-journal",
      point,
      occurrence: 1,
      outcome: "recovered",
    });
    await rm(fixture.root, { recursive: true, force: true });
  }

  const reinstallPoints: ReadonlyArray<ExtensionLifecycleNodeCheckpoint> = [
    ...commonPoints,
    "activation-after-old-package-move",
  ];
  let preservedStateInodes = 0;
  for (const point of reinstallPoints) {
    const fixture = await createS4ExtensionFixture(`reinstall-crash-${point}`);
    expect((await installS4Fixture(fixture.profile, fixture.source, [])).status).toBe("installed");
    const mutableRoot = join(fixture.profile, ".runtime", "extensions", "fixture", "state");
    const mutableFile = join(mutableRoot, "owner.json");
    await mkdir(mutableRoot);
    await writeFile(mutableFile, "durable mutable state\n");
    const inode = (await stat(mutableFile)).ino;
    const manifestPath = join(fixture.source, "extension.json");
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf8")).replace('"version": "1.0.0"', '"version": "1.0.1"'),
    );
    await crashS4Install(fixture.profile, fixture.source, point);
    const expected = isCommittedPoint(point) ? "1.0.1" : "1.0.0";
    expect(await recoveredS4Version(fixture.profile)).toBe(expected);
    expect(await recoveredS4Version(fixture.profile)).toBe(expected);
    expect(await readFile(mutableFile, "utf8")).toBe("durable mutable state\n");
    expect((await stat(mutableFile)).ino).toBe(inode);
    expect(await s4TransactionArtifacts(fixture.profile)).toEqual([]);
    preservedStateInodes += 1;
    faultSchedule.push({
      boundary: "reinstall-journal",
      point,
      occurrence: 1,
      outcome: "recovered",
    });
    await rm(fixture.root, { recursive: true, force: true });
  }

  const publication = await createS4ExtensionFixture("publication-gap");
  expect((await installS4Fixture(publication.profile, publication.source, [])).status).toBe(
    "installed",
  );
  const publicationManifest = join(publication.source, "extension.json");
  await writeFile(
    publicationManifest,
    (await readFile(publicationManifest, "utf8")).replace(
      '"version": "1.0.0"',
      '"version": "1.0.1"',
    ),
  );
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reinstalling = installS4Fixture(publication.profile, publication.source, [], {
    nodeHooks: {
      checkpoint(point) {
        if (point !== "activation-after-package-backup") return Promise.resolve();
        reached.resolve();
        return release.promise;
      },
    },
  });
  await reached.promise;
  let listSettled = false;
  const listing = useS4Lifecycle(publication.profile, (service) => service.list()).then(
    (result) => {
      listSettled = true;
      return result;
    },
  );
  await Bun.sleep(10);
  expect(listSettled).toBeFalse();
  release.resolve();
  expect((await reinstalling).status).toBe("installed");
  expect(await listing).toEqual([
    expect.objectContaining({ id: "fixture", version: "1.0.1", health: "ready" }),
  ]);
  expect(await s4TransactionArtifacts(publication.profile)).toEqual([]);
  faultSchedule.push({
    boundary: "extension-list-index",
    point: "package-publication-gap",
    occurrence: 1,
    outcome: "continued",
  });

  emitVerificationObservation("s4.extension-journal-recovery", {
    ...emptyRuntimeObservations(),
    faultSchedule,
    metrics: [
      { name: "process-stop-checkpoints", value: commonPoints.length + reinstallPoints.length },
      { name: "idempotent-recovery-passes", value: 2 },
      { name: "preserved-state-inodes", value: preservedStateInodes },
    ],
  });
  await rm(publication.root, { recursive: true, force: true });
});

function isCommittedPoint(point: ExtensionLifecycleNodeCheckpoint): boolean {
  return point === "activation-after-commit" || point === "cleanup-after-tombstone-publish";
}
