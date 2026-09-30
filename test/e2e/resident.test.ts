import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ziggy } from "../harness/cli";
import { scratchProfile, sessionFiles, type ScratchProfile } from "../harness/profile";
import { gate, held, type ModelServer, startModelServer, text } from "../harness/provider";
import { eventually } from "../harness/eventually";
import { type Client, type Resident, startResident, stopResidents } from "../harness/resident";
import { onlyTranscript, readTranscript, sessionId } from "../harness/transcript";

let server: ModelServer;

let profile: ScratchProfile;

let resident: Resident;

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
  resident = await startResident(profile);
});

afterEach(async () => {
  const codes = await stopResidents();
  server.stop();
  await profile.remove();
  expect(codes).toEqual([0]);
});

const settledCount = (client: Client): number =>
  client.events.filter((event) => event.event === "settled").length;

const assistantSnapshot = (client: Client): string | undefined =>
  client.events.findLast((event) => event.event === "assistant-text")?.payload.snapshot;

describe("one writer per session file", () => {
  test("with the web session open, run -c and run --session are refused and name the pid", async () => {
    server.push(text("from the web"));
    const client = await resident.connect();
    const ref = await client.gateway.openMain(client.profileId);
    await client.gateway.watchSession(ref);
    await client.gateway.submitPrompt(ref, "hello");
    await eventually("settled", () => settledCount(client) === 1);

    const main = await onlyTranscript(profile.path);
    const id = sessionId(main);
    const calls = server.requests.length;
    const refusal = `this session is open in another process (pid ${resident.pid}); use the UI, or start a new session\n`;

    expect(await ziggy(profile, "run", "-c", profile.path, "x")).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: refusal,
    });
    expect(await ziggy(profile, "run", "--session", id, profile.path, "x")).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: refusal,
    });

    expect(server.requests).toHaveLength(calls);
    expect(await readTranscript(profile.path, main.file)).toEqual(main);

    const plain = await ziggy(profile, "run", profile.path, "y");
    expect(plain).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
  });
});

describe("web sessions", () => {
  test("a client that drops mid-turn and rewatches from its cursor gets the live tail", async () => {
    const turn = gate();
    server.push(held("par", "tial answer", turn));
    const first = await resident.connect();
    const ref = await first.gateway.openMain(first.profileId);
    await first.gateway.watchSession(ref);
    await first.gateway.submitPrompt(ref, "stream please");
    await turn.started;

    const seen = await eventually("first delta", () =>
      first.events.findLast((event) => event.event === "assistant-text"),
    );

    first.close();

    const second = await resident.connect();
    await second.gateway.watchSession(ref, { epoch: seen.epoch, seq: seen.seq });
    expect(settledCount(second)).toBe(0);

    turn.release();
    await eventually("settled after reconnect", () => settledCount(second) === 1);
    expect(assistantSnapshot(second)).toBe("partial answer");

    const transcript = await onlyTranscript(profile.path);
    expect(transcript.roles).toEqual(["user", "assistant"]);
    expect(transcript.text).toContain("partial answer");
  });

  test("two clients opening the same session at once share one handle and one file", async () => {
    const [left, right] = await Promise.all([resident.connect(), resident.connect()]);

    const [leftRef, rightRef] = await Promise.all([
      left.gateway.openMain(left.profileId),
      right.gateway.openMain(right.profileId),
    ]);

    expect(leftRef).toEqual(rightRef);

    await Promise.all([left.gateway.watchSession(leftRef), right.gateway.watchSession(rightRef)]);
    await left.gateway.submitPrompt(leftRef, "shared");
    await eventually("both settled", () => settledCount(left) === 1 && settledCount(right) === 1);

    expect(assistantSnapshot(right)).toBe("ok");
    expect(await sessionFiles(profile.path)).toHaveLength(1);
  });
});
