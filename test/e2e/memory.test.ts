import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ziggy } from "../harness/cli";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import { type ModelServer, startModelServer, text, tools } from "../harness/provider";
import { eventually } from "../harness/eventually";
import { startResident, stopResidents } from "../harness/resident";

let server: ModelServer;

let profile: ScratchProfile;

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
});

afterEach(async () => {
  await stopResidents();
  server.stop();
  await profile.remove();
});

const readShared = () => readFile(join(profile.path, "MEMORY.md"), "utf8").catch(() => undefined);

describe("memory", () => {
  test("memory_write is on disk and in the next turn's prompt", async () => {
    server.push(
      tools({
        name: "memory_write",
        arguments: { scope: "shared", operations: [{ action: "add", content: "FACT_42" }] },
      }),
      text("saved"),
    );

    expect((await ziggy(profile, "run", profile.path, "remember")).exitCode).toBe(0);
    expect(await readShared()).toContain("FACT_42");

    await ziggy(profile, "run", profile.path, "what do you know");
    expect(server.raw(2)).toContain("## Memory (shared)");
    expect(server.raw(2)).toContain("FACT_42");
  });

  test("a write over the cap is refused and leaves memory unchanged", async () => {
    server.push(
      tools({
        name: "memory_write",
        arguments: { scope: "shared", operations: [{ action: "add", content: "y".repeat(2_300) }] },
      }),
      text("could not save"),
    );

    await writeFile(join(profile.path, "MEMORY.md"), "KEEP_ME\n", "utf8");
    await ziggy(profile, "run", profile.path, "remember a lot");

    expect(server.toolResults(1)).toContain("memory full");
    expect(await readShared()).toBe("KEEP_ME\n");
  });

  test("a group conversation sees its group memory and never a person's", async () => {
    await mkdir(join(profile.path, "memory", "users"), { recursive: true });
    await mkdir(join(profile.path, "memory", "groups"), { recursive: true });
    await writeFile(join(profile.path, "memory", "users", "owner.md"), "OWNER_ONLY\n", "utf8");
    await writeFile(join(profile.path, "memory", "groups", "crew.md"), "CREW_NOTE\n", "utf8");

    const resident = await startResident(profile);
    const client = await resident.connect();
    const ref = await client.gateway.openMain(client.profileId, { kind: "group", groupId: "crew" });
    await client.gateway.watchSession(ref);
    await client.gateway.submitPrompt(ref, "hello crew");
    await eventually("settled", () => client.events.find((event) => event.event === "settled"));
    expect(await resident.stop()).toBe(0);

    expect(server.raw(0)).toContain("CREW_NOTE");
    expect(server.raw(0)).not.toContain("OWNER_ONLY");
  });
});
