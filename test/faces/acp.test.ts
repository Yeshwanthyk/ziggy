/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- ACP test clients own their Promise transport and callback boundaries */
import { expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { Deferred, Effect, Schema } from "effect";
import {
  makeChatHandle,
  type ChatHandle,
  type ChatPromptOptions,
  type ZiggyAgentApi,
} from "ziggy/application/agent";
import type { ModelsApi } from "ziggy/application/models";
import { makeAcpAgent } from "ziggy/faces/acp";

const target = { path: "/profile", name: "Profile" } as const;
const decodeNewSessionResponseLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.Literal(1),
      result: Schema.Struct({ sessionId: Schema.String }),
    }),
  ),
);

const decodeNewSessionWithModels = Schema.decodeUnknownSync(
  Schema.Struct({
    sessionId: Schema.String,
    models: Schema.Struct({
      availableModels: Schema.Array(
        Schema.Struct({
          modelId: Schema.String,
          name: Schema.String,
          description: Schema.String,
        }),
      ),
      currentModelId: Schema.optional(Schema.String),
    }),
  }),
);

const stubAgent = (openChat: ZiggyAgentApi["openChat"]): ZiggyAgentApi => ({
  runOnce: () => Effect.never,
  openTui: () => Effect.never,
  openChat,
  openSpecialistChat: () => Effect.never,
  runSpecialist: () => Effect.never,
});

const stubModels: ModelsApi = {
  status: () =>
    Effect.succeed({
      providerId: "openai",
      modelId: "gpt-5",
      thinking: "high",
      authConfigured: true,
    }),
  readOnlyStatus: () =>
    Effect.succeed({
      providerId: "openai",
      modelId: "gpt-5",
      thinking: "high",
      authConfigured: true,
    }),
  list: () =>
    Effect.succeed([
      { providerId: "openai", modelId: "gpt-5", name: "GPT-5", thinkingLevels: ["medium", "high"] },
    ]),
  available: () =>
    Effect.succeed([
      { providerId: "openai", modelId: "gpt-5", name: "GPT-5", thinkingLevels: ["medium", "high"] },
    ]),
  set: () => Effect.succeed({ providerId: "openai", modelId: "gpt-5", thinking: "high" }),
};

test("ACP v1 NDJSON initializes, opens a local session, and streams ordered text", async () => {
  const updates: Array<SessionNotification> = [];
  let opened:
    | {
        readonly context: string;
        readonly directory: string;
        readonly mode: string | undefined;
      }
    | undefined;
  let promptText = "";
  let disposals = 0;
  const handle = makeChatHandle({
    prompt: (text, options) =>
      Effect.sync(() => {
        promptText = text;
        options?.onProgress?.({
          kind: "assistant-text",
          delta: "hello",
          snapshot: "hello",
        });
        options?.onProgress?.({
          kind: "assistant-text",
          delta: " world",
          snapshot: "hello world",
        });
        return "hello world";
      }),
    dispose: Effect.sync(() => {
      disposals += 1;
    }),
  });

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* makeAcpAgent(
          target,
          false,
          stubAgent((_target, context, directory, mode) => {
            opened = { context: context.kind, directory, mode };
            return Effect.succeed(handle);
          }),
          stubModels,
        );
        const clientToAgent = new TransformStream<Uint8Array>();
        const agentToClient = new TransformStream<Uint8Array>();
        const agentConnection = app.connect(
          ndJsonStream(agentToClient.writable, clientToAgent.readable),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => agentConnection.close()));
        return yield* Effect.promise(() =>
          client({ name: "test-client" })
            .onNotification(methods.client.session.update, ({ params }) => {
              updates.push(params);
            })
            .connectWith(
              ndJsonStream(clientToAgent.writable, agentToClient.readable),
              async (agentContext) => {
                const initialized = await agentContext.request(methods.agent.initialize, {
                  protocolVersion: PROTOCOL_VERSION,
                  clientCapabilities: {},
                });
                const session = await agentContext.request(methods.agent.session.new, {
                  cwd: "/workspace",
                  mcpServers: [],
                });
                const prompted = await agentContext.request(methods.agent.session.prompt, {
                  sessionId: session.sessionId,
                  prompt: [
                    { type: "text", text: "Review this" },
                    {
                      type: "resource_link",
                      name: "spec",
                      uri: "file:///workspace/spec.md",
                      description: "the specification",
                    },
                  ],
                });
                return { initialized, session, prompted };
              },
            ),
        );
      }),
    ),
  );

  expect(result.initialized).toEqual({
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: { name: "ziggy", title: "Ziggy", version: "0.2.5" },
  });
  expect(result.prompted).toEqual({ stopReason: "end_turn" });
  expect(opened).toEqual({
    context: "local",
    directory: `/profile/sessions/acp/${result.session.sessionId}`,
    mode: "fresh",
  });
  expect(promptText).toBe(
    "Review this\n\nResource: spec\nURI: file:///workspace/spec.md\nDescription: the specification",
  );
  expect(updates.map((update) => update.update)).toEqual([
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " world" },
    },
  ]);
  expect(disposals).toBe(1);
});

test("ACP rejects unsupported session and prompt inputs and isolates shared memory", async () => {
  let groupId: string | undefined;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* makeAcpAgent(
          target,
          true,
          stubAgent((_target, context) => {
            groupId = context.kind === "group" ? context.groupId : undefined;
            return Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("ok") }));
          }),
          stubModels,
        );
        return yield* Effect.promise(() =>
          client().connectWith(app, async (agentContext) => {
            for (const request of [
              { cwd: "relative", mcpServers: [] },
              { cwd: "/workspace", mcpServers: [], additionalDirectories: ["/other"] },
              {
                cwd: "/workspace",
                mcpServers: [{ name: "tools", command: "/bin/true", args: [], env: [] }],
              },
            ]) {
              await expect(
                agentContext.request(methods.agent.session.new, request),
              ).rejects.toMatchObject({ code: -32_602 });
            }
            const session = await agentContext.request(methods.agent.session.new, {
              cwd: "/workspace",
              mcpServers: [],
            });
            expect(groupId).toBe(`acp-${session.sessionId}`);
            await expect(
              agentContext.request(methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
              }),
            ).rejects.toMatchObject({ code: -32_602 });
            await expect(
              agentContext.request(methods.agent.session.prompt, {
                sessionId: "missing",
                prompt: [{ type: "text", text: "hello" }],
              }),
            ).rejects.toMatchObject({ code: -32_602 });
          }),
        );
      }),
    ),
  );
});

test("ACP session/new announces auth-configured models and session/set_model validates them", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* makeAcpAgent(
          target,
          false,
          stubAgent(() => Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("ok") }))),
          stubModels,
        );
        return yield* Effect.promise(() =>
          client().connectWith(app, async (agentContext) => {
            const session = decodeNewSessionWithModels(
              await agentContext.request(methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
              }),
            );
            expect(session.models).toEqual({
              availableModels: [
                {
                  modelId: "openai/gpt-5",
                  name: "GPT-5",
                  description: "openai / gpt-5",
                },
              ],
              currentModelId: "openai/gpt-5",
            });
            const accepted = await agentContext.request("session/set_model", {
              sessionId: session.sessionId,
              modelId: "openai/gpt-5",
            });
            expect(accepted).toEqual({});
            await expect(
              agentContext.request("session/set_model", {
                sessionId: session.sessionId,
                modelId: "unknown/provider-model",
              }),
            ).rejects.toMatchObject({ code: -32_602 });
            await expect(
              agentContext.request("session/set_model", {
                sessionId: "missing",
                modelId: "openai/gpt-5",
              }),
            ).rejects.toMatchObject({ code: -32_602 });
          }),
        );
      }),
    ),
  );
});

test("ACP routes sessions to a specialist when --agent is set", async () => {
  const opened: Array<string> = [];
  const handle = makeChatHandle({ prompt: () => Effect.succeed("ok") });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* makeAcpAgent(
          target,
          false,
          {
            runOnce: () => Effect.never,
            openTui: () => Effect.never,
            openChat: () => Effect.never,
            openSpecialistChat: (target, agentId) =>
              Effect.sync(() => {
                opened.push(`${target.name}:${agentId}`);
                return handle;
              }),
            runSpecialist: () => Effect.never,
          },
          stubModels,
          "ada",
        );
        return yield* Effect.promise(() =>
          client().connectWith(app, async (agentContext) => {
            const session = await agentContext.request(methods.agent.session.new, {
              cwd: "/workspace",
              mcpServers: [],
            });
            expect(session.sessionId).toEqual(expect.any(String));
          }),
        );
      }),
    ),
  );
  expect(opened).toEqual(["Profile:ada"]);
});

test("ACP cancellation aborts the active handle and resolves the prompt as cancelled", async () => {
  let aborts = 0;
  const started = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const handle: ChatHandle = makeChatHandle({
    prompt: (_text: string, _options?: ChatPromptOptions) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as("done"),
      ),
    abort: Effect.sync(() => {
      aborts += 1;
    }).pipe(Effect.andThen(Deferred.succeed(release, undefined)), Effect.asVoid),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* makeAcpAgent(
          target,
          false,
          stubAgent(() => Effect.succeed(handle)),
          stubModels,
        );
        return yield* Effect.promise(() =>
          client().connectWith(app, async (agentContext) => {
            const session = await agentContext.request(methods.agent.session.new, {
              cwd: "/workspace",
              mcpServers: [],
            });
            const prompting = agentContext.request(methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "wait" }],
            });
            await Effect.runPromise(Deferred.await(started));
            await agentContext.notify(methods.agent.session.cancel, {
              sessionId: session.sessionId,
            });
            expect(await prompting).toEqual({ stopReason: "cancelled" });
          }),
        );
      }),
    ),
  );
  expect(aborts).toBe(1);
});

test("ACP stdio keeps incidental runtime logs off protocol stdout", async () => {
  const faceUrl = new URL("../../src/faces/acp.ts", import.meta.url).href;
  const script = `
    import { Effect } from "effect";
    import { makeChatHandle } from "ziggy/application/agent";
    import { runAcp } from ${JSON.stringify(faceUrl)};
    const handle = makeChatHandle({ prompt: () => Effect.succeed("ok") });
    const agent = {
      runOnce: () => Effect.never,
      openTui: () => Effect.never,
      openChat: () => Effect.sync(() => {
        console.log("incidental open log");
        return handle;
      }),
      openSpecialistChat: () => Effect.never,
      runSpecialist: () => Effect.never,
    };
    const models = {
      status: () => Effect.succeed({ providerId: "openai", modelId: "gpt-5", thinking: "high", authConfigured: true }),
      readOnlyStatus: () => Effect.succeed({ providerId: "openai", modelId: "gpt-5", thinking: "high", authConfigured: true }),
      list: () => Effect.succeed([{ providerId: "openai", modelId: "gpt-5", name: "GPT-5", thinkingLevels: ["medium", "high"] }]),
      available: () => Effect.succeed([{ providerId: "openai", modelId: "gpt-5", name: "GPT-5", thinkingLevels: ["medium", "high"] }]),
      set: () => Effect.succeed({ providerId: "openai", modelId: "gpt-5", thinking: "high" }),
    };
    await Effect.runPromise(
      runAcp({ path: "/profile", name: "Profile" }, false, agent, models),
    );
  `;
  const request = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { cwd: "/workspace", mcpServers: [] },
  })}\n`;
  const subprocess = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  subprocess.stdin.write(request);
  subprocess.stdin.flush();
  const stdoutReader = subprocess.stdout.getReader();
  const first = await stdoutReader.read();
  const stdout = first.done ? "" : new TextDecoder().decode(first.value);
  subprocess.stdin.end();
  const [exitCode, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(decodeNewSessionResponseLine(lines[0] ?? "null").result.sessionId).toEqual(
    expect.any(String),
  );
  expect(stderr).toContain("incidental open log");
});
