import { afterAll, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "../../packages/core/node_modules/@earendil-works/pi-ai";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";
import { Effect, Exit, Scope } from "effect";
import { createProfileCredentialStore as createProfileCredentialStoreEffect } from "../../packages/core/src/index.ts";
import { runEffect } from "../testkit/effect.ts";

const profiles: string[] = [];
const credentialScopes: Scope.Closeable[] = [];
const secret = "credential-secret-canary";

async function createProfileCredentialStore(profilePath: string): Promise<CredentialStore> {
  const scope = await runEffect(Scope.make());
  credentialScopes.push(scope);
  return runEffect(
    createProfileCredentialStoreEffect(profilePath).pipe(Effect.provideService(Scope.Scope, scope)),
  );
}

function fixtureDigest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function profile(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `ziggy-credentials-${name}-`));
  profiles.push(path);
  await mkdir(join(path, "credentials"), { mode: 0o700 });
  await chmod(join(path, "credentials"), 0o700);
  return path;
}

test("Profile CredentialStore persists strict schema-stamped credentials with private modes", async () => {
  const path = await profile("roundtrip");
  const store = await createProfileCredentialStore(path);
  await store.modify("anthropic", async () => ({ type: "api_key", key: secret }));
  const stored = await store.read("anthropic");
  expect(stored?.type).toBe("api_key");
  expect(fixtureDigest(stored?.type === "api_key" ? (stored.key ?? "") : "")).toBe(
    fixtureDigest(secret),
  );
  expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
  const file = join(path, "credentials", "auth.json");
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
  const document: unknown = JSON.parse(await readFile(file, "utf8"));
  expect(fixtureDigest(JSON.stringify(document))).toBe(
    fixtureDigest(
      JSON.stringify({
        schemaVersion: 1,
        credentials: { anthropic: { type: "api_key", key: secret } },
      }),
    ),
  );
  await store.delete("anthropic");
  expect(await store.read("anthropic")).toBeUndefined();
});

test("Profile CredentialStore uses own-key semantics for accepted Provider ids", async () => {
  const path = await profile("prototype-safe");
  const store = await createProfileCredentialStore(path);
  expect(await store.read("constructor")).toBeUndefined();
  let currentWasUndefined = false;
  await store.modify("constructor", async (current) => {
    currentWasUndefined = current === undefined;
    return undefined;
  });
  expect(currentWasUndefined).toBeTrue();
  expect(await store.list()).toEqual([]);
  await store.delete("constructor");
  expect(await Bun.file(join(path, "credentials", "auth.json")).exists()).toBeFalse();

  await store.modify("constructor", async () => ({ type: "api_key", key: "fixture-key" }));
  expect((await store.read("constructor"))?.type).toBe("api_key");
  expect(await store.list()).toEqual([{ providerId: "constructor", type: "api_key" }]);
  await store.delete("constructor");
  expect(await store.read("constructor")).toBeUndefined();
});

test("Profile CredentialStore serializes modify and preserves the old value on callback failure", async () => {
  const path = await profile("serialize");
  const store = await createProfileCredentialStore(path);
  const firstEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const seen: string[] = [];
  const first = store.modify("anthropic", async (current) => {
    expect(current).toBeUndefined();
    seen.push("first");
    firstEntered.resolve();
    await releaseFirst.promise;
    return { type: "api_key", key: "first" };
  });
  await firstEntered.promise;
  const second = store.modify("anthropic", async (current) => {
    seen.push(current?.type === "api_key" ? (current.key ?? "missing") : "wrong");
    return { type: "api_key", key: "second" };
  });
  releaseFirst.resolve();
  await Promise.all([first, second]);
  expect(seen).toEqual(["first", "first"]);
  await expect(
    store.modify("anthropic", async () => Promise.reject(new Error("fixture callback failure"))),
  ).rejects.toThrow("fixture callback failure");
  expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "second" });
});

test("Profile CredentialStore rejects directory identity swaps after composition", async () => {
  const path = await profile("directory-swap");
  const store = await createProfileCredentialStore(path);
  await store.modify("anthropic", async () => ({ type: "api_key", key: "fixture-key" }));
  await rename(join(path, "credentials"), join(path, "credentials-displaced"));
  await mkdir(join(path, "credentials"), { mode: 0o700 });
  await expect(store.read("anthropic")).rejects.toThrow("identity changed");
});

test("Profile CredentialStore bounds documents, fields, collections, and nesting", async () => {
  const oversized = await profile("oversized-document");
  await writeFile(join(oversized, "credentials", "auth.json"), "x".repeat(1024 * 1024 + 1), {
    mode: 0o600,
  });
  await expect(createProfileCredentialStore(oversized)).rejects.toThrow("exceeds 1048576 bytes");

  const fields = await profile("bounded-fields");
  const store = await createProfileCredentialStore(fields);
  await store.modify("anthropic", async () => ({ type: "api_key", key: "preserved" }));
  await expect(
    store.modify("anthropic", async () => ({ type: "api_key", key: "x".repeat(65_537) })),
  ).rejects.toThrow("invalid credential anthropic key");
  expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "preserved" });

  const tooMany = await profile("provider-collection");
  const credentials: Record<string, unknown> = {};
  for (let index = 0; index < 257; index += 1) {
    credentials[`provider-${index}`] = { type: "api_key", key: "fixture" };
  }
  await writeFile(
    join(tooMany, "credentials", "auth.json"),
    `${JSON.stringify({ schemaVersion: 1, credentials })}\n`,
    { mode: 0o600 },
  );
  await expect(createProfileCredentialStore(tooMany)).rejects.toThrow("exceeds 256 Providers");

  const writeBound = await profile("provider-write-bound");
  const boundedCredentials: Record<string, unknown> = {};
  for (let index = 0; index < 256; index += 1) {
    boundedCredentials[`provider-${index}`] = { type: "api_key", key: "fixture" };
  }
  await writeFile(
    join(writeBound, "credentials", "auth.json"),
    `${JSON.stringify({ schemaVersion: 1, credentials: boundedCredentials })}\n`,
    { mode: 0o600 },
  );
  const boundedStore = await createProfileCredentialStore(writeBound);
  await expect(
    boundedStore.modify("provider-256", async () => ({ type: "api_key", key: "fixture" })),
  ).rejects.toThrow("exceeds 256 Providers");
  expect(await boundedStore.list()).toHaveLength(256);
  expect(await boundedStore.read("provider-256")).toBeUndefined();

  const nested = await profile("oauth-depth");
  let metadata: unknown = "leaf";
  for (let depth = 0; depth < 18; depth += 1) metadata = { nested: metadata };
  await writeFile(
    join(nested, "credentials", "auth.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      credentials: {
        anthropic: {
          type: "oauth",
          refresh: "refresh-fixture",
          access: "access-fixture",
          expires: 1,
          metadata,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  await expect(createProfileCredentialStore(nested)).rejects.toThrow("invalid bounded");
});

test("Profile CredentialStore fails closed on schema, shape, path-kind, and mode violations", async () => {
  const malformed = await profile("malformed");
  await writeFile(
    join(malformed, "credentials", "auth.json"),
    '{"schemaVersion":2,"credentials":{}}\n',
    { mode: 0o600 },
  );
  await expect(createProfileCredentialStore(malformed)).rejects.toThrow("schemaVersion");

  const unsafeMode = await profile("mode");
  await chmod(join(unsafeMode, "credentials"), 0o755);
  await expect(createProfileCredentialStore(unsafeMode)).rejects.toThrow("0700");

  const linked = await profile("linked");
  const target = join(linked, "target.json");
  await writeFile(target, '{"schemaVersion":1,"credentials":{}}\n', { mode: 0o600 });
  await symlink(target, join(linked, "credentials", "auth.json"));
  await expect(createProfileCredentialStore(linked)).rejects.toThrow("regular");
});

afterAll(async () => {
  emitVerificationObservation("s3.credential-authority", emptyRuntimeObservations());
  await Promise.all(credentialScopes.map((scope) => runEffect(Scope.close(scope, Exit.void))));
  await Promise.all(profiles.map((path) => rm(path, { recursive: true, force: true })));
});
