import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { spawnZiggy } from "../harness/cli";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import { type ModelServer, startModelServer, text } from "../harness/provider";

let server: ModelServer;

let profile: ScratchProfile;

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
});

afterEach(async () => {
  server.stop();
  await profile.remove();
});

/** Drives a real `ziggy acp` child over stdio as an editor would. */
const withAcp = async <A>(
  drive: (
    agent: Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0],
  ) => Promise<A>,
): Promise<A> => {
  const child = spawnZiggy(profile, "acp", profile.path);

  const toAgent = new WritableStream<Uint8Array>({
    write: (chunk) => {
      child.stdin.write(chunk);
      void child.stdin.flush();
    },
  });

  const stderr = new Response(child.stderr).text();

  try {
    return await client({ name: "harness" }).connectWith(
      ndJsonStream(toAgent, child.stdout),
      drive,
    );
  } catch (error) {
    console.error(await Promise.race([stderr, Bun.sleep(100).then(() => "")]));
    throw error;
  } finally {
    void child.stdin.end();
    child.kill("SIGINT");
    await child.exited;
  }
};

describe("acp", () => {
  test("a prompt streams the model's answer back", async () => {
    server.push(text("acp answer"));

    const stopReason = await withAcp(async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const session = await agent.request(methods.agent.session.new, {
        cwd: profile.root,
        mcpServers: [],
      });

      const prompted = await agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      return prompted.stopReason;
    });

    expect(stopReason).toBe("end_turn");
    expect(server.request(0).model).toBe("harness-model");
  });

  test("session/set_model changes the next request's model", async () => {
    await withAcp(async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const session = await agent.request(methods.agent.session.new, {
        cwd: profile.root,
        mcpServers: [],
      });

      await agent.request("session/set_model", {
        sessionId: session.sessionId,
        modelId: "harness/harness-other",
      });
      await agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
    });

    expect(server.request(0).model).toBe("harness-other");
  });
});
