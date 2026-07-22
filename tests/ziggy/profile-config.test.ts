import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProfileConfig, loadProfileConfig } from "../../packages/ziggy/src/profile-config.ts";
import { runEffect } from "../testkit/effect.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";

const profiles: string[] = [];

test("Profile config decoder accepts init schema and comments without rewriting owner bytes", async () => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-config-"));
  profiles.push(path);
  const contents = `{
    // Provider binding
    "schemaVersion": 1,
    "defaultProvider": "anthropic",
    "defaultModel": "claude-fable-5",
    "thinkingLevel": "medium",
    "cacheRetention": "long"
  }\n`;
  await writeFile(join(path, "ziggy.jsonc"), contents);
  expect(await runEffect(loadProfileConfig(path))).toEqual({
    schemaVersion: 1,
    defaultProvider: "anthropic",
    defaultModel: "claude-fable-5",
    thinkingLevel: "medium",
    cacheRetention: "long",
  });
  expect(await readFile(join(path, "ziggy.jsonc"), "utf8")).toBe(contents);
});

test("Profile config decoder rejects malformed, duplicate, unknown, unsupported, and invalid settings", async () => {
  const invalid = [
    "{",
    '{"schemaVersion":1,"schemaVersion":1,"defaultProvider":"p","defaultModel":"m","thinkingLevel":"low","cacheRetention":"none"}',
    '{"schemaVersion":2,"defaultProvider":"p","defaultModel":"m","thinkingLevel":"low","cacheRetention":"none"}',
    '{"schemaVersion":1,"defaultProvider":"p","defaultModel":"m","thinkingLevel":"max","cacheRetention":"none"}',
    '{"schemaVersion":1,"defaultProvider":"p","defaultModel":"m","baseUrl":"http://127.0.0.1:8080/v1","thinkingLevel":"low","cacheRetention":"none"}',
    '{"schemaVersion":1,"defaultProvider":"p","defaultModel":"m","thinkingLevel":"low","cacheRetention":"forever"}',
    '{"schemaVersion":1,"defaultProvider":"p","defaultModel":"m","thinkingLevel":"low","cacheRetention":"none","extra":true}',
  ];
  for (const contents of invalid) {
    await expect(
      runEffect(decodeProfileConfig(contents, "/fixture/ziggy.jsonc")),
    ).rejects.toThrow();
  }
});

afterAll(async () => {
  emitVerificationObservation("s3.profile-config", emptyRuntimeObservations());
  await Promise.all(profiles.map((path) => rm(path, { recursive: true, force: true })));
});
