import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NodeServiceFilesystem,
  type DefinitionExpectation,
  type Ownership,
} from "../../packages/ziggy/src/service.ts";

const temporaryDirectories: Array<string> = [];
const ownership: Ownership = {
  schemaVersion: 1,
  platform: "linux",
  profileHash: "abc123",
  identity: "dev.ziggy.profile.abc123",
};
const expectation: DefinitionExpectation = {
  ownership,
  profilePath: "/profile",
  content: `# ziggy-service-ownership:${JSON.stringify(ownership)}\n[Unit]\nDescription=Ziggy Profile abc123\n[Service]\nType=exec\nExecStart="/ziggy" "serve" "--profile" "/profile"\nRestart=on-failure\nUMask=0077\n[Install]\nWantedBy=default.target\n`,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("production service filesystem creates exclusively with restrictive permissions", async () => {
  const filesystem = new NodeServiceFilesystem();
  const root = await temporaryDirectory();
  const path = join(root, "nested", "ziggy.service");
  expect(await filesystem.classify(path, expectation)).toBe("absent");
  await filesystem.create(path, expectation.content);
  expect(await filesystem.classify(path, expectation)).toBe("current");
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  await expect(filesystem.create(path, expectation.content)).rejects.toThrow();
});

test("production service filesystem distinguishes drift, foreign files, and unsupported schemas", async () => {
  const filesystem = new NodeServiceFilesystem();
  const root = await temporaryDirectory();
  const path = join(root, "ziggy.service");
  await writeFile(path, expectation.content.replace('"/ziggy"', '"/old-ziggy"'));
  expect(await filesystem.classify(path, expectation)).toBe("owned-drifted");
  await writeFile(path, "foreign\n");
  expect(await filesystem.classify(path, expectation)).toBe("foreign");
  await writeFile(
    path,
    `# ziggy-service-ownership:${JSON.stringify({ ...ownership, schemaVersion: 2 })}\n`,
  );
  expect(await filesystem.classify(path, expectation)).toBe("unsupported");
});

test("production service filesystem refuses symlinks and atomically replaces owned files", async () => {
  const filesystem = new NodeServiceFilesystem();
  const root = await temporaryDirectory();
  const target = join(root, "target.service");
  const path = join(root, "ziggy.service");
  await writeFile(target, expectation.content);
  await symlink(target, path);
  expect(await filesystem.classify(path, expectation)).toBe("foreign");
  await rm(path);
  await writeFile(path, expectation.content.replace('"/ziggy"', '"/old-ziggy"'));
  await filesystem.replace(path, expectation.content, expectation);
  expect(await filesystem.classify(path, expectation)).toBe("current");
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  await filesystem.remove(path, expectation);
  expect(await filesystem.classify(path, expectation)).toBe("absent");
});

test("production service filesystem revalidates ownership immediately before mutation", async () => {
  const filesystem = new NodeServiceFilesystem();
  const root = await temporaryDirectory();
  const path = join(root, "ziggy.service");
  await writeFile(path, "foreign\n");
  await expect(filesystem.replace(path, expectation.content, expectation)).rejects.toThrow(
    "changed before mutation",
  );
  await expect(filesystem.remove(path, expectation)).rejects.toThrow("changed before mutation");
  expect(await filesystem.classify(path, expectation)).toBe("foreign");
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ziggy-service-filesystem-"));
  temporaryDirectories.push(path);
  return path;
}
