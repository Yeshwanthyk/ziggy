/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute application Effects. */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Fixture owns a temporary Profile. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { BUILTIN_EXTENSION_CATALOG } from "ziggy/catalog";
import { refreshRequiredExtensions } from "ziggy/application/extension-update";
import { makeExtensionUpdateStore } from "ziggy/adapters/fs/extension-update";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("required copies refresh only when their receipt still matches on-disk bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-required-refresh-"));
  roots.push(root);
  const target = { name: "fixture", path: root };
  const id = "ziggy-operations";
  const entry = BUILTIN_EXTENSION_CATALOG.extensions.find((item) => item.id === id);
  const directory = join(root, "extensions", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: id, version: "0.0.1" }));
  const store = makeExtensionUpdateStore(root, id);
  await Effect.runPromise(store.prepare());
  await Effect.runPromise(
    store.adoptCurrent(await Effect.runPromise(store.hash(directory)), "older"),
  );
  const calls: string[] = [];

  const update = (_target: typeof target, selected: string) =>
    Effect.sync(() => {
      calls.push(selected);

      return {
        id: selected,
        profilePath: root,
        status: "updated" as const,
        previousHash: "old",
        contentHash: "new",
        adoptedUnknownOrigin: false,
      };
    });

  expect(entry?.version).not.toBe("older");
  await Effect.runPromise(refreshRequiredExtensions(target, update));
  expect(calls).toEqual([id]);

  calls.length = 0;
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: id, version: "owner-edit" }),
  );
  await Effect.runPromise(refreshRequiredExtensions(target, update));
  expect(calls).toEqual([]);
  expect(await readFile(join(directory, "package.json"), "utf8")).toContain("owner-edit");
});
