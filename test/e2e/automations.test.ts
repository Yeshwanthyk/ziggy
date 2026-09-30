import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ziggy } from "../harness/cli";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import { gate, held, type ModelServer, startModelServer, text } from "../harness/provider";
import { eventually } from "../harness/eventually";
import { startResident, stopResidents } from "../harness/resident";
import { onlyTranscript, readTranscript, sessionId } from "../harness/transcript";

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

const writeAutomation = async (target: string, cron = "0 9 * * *"): Promise<void> => {
  await mkdir(join(profile.path, "automations"), { recursive: true });
  await writeFile(
    join(profile.path, "automations", "digest.md"),
    `---\nversion: 1\ncron: ${cron}\ntimezone: UTC\nbroadcast: conversation:${target}\n---\n\nWrite the digest.\n`,
    "utf8",
  );
};

const receipts = async (file: string): Promise<number> => {
  const transcript = await readTranscript(profile.path, file);

  return transcript.entries.filter((entry) => entry.customType === "ziggy.automation-result")
    .length;
};

/** One conversation made by a plain `run`, so it has a header id to target. */
const conversation = async (): Promise<{ file: string; id: string }> => {
  await ziggy(profile, "run", profile.path, "start");
  const transcript = await onlyTranscript(profile.path);

  return { file: transcript.file, id: sessionId(transcript) };
};

describe("automation delivery", () => {
  test("with no resident, each wake stores one receipt in the target conversation", async () => {
    const target = await conversation();
    await writeAutomation(target.id);
    server.push(text("DIGEST_ONE"), text("DIGEST_TWO"));

    const first = await ziggy(profile, "wake", profile.path, "digest");
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain(`wake delivered: conversation:${target.id}`);
    expect(await receipts(target.file)).toBe(1);

    await ziggy(profile, "wake", profile.path, "digest");
    expect(await receipts(target.file)).toBe(2);
    const stored = await readFile(join(profile.path, "sessions", target.file), "utf8");
    expect(stored).toContain("DIGEST_ONE");
    expect(stored).toContain("DIGEST_TWO");
  });

  test("with a resident up, wake is forwarded and stores the receipt in an unopened conversation", async () => {
    const target = await conversation();
    await writeAutomation(target.id);
    await startResident(profile);
    server.push(text("DIGEST_STORED"));

    const woke = await ziggy(profile, "wake", profile.path, "digest");
    expect(woke.stderr).toContain(`wake delivered: conversation:${target.id}`);
    expect(await stopResidents()).toEqual([0]);
    expect(await receipts(target.file)).toBe(1);
  });

  test("a live idle conversation gets the result as an event and one receipt", async () => {
    const resident = await startResident(profile);
    const client = await resident.connect();
    const ref = await client.gateway.openMain(client.profileId);
    await client.gateway.watchSession(ref);
    await client.gateway.submitPrompt(ref, "start");
    await eventually("settled", () => client.events.find((event) => event.event === "settled"));
    const target = await onlyTranscript(profile.path);
    await writeAutomation(sessionId(target));
    server.push(text("DIGEST_LIVE"));

    await client.gateway.runAutomation(client.profileId, "digest");

    const event = await eventually("automation-result", () =>
      client.events.find((candidate) => candidate.event === "automation-result"),
    );

    expect(JSON.stringify(event)).toContain("DIGEST_LIVE");
    expect(await resident.stop()).toBe(0);
    expect(await receipts(target.file)).toBe(1);
  });

  test("a busy conversation is refused as retriable and not written mid-turn", async () => {
    const hold = gate();
    const resident = await startResident(profile);
    const client = await resident.connect();
    const ref = await client.gateway.openMain(client.profileId);
    await client.gateway.watchSession(ref);
    await client.gateway.submitPrompt(ref, "start");
    await eventually("settled", () => client.events.find((event) => event.event === "settled"));
    const target = await onlyTranscript(profile.path);
    await writeAutomation(sessionId(target));
    server.push(held("partial", "done", hold), text("DIGEST_BUSY"));

    await client.gateway.submitPrompt(ref, "keep going");
    await hold.started;
    const outcome = await client.gateway.runAutomation(client.profileId, "digest");
    expect(JSON.stringify(outcome)).toContain("session-busy");

    hold.release();
    await eventually(
      "second settle",
      () => client.events.filter((event) => event.event === "settled").length >= 2,
    );
    expect(await resident.stop()).toBe(0);
    expect(await receipts(target.file)).toBe(0);
  });

  // Effect's Cron.next throws for a cron that parses but never fires; parsing rejects it instead.
  test("a resident starts even when an automation's cron never fires", async () => {
    const target = await conversation();
    await writeAutomation(target.id, "0 0 31 2 *");

    await startResident(profile, 1_500);
    expect(await stopResidents()).toEqual([0]);
  });
});
