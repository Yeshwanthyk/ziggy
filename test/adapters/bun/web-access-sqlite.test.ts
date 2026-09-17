/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests own disposable adapter boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Result } from "effect";
import { openWebAccessStore, webAccessDatabasePath } from "ziggy/adapters/bun/web-access-sqlite";
import { readWebAccessConfig, writeWebAccessConfig } from "ziggy/adapters/fs/web-access-config";

const paths: Array<string> = [];

const makeProfile = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-web-access-"));
  paths.push(path);

  return path;
};

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("durable browser access", () => {
  test("consumes pairing once and preserves then revokes the session across reopen", async () => {
    const profilePath = await makeProfile();
    const first = openWebAccessStore(profilePath);
    const pairing = first.issuePairing(1_000);
    const session = first.redeemPairing(pairing.token, 2_000);

    expect(session).toBeDefined();
    expect(first.redeemPairing(pairing.token, 2_000)).toBeUndefined();
    first.close();

    const reopened = openWebAccessStore(profilePath);
    expect(reopened.sessionValid(session?.token ?? "", 3_000)).toBeTrue();
    expect(reopened.revokeAll(4_000)).toBe(1);
    expect(reopened.sessionValid(session?.token ?? "", 4_001)).toBeFalse();
    reopened.close();
  });

  test("fails closed for expired pairings and unknown database schemas", async () => {
    const profilePath = await makeProfile();
    const store = openWebAccessStore(profilePath);
    const pairing = store.issuePairing(1_000);
    expect(store.redeemPairing(pairing.token, 1_000 + 10 * 60 * 1_000)).toBeUndefined();
    store.close();

    const database = new Database(webAccessDatabasePath(profilePath));
    database.exec("PRAGMA user_version = 99");
    database.close(false);
    expect(() => openWebAccessStore(profilePath)).toThrow("could not open web access database");
  });

  test("rejects a symlinked durable directory", async () => {
    const profilePath = await makeProfile();
    const external = await makeProfile();
    await symlink(external, join(profilePath, ".gateway"));
    expect(() => openWebAccessStore(profilePath)).toThrow("could not open web access database");
  });
});

describe("web access config", () => {
  test("validates before replacing a good config", async () => {
    const profilePath = await makeProfile();
    await Effect.runPromise(
      writeWebAccessConfig(profilePath, {
        version: 1,
        port: 8787,
        publicUrl: "https://ziggy.example",
      }),
    );

    const invalid = await Effect.runPromise(
      writeWebAccessConfig(profilePath, {
        version: 1,
        port: 9999,
        publicUrl: "file:///tmp/ziggy",
      }).pipe(Effect.result),
    );

    expect(Result.isFailure(invalid)).toBeTrue();
    expect(await Effect.runPromise(readWebAccessConfig(profilePath))).toEqual({
      version: 1,
      port: 8787,
      publicUrl: "https://ziggy.example",
    });
  });
});
