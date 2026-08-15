/* oxlint-disable ziggy-effect/no-effect-execution-boundary, ziggy-effect/no-native-promise-ownership -- tests are approved execution boundaries */
import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Result } from "effect";
import { DiscordApiError } from "ziggy/adapters/discord/api";
import type {
  DiscordInboundInteraction,
  DiscordInboundMessage,
  DiscordSocket,
} from "ziggy/adapters/discord/socket";
import type {
  DiscordIngressPayload,
  DiscordIngressTerminalState,
} from "ziggy/domain/discord-ingress";
import { formatSpecialistVoice, makeChatHandle, type ZiggyAgentApi } from "ziggy/application/agent";
import {
  discordMessageChunks,
  discordIngressTerminalState,
  discordThreadConversation,
  makeDiscordGateway,
  normalizeDiscordMessage,
  prepareDiscordAttachmentPrompt,
  retryDiscordDelivery,
  shouldUpdateDiscordProgress,
  type DiscordIngressRuntime,
  type DiscordTransport,
} from "ziggy/application/discord-gateway";

const message = (overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage => ({
  id: "m1",
  channelId: "456",
  guildId: undefined,
  authorId: "123",
  authorIsBot: false,
  content: "hello",
  attachments: [],
  omittedAttachmentCount: 0,
  ...overrides,
});

const unexpectedDiscordApiCall = (operation: DiscordApiError["operation"]) =>
  Effect.fail(
    new DiscordApiError({
      operation,
      reason: "rejected",
      retriable: false,
      message: `unexpected Discord ${operation} call`,
      cause: { unexpected: operation },
    }),
  );

const silentDiscordFeedback = {
  triggerTyping: () => Effect.void,
  addReaction: () => Effect.void,
  removeReaction: () => Effect.void,
} satisfies Pick<DiscordTransport, "triggerTyping" | "addReaction" | "removeReaction">;

describe("Discord gateway boundary", () => {
  test("admits an owner DM without assigning session identity at the socket boundary", () => {
    expect(normalizeDiscordMessage(message(), "123")).toEqual({
      messageId: "m1",
      channelId: "456",
      sourceChannelId: "456",
      guildId: undefined,
      authorId: "123",
      text: "hello",
    });
  });

  test("rejects non-owner and bot messages", () => {
    expect(normalizeDiscordMessage(message(), "999")).toBeUndefined();
    expect(normalizeDiscordMessage(message({ authorIsBot: true }), "123")).toBeUndefined();
  });

  test("reconciles global commands and legacy cleanup for READY guilds", async () => {
    const reconciliations: Array<{
      readonly token: string;
      readonly guildIds: ReadonlyArray<string>;
    }> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        let connectionStateRead = false;
        const socket: DiscordSocket = {
          next: Effect.never,
          nextConnectionState: Effect.suspend(() => {
            if (connectionStateRead) return Effect.never;
            connectionStateRead = true;
            return Effect.succeed({ state: "connected", guildIds: ["guild-2", "guild-1"] });
          }),
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: () => unexpectedDiscordApiCall("createMessage"),
          updateMessage: () => unexpectedDiscordApiCall("updateMessage"),
          ensureCommands: (token, guildIds) =>
            Effect.sync(() => {
              reconciliations.push({ token, guildIds });
            }).pipe(Effect.andThen(Deferred.succeed(completed, undefined))),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({ prompt: () => Effect.succeed("unused"), dispose: Effect.void }),
            ),
        };

        yield* Effect.raceFirst(
          makeDiscordGateway(agent, transport).runLoop(
            { path: "/tmp/ziggy-discord-command-reconciliation-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(completed),
        );
      }),
    );

    expect(reconciliations).toEqual([{ token: "token", guildIds: ["guild-1", "guild-2"] }]);
  });

  test("responds to owner-only status and scoped stop slash commands in a thread", async () => {
    const responses: Array<{ readonly id: string; readonly text: string }> = [];
    let openChatCalls = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        const interactions: ReadonlyArray<DiscordInboundInteraction> = [
          {
            id: "status-interaction",
            token: "status-token",
            guildId: "guild",
            channelId: "thread",
            channelType: 11,
            parentChannelId: "parent",
            authorId: "123",
            commandName: "status",
          },
          {
            id: "stop-interaction",
            token: "stop-token",
            guildId: "guild",
            channelId: "thread",
            channelType: 11,
            parentChannelId: "parent",
            authorId: "123",
            commandName: "stop",
          },
        ];
        let nextInteraction = 0;
        const socket: DiscordSocket = {
          next: Effect.never,
          nextInteraction: Effect.suspend(() => {
            const interaction = interactions[nextInteraction];
            nextInteraction += 1;
            return interaction === undefined ? Effect.never : Effect.succeed(interaction);
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: () => unexpectedDiscordApiCall("createMessage"),
          updateMessage: () => unexpectedDiscordApiCall("updateMessage"),
          respondToInteraction: (id, _token, text) =>
            Effect.sync(() => {
              responses.push({ id, text });
              return responses.length;
            }).pipe(
              Effect.flatMap((responseCount) =>
                responseCount === interactions.length
                  ? Deferred.succeed(completed, undefined)
                  : Effect.void,
              ),
            ),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.sync(() => {
              openChatCalls += 1;
              return makeChatHandle({
                prompt: () => Effect.succeed("unused"),
                dispose: Effect.void,
              });
            }),
        };
        const gateway = makeDiscordGateway(agent, transport);

        yield* Effect.raceFirst(
          gateway.runLoop(
            { path: "/tmp/ziggy-discord-command-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(completed),
        );
      }),
    );

    expect(responses).toEqual([
      {
        id: "status-interaction",
        text: "Ziggy is ready in this thread. Active: 0 · queued: 0.",
      },
      { id: "stop-interaction", text: "Nothing was running in this conversation." },
    ]);
    expect(openChatCalls).toBe(0);
  });

  test("admits file-only owner messages and prepares bounded Discord images", async () => {
    const admitted = normalizeDiscordMessage(
      message({
        content: "",
        attachments: [
          {
            id: "a1",
            filename: "photo\nname.png",
            mimeType: "image/png",
            size: 3,
            url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
          },
          {
            id: "a2",
            filename: "notes.txt",
            mimeType: "text/plain",
            size: 4,
            url: "https://cdn.discordapp.com/attachments/1/2/notes.txt",
          },
        ],
        omittedAttachmentCount: 2,
      }),
      "123",
    );
    expect(admitted).toBeDefined();
    if (admitted === undefined) return;
    const resolvedIds: Array<string> = [];
    const prepared = await Effect.runPromise(
      prepareDiscordAttachmentPrompt(
        {
          ...admitted,
          chatKey: "user-123",
          context: { kind: "user", userId: "owner" },
        },
        (attachment) =>
          Effect.sync(() => {
            resolvedIds.push(attachment.id);
            return { type: "image", data: "AQID", mimeType: "image/png" } as const;
          }),
      ),
    );

    expect(resolvedIds).toEqual(["a1"]);
    expect(prepared.images).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
    expect(prepared.text).toContain('name="photo name.png"');
    expect(prepared.text).toContain("unsupported image type");
    expect(prepared.text).toContain("2 additional attachments unavailable");
    expect(prepared.text).toContain("Please inspect the available Discord attachment(s).");
  });

  test("hands a downloaded Discord image to the typed Pi prompt", async () => {
    let promptText = "";
    let promptImages: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        let nextCall = 0;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            nextCall += 1;
            return nextCall === 1
              ? Effect.succeed(
                  message({
                    content: "",
                    attachments: [
                      {
                        id: "a1",
                        filename: "photo.png",
                        mimeType: "image/png",
                        size: 3,
                        url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
                      },
                    ],
                  }),
                )
              : Effect.never;
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: () => Effect.succeed({ id: "placeholder" }),
          updateMessage: () => Effect.void,
          downloadAttachment: () =>
            Effect.succeed({ type: "image", data: "AQID", mimeType: "image/png" }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({
                prompt: (text, options) =>
                  Effect.sync(() => {
                    promptText = text;
                    promptImages = options?.images ?? [];
                    return "image received";
                  }),
                dispose: Effect.void,
              }),
            ),
        };
        const gateway = makeDiscordGateway(agent, transport, {
          now: () => 100,
          waitForHeartbeat: Effect.never,
          write: (_profilePath, snapshot) =>
            snapshot.completedTurnCount === 1
              ? Deferred.succeed(completed, undefined)
              : Effect.void,
        });

        yield* Effect.raceFirst(
          gateway.runLoop(
            { path: "/tmp/ziggy-discord-image-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(completed),
        );
      }),
    );

    expect(promptText).toContain("Please inspect the available Discord attachment(s).");
    expect(promptImages).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
  });

  test("keeps thread sessions distinct while sharing parent-channel group memory", () => {
    const admitted = normalizeDiscordMessage(message({ guildId: "789" }), "123");
    expect(admitted).toBeDefined();
    if (admitted === undefined) return;
    expect(discordThreadConversation(admitted, "thread-1", "456")).toEqual({
      messageId: "m1",
      channelId: "thread-1",
      sourceChannelId: "456",
      guildId: "789",
      authorId: "123",
      chatKey: "group-dc456-thread-thread-1",
      context: { kind: "group", groupId: "dc456" },
      text: "hello",
    });
  });

  test("chunks by Unicode code point at Discord's limit", () => {
    const chunks = discordMessageChunks("🦆".repeat(2_001));
    expect(chunks.map((chunk) => [...chunk].length)).toEqual([2_000, 1]);
  });

  test("bounds idempotent retries and never retries an ambiguous POST", async () => {
    const failure = (operation: "createMessage" | "updateMessage") =>
      new DiscordApiError({
        operation,
        reason: "server",
        retriable: true,
        message: "accepted request response lost",
        cause: { message: "connection closed" },
      });
    let updateAttempts = 0;
    const delays: Array<number> = [];
    const update = await Effect.runPromise(
      retryDiscordDelivery(
        "idempotent",
        () => {
          updateAttempts += 1;
          return Effect.fail(failure("updateMessage"));
        },
        (seconds) => Effect.sync(() => delays.push(seconds)),
      ).pipe(Effect.result),
    );
    let postAttempts = 0;
    const post = await Effect.runPromise(
      retryDiscordDelivery(
        "post",
        () => {
          postAttempts += 1;
          return Effect.fail(failure("createMessage"));
        },
        () => Effect.void,
      ).pipe(Effect.result),
    );

    expect(Result.isFailure(update) && update.failure.reason).toBe("server");
    expect(updateAttempts).toBe(4);
    expect(delays).toEqual([1, 2, 4]);
    expect(Result.isFailure(post) && post.failure.reason).toBe("server");
    expect(postAttempts).toBe(1);
    expect(discordIngressTerminalState(true, true)).toBe("unknown");
    expect(discordIngressTerminalState(true, false)).toBe("unknown");
  });

  test("does not repeat native thread creation when Discord loses the accepted response", async () => {
    let threadAttempts = 0;
    let openChatCalls = 0;

    await Effect.runPromise(
      Effect.gen(function* () {
        const diagnosticSent = yield* Deferred.make<void>();
        let delivered = false;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            if (delivered) return Effect.never;
            delivered = true;
            return Effect.succeed(message({ guildId: "guild", channelId: "root" }));
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => Effect.succeed({ id: "root", type: 0 }),
          startThreadFromMessage: () => {
            threadAttempts += 1;
            return Effect.fail(
              new DiscordApiError({
                operation: "startThreadFromMessage",
                reason: "network",
                retriable: true,
                message: "accepted request response lost",
                cause: { message: "connection closed after write" },
              }),
            );
          },
          createMessage: () =>
            Deferred.succeed(diagnosticSent, undefined).pipe(Effect.as({ id: "diagnostic" })),
          updateMessage: () => Effect.void,
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () => {
            openChatCalls += 1;
            return Effect.succeed(
              makeChatHandle({ prompt: () => Effect.succeed("reply"), dispose: Effect.void }),
            );
          },
        };

        yield* Effect.raceFirst(
          makeDiscordGateway(agent, transport).runLoop(
            { path: "/tmp/ziggy-discord-thread-response-loss-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(diagnosticSent),
        );
      }),
    );

    expect(threadAttempts).toBe(1);
    expect(openChatCalls).toBe(0);
  });

  test("bounds visible progress by time and meaningful growth", () => {
    const previous = { atMs: 1_000, text: "" };
    expect(shouldUpdateDiscordProgress(previous, "short", 3_000)).toBe(false);
    expect(shouldUpdateDiscordProgress(previous, "x".repeat(48), 2_499)).toBe(false);
    expect(shouldUpdateDiscordProgress(previous, "x".repeat(48), 2_500)).toBe(true);
  });

  test("runs an authorized DM through the agent and finalizes cleanly", async () => {
    const events: Array<string> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const replied = yield* Deferred.make<void>();
        let nextCall = 0;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            nextCall += 1;
            events.push("next");
            return nextCall === 1 ? Effect.succeed(message()) : Effect.never;
          }),
          nextConnectionState: Effect.never,
          close: Effect.sync(() => {
            events.push("close");
          }),
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: (token, intents) =>
            Effect.sync(() => {
              events.push(`openSocket:${token}:${intents}`);
              return socket;
            }),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: (token, channelId, text) =>
            Effect.sync(() => {
              events.push(`createMessage:${token}:${channelId}:${text}`);
              return { id: "placeholder" };
            }),
          updateMessage: (token, channelId, messageId, text) =>
            Effect.sync(() => {
              events.push(`updateMessage:${token}:${channelId}:${messageId}:${text}`);
            }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: (target, context, sessionDirectory) =>
            Effect.sync(() => {
              events.push(`openChat:${target.name}:${JSON.stringify(context)}:${sessionDirectory}`);
              return makeChatHandle({
                prompt: (text: string) =>
                  Effect.sync(() => {
                    events.push(`prompt:${text}`);
                    return "hello back";
                  }),
                dispose: Effect.sync(() => {
                  events.push("dispose");
                }),
              });
            }),
        };
        const gateway = makeDiscordGateway(agent, transport, {
          now: () => 100,
          waitForHeartbeat: Effect.never,
          write: (_profilePath, snapshot) =>
            snapshot.completedTurnCount === 1 ? Deferred.succeed(replied, undefined) : Effect.void,
        });
        const target = { path: "/tmp/ziggy-discord-test", name: "Test" };
        const config = { botToken: "token", ownerUserId: "123" };

        yield* Effect.raceFirst(gateway.runLoop(target, config), Deferred.await(replied));
      }),
    );

    expect(events).toEqual([
      "openSocket:token:37377",
      "next",
      "next",
      "createMessage:token:456:Working on that…",
      'openChat:Test:{"kind":"user","userId":"owner"}:/tmp/ziggy-discord-test/sessions/discord/user-123',
      "prompt:hello",
      "updateMessage:token:456:placeholder:hello back",
      "close",
      "dispose",
    ]);
  });

  test("posts specialist voices then still delivers the parent reply", async () => {
    const posts: Array<string> = [];
    const updates: Array<string> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const replied = yield* Deferred.make<void>();
        let nextCall = 0;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            nextCall += 1;
            return nextCall === 1 ? Effect.succeed(message()) : Effect.never;
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: (_token, _channelId, text) =>
            Effect.sync(() => {
              posts.push(text);
              return { id: `msg-${posts.length}` };
            }),
          updateMessage: (_token, _channelId, _messageId, text) =>
            Effect.sync(() => {
              updates.push(text);
            }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({
                prompt: (_text, options) => {
                  options?.onProgress?.({
                    kind: "voice",
                    agentId: "alpha",
                    text: "first look",
                  });
                  options?.onProgress?.({
                    kind: "voice",
                    agentId: "beta",
                    text: "second look",
                  });
                  return Effect.succeed("parent wrap");
                },
                dispose: Effect.void,
              }),
            ),
        };
        const gateway = makeDiscordGateway(agent, transport, {
          now: () => 100,
          waitForHeartbeat: Effect.never,
          write: (_profilePath, snapshot) =>
            snapshot.completedTurnCount === 1 ? Deferred.succeed(replied, undefined) : Effect.void,
        });

        yield* Effect.raceFirst(
          gateway.runLoop(
            { path: "/tmp/ziggy-discord-voice-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(replied),
        );
      }),
    );

    expect(posts).toContain(formatSpecialistVoice("alpha", "first look"));
    expect(posts).toContain(formatSpecialistVoice("beta", "second look"));
    expect(posts.some((text) => text.includes("**alpha:**"))).toBe(true);
    expect(posts.some((text) => text.includes("**beta:**"))).toBe(true);
    expect(updates).toContain("parent wrap");
    expect(updates.some((text) => text.includes("**alpha:**") || text.includes("**beta:**"))).toBe(
      false,
    );
  });

  test("uses source-message reactions and the native thread typing target", async () => {
    const feedback: Array<string> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const typingSeen = yield* Deferred.make<void>();
        const terminalReaction = yield* Deferred.make<void>();
        let terminalReactionAttempts = 0;
        let nextCall = 0;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            nextCall += 1;
            return nextCall === 1
              ? Effect.succeed(message({ guildId: "789", content: "thread request" }))
              : Effect.never;
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          openSocket: () => Effect.succeed(socket),
          getChannel: () =>
            Effect.succeed({ id: "456", type: 0, guild_id: "789", parent_id: null }),
          startThreadFromMessage: () =>
            Effect.succeed({ id: "thread-1", type: 11, guild_id: "789", parent_id: "456" }),
          createMessage: () => Effect.succeed({ id: "placeholder" }),
          updateMessage: () => Effect.void,
          triggerTyping: (token, channelId) =>
            Effect.sync(() => {
              feedback.push(`typing:${token}:${channelId}`);
            }).pipe(Effect.andThen(Deferred.succeed(typingSeen, undefined))),
          addReaction: (token, channelId, messageId, emoji) =>
            Effect.gen(function* () {
              feedback.push(`add:${token}:${channelId}:${messageId}:${emoji}`);
              if (emoji === "✅") {
                terminalReactionAttempts += 1;
                if (terminalReactionAttempts === 1) {
                  return yield* new DiscordApiError({
                    operation: "addReaction",
                    reason: "rate-limited",
                    retriable: true,
                    retryAfterSeconds: 0,
                    message: "fixture reaction rate limit",
                    cause: { fixture: true },
                  });
                }
                yield* Deferred.succeed(terminalReaction, undefined);
              }
            }),
          removeReaction: (token, channelId, messageId, emoji) =>
            Effect.sync(() => {
              feedback.push(`remove:${token}:${channelId}:${messageId}:${emoji}`);
            }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({
                prompt: () => Deferred.await(typingSeen).pipe(Effect.as("done")),
                dispose: Effect.void,
              }),
            ),
        };

        yield* Effect.raceFirst(
          makeDiscordGateway(agent, transport).runLoop(
            { path: "/tmp/ziggy-discord-feedback-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(terminalReaction),
        );
      }),
    );

    expect(feedback).toContain("add:token:456:m1:👀");
    expect(feedback).toContain("typing:token:thread-1");
    expect(feedback).toContain("remove:token:456:m1:👀");
    expect(feedback).toContain("add:token:456:m1:✅");
    expect(feedback.filter((event) => event === "add:token:456:m1:✅")).toHaveLength(2);
    expect(feedback.indexOf("remove:token:456:m1:👀")).toBeLessThan(
      feedback.indexOf("add:token:456:m1:✅"),
    );
  });

  test("creates one session per root thread and reuses it for thread follow-ups", async () => {
    const opened: Array<string> = [];
    const prompted: Array<string> = [];
    const startedThreads: Array<string> = [];
    const delivered: Array<string> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const complete = yield* Deferred.make<void>();
        const inbound = [
          message({ id: "m1", channelId: "456", guildId: "789", content: "first root" }),
          message({ id: "m2", channelId: "456", guildId: "789", content: "second root" }),
          message({ id: "m3", channelId: "m1", guildId: "789", content: "follow up" }),
        ];
        let placeholder = 0;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            const next = inbound.shift();
            return next === undefined ? Effect.never : Effect.succeed(next);
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: (_token, channelId) =>
            Effect.succeed(
              channelId === "456"
                ? { id: "456", type: 0, guild_id: "789", parent_id: null }
                : { id: channelId, type: 11, guild_id: "789", parent_id: "456" },
            ),
          startThreadFromMessage: (_token, channelId, messageId) =>
            Effect.sync(() => {
              startedThreads.push(`${channelId}:${messageId}`);
              return { id: messageId, type: 11, guild_id: "789", parent_id: channelId };
            }),
          createMessage: (_token, channelId) =>
            Effect.sync(() => ({ id: `p${++placeholder}-${channelId}` })),
          updateMessage: (_token, channelId, _messageId, text) =>
            Effect.gen(function* () {
              if (text.startsWith("reply:")) {
                delivered.push(`${channelId}:${text}`);
                if (delivered.length === 3) yield* Deferred.succeed(complete, undefined);
              }
            }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: (_target, _context, sessionDirectory) =>
            Effect.sync(() => {
              opened.push(sessionDirectory);
              return makeChatHandle({
                prompt: (text: string) =>
                  Effect.sync(() => {
                    prompted.push(`${sessionDirectory}:${text}`);
                    return `reply:${text}`;
                  }),
                dispose: Effect.void,
              });
            }),
        };

        yield* Effect.raceFirst(
          makeDiscordGateway(agent, transport).runLoop(
            { path: "/tmp/ziggy-discord-thread-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(complete),
        );
      }),
    );

    expect(startedThreads.sort()).toEqual(["456:m1", "456:m2"]);
    expect(opened.sort()).toEqual([
      "/tmp/ziggy-discord-thread-test/sessions/discord/group-dc456-thread-m1",
      "/tmp/ziggy-discord-thread-test/sessions/discord/group-dc456-thread-m2",
    ]);
    expect(prompted).toContain(
      "/tmp/ziggy-discord-thread-test/sessions/discord/group-dc456-thread-m1:first root",
    );
    expect(prompted).toContain(
      "/tmp/ziggy-discord-thread-test/sessions/discord/group-dc456-thread-m1:follow up",
    );
    expect(delivered.sort()).toEqual([
      "m1:reply:first root",
      "m1:reply:follow up",
      "m2:reply:second root",
    ]);
  });

  test("cancels active and queued work, settles health, and fences late completion", async () => {
    const visible: Array<string> = [];
    let aborted = 0;
    let finalHealth:
      | {
          readonly activeTurnCount: number;
          readonly queuedTurnCount: number;
          readonly cancelledTurnCount: number;
        }
      | undefined;

    await Effect.runPromise(
      Effect.gen(function* () {
        const promptStarted = yield* Deferred.make<void>();
        const queuedVisible = yield* Deferred.make<void>();
        const healthSettled = yield* Deferred.make<void>();
        let nextCall = 0;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            nextCall += 1;
            if (nextCall === 1) return Effect.succeed(message({ content: "long request" }));
            if (nextCall === 2) {
              return Deferred.await(promptStarted).pipe(
                Effect.as(message({ id: "m2", content: "queued request" })),
              );
            }
            if (nextCall === 3) {
              return Deferred.await(queuedVisible).pipe(
                Effect.as(message({ id: "m3", content: "stop" })),
              );
            }
            return Effect.never;
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: (_token, _channelId, text) =>
            Effect.gen(function* () {
              visible.push(text);
              if (text === "Queued behind an earlier request…") {
                yield* Deferred.succeed(queuedVisible, undefined);
              }
              return { id: `p${visible.length}` };
            }),
          updateMessage: (_token, _channelId, _messageId, text) =>
            Effect.sync(() => {
              visible.push(text);
            }),
          addReaction: (_token, _channelId, _messageId, emoji) =>
            Effect.sync(() => {
              visible.push(`reaction:add:${emoji}`);
            }),
          removeReaction: (_token, _channelId, _messageId, emoji) =>
            Effect.sync(() => {
              visible.push(`reaction:remove:${emoji}`);
            }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({
                prompt: () =>
                  Deferred.succeed(promptStarted, undefined).pipe(Effect.andThen(Effect.never)),
                abort: Effect.sync(() => {
                  aborted += 1;
                }),
                dispose: Effect.void,
              }),
            ),
        };

        const gateway = makeDiscordGateway(agent, transport, {
          now: () => 100,
          waitForHeartbeat: Effect.never,
          write: (_profilePath, snapshot) =>
            Effect.sync(() => {
              finalHealth = snapshot;
            }).pipe(
              Effect.andThen(
                snapshot.cancelledTurnCount === 2
                  ? Deferred.succeed(healthSettled, undefined)
                  : Effect.void,
              ),
            ),
        });

        yield* Effect.raceFirst(
          gateway.runLoop(
            { path: "/tmp/ziggy-discord-stop-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(healthSettled),
        );
      }),
    );

    expect(visible).toContain("Working on that…");
    expect(visible).toContain("Queued behind an earlier request…");
    expect(visible).toContain("Stopped.");
    expect(visible).toContain("Stopped 2 requests.");
    expect(visible).toContain("reaction:add:👀");
    expect(visible).toContain("reaction:remove:👀");
    expect(visible).toContain("reaction:add:🛑");
    expect(visible).toContain("reaction:add:✅");
    expect(visible.some((text) => text.includes("late reply"))).toBe(false);
    expect(aborted).toBe(1);
    expect(finalHealth).toMatchObject({
      activeTurnCount: 0,
      queuedTurnCount: 0,
      cancelledTurnCount: 2,
    });
  });

  test("shows queued work, then promotes it to working before the second prompt", async () => {
    const visible: Array<string> = [];
    const prompts: Array<string> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const complete = yield* Deferred.make<void>();
        let nextCall = 0;
        let finalCount = 0;
        let placeholderCount = 0;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            nextCall += 1;
            if (nextCall === 1) return Effect.succeed(message({ content: "first" }));
            if (nextCall === 2) {
              return Deferred.await(firstStarted).pipe(
                Effect.as(message({ id: "m2", content: "second" })),
              );
            }
            return Effect.never;
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: (_token, _channelId, text) =>
            Effect.gen(function* () {
              visible.push(`create:${text}`);
              if (text === "Queued behind an earlier request…") {
                yield* Deferred.succeed(releaseFirst, undefined);
              }
              placeholderCount += 1;
              return { id: `p${placeholderCount}` };
            }),
          updateMessage: (_token, _channelId, messageId, text) =>
            Effect.gen(function* () {
              visible.push(`update:${messageId}:${text}`);
              if (text.startsWith("reply:")) {
                finalCount += 1;
                if (finalCount === 2) yield* Deferred.succeed(complete, undefined);
              }
            }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({
                prompt: (text: string) =>
                  Effect.gen(function* () {
                    prompts.push(text);
                    if (text === "first") {
                      yield* Deferred.succeed(firstStarted, undefined);
                      yield* Deferred.await(releaseFirst);
                    }
                    return `reply:${text}`;
                  }),
                dispose: Effect.void,
              }),
            ),
        };

        yield* Effect.raceFirst(
          makeDiscordGateway(agent, transport).runLoop(
            { path: "/tmp/ziggy-discord-queue-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(complete),
        );
      }),
    );

    expect(prompts).toEqual(["first", "second"]);
    expect(visible).toContain("create:Working on that…");
    expect(visible).toContain("create:Queued behind an earlier request…");
    expect(visible).toContain("update:p2:Working on that…");
    expect(visible).toContain("update:p1:reply:first");
    expect(visible).toContain("update:p2:reply:second");
  });

  test("deduplicates Discord source messages before Pi and settles the owned row", async () => {
    const prompted: Array<string> = [];
    const admissions: Array<string> = [];
    let admitted = false;
    let finishedState: DiscordIngressTerminalState | undefined;

    await Effect.runPromise(
      Effect.gen(function* () {
        const finished = yield* Deferred.make<void>();
        let nextCall = 0;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            nextCall += 1;
            return nextCall <= 2 ? Effect.succeed(message()) : Effect.never;
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: () => Effect.succeed({ id: "placeholder" }),
          updateMessage: () => Effect.void,
        };
        const ingress: DiscordIngressRuntime = {
          initialize: () => Effect.void,
          recover: () => Effect.void,
          readReplayable: () => Effect.succeed([]),
          admit: (_profilePath, payload) =>
            Effect.sync(() => {
              admissions.push(payload.messageId);
              if (admitted) return "duplicate" as const;
              admitted = true;
              return "accepted" as const;
            }),
          start: () => Effect.succeed(true),
          requeue: () => Effect.void,
          finish: (_profilePath, _payload, _ownerId, state) =>
            Effect.sync(() => {
              finishedState = state;
            }).pipe(Effect.andThen(Deferred.succeed(finished, undefined))),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({
                prompt: (text) =>
                  Effect.sync(() => {
                    prompted.push(text);
                    return "reply";
                  }),
                dispose: Effect.void,
              }),
            ),
        };

        yield* Effect.raceFirst(
          makeDiscordGateway(agent, transport, undefined, ingress).runLoop(
            { path: "/tmp/ziggy-discord-dedupe-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(finished),
        );
      }),
    );

    expect(admissions).toEqual(["m1", "m1"]);
    expect(prompted).toEqual(["hello"]);
    expect(finishedState).toBe("completed");
  });

  test("settles an accepted POST with a lost response as unknown without replaying it", async () => {
    let postAttempts = 0;
    let promptCalls = 0;
    let finishedState: DiscordIngressTerminalState | undefined;

    await Effect.runPromise(
      Effect.gen(function* () {
        const finished = yield* Deferred.make<void>();
        let delivered = false;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            if (delivered) return Effect.never;
            delivered = true;
            return Effect.succeed(message());
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const responseLost = new DiscordApiError({
          operation: "createMessage",
          reason: "network",
          retriable: true,
          message: "accepted request response lost",
          cause: { message: "connection closed after write" },
        });
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: () =>
            Effect.sync(() => {
              postAttempts += 1;
            }).pipe(Effect.andThen(Effect.fail(responseLost))),
          updateMessage: () => Effect.void,
        };
        const ingress: DiscordIngressRuntime = {
          initialize: () => Effect.void,
          recover: () => Effect.void,
          readReplayable: () => Effect.succeed([]),
          admit: () => Effect.succeed("accepted"),
          start: () => Effect.succeed(true),
          requeue: () => Effect.void,
          finish: (_profilePath, _payload, _ownerId, state) =>
            Effect.sync(() => {
              finishedState = state;
            }).pipe(Effect.andThen(Deferred.succeed(finished, undefined))),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () => {
            promptCalls += 1;
            return Effect.succeed(
              makeChatHandle({ prompt: () => Effect.succeed("reply"), dispose: Effect.void }),
            );
          },
        };

        yield* Effect.raceFirst(
          makeDiscordGateway(agent, transport, undefined, ingress).runLoop(
            { path: "/tmp/ziggy-discord-response-loss-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(finished),
        );
      }),
    );

    expect(postAttempts).toBe(1);
    expect(promptCalls).toBe(0);
    expect(finishedState).toBe("unknown");
  });

  test("requeues unfinished durable work when the resident shuts down gracefully", async () => {
    const requeued: Array<DiscordIngressPayload> = [];
    const finishedStates: Array<DiscordIngressTerminalState> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const promptStarted = yield* Deferred.make<void>();
        let delivered = false;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            if (delivered) return Effect.never;
            delivered = true;
            return Effect.succeed(message());
          }),
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: () => Effect.succeed({ id: "placeholder" }),
          updateMessage: () => Effect.void,
        };
        const ingress: DiscordIngressRuntime = {
          initialize: () => Effect.void,
          recover: () => Effect.void,
          readReplayable: () => Effect.succeed([]),
          admit: () => Effect.succeed("accepted"),
          start: () => Effect.succeed(true),
          requeue: (_profilePath, payload) =>
            Effect.sync(() => {
              requeued.push(payload);
            }),
          finish: (_profilePath, _payload, _ownerId, state) =>
            Effect.sync(() => {
              finishedStates.push(state);
            }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({
                prompt: () =>
                  Deferred.succeed(promptStarted, undefined).pipe(Effect.andThen(Effect.never)),
                dispose: Effect.void,
              }),
            ),
        };

        const resident = yield* makeDiscordGateway(agent, transport, undefined, ingress)
          .runLoop(
            { path: "/tmp/ziggy-discord-graceful-restart-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(promptStarted);
        yield* Fiber.interrupt(resident);
      }),
    );

    expect(requeued.map((payload) => payload.messageId)).toEqual(["m1"]);
    expect(finishedStates).toEqual([]);
  });

  test("replays accepted Discord ingress before waiting for new socket messages", async () => {
    const lifecycle: Array<string> = [];
    const replay: DiscordIngressPayload = {
      messageId: "replay-1",
      sourceChannelId: "456",
      channelId: "456",
      authorId: "123",
      text: "recover this",
      chatKey: "user-123",
      context: { kind: "user", userId: "owner" },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const finished = yield* Deferred.make<void>();
        const socket: DiscordSocket = {
          next: Effect.never,
          nextConnectionState: Effect.never,
          close: Effect.void,
        };
        const transport: DiscordTransport = {
          ...silentDiscordFeedback,
          openSocket: () => Effect.succeed(socket),
          getChannel: () => unexpectedDiscordApiCall("getChannel"),
          startThreadFromMessage: () => unexpectedDiscordApiCall("startThreadFromMessage"),
          createMessage: () => Effect.succeed({ id: "placeholder" }),
          updateMessage: () => Effect.void,
        };
        const ingress: DiscordIngressRuntime = {
          initialize: () => Effect.sync(() => lifecycle.push("initialize")),
          recover: () => Effect.sync(() => lifecycle.push("recover")),
          readReplayable: () =>
            Effect.sync(() => {
              lifecycle.push("read");
              return [replay];
            }),
          admit: () =>
            Effect.sync(() => {
              lifecycle.push("unexpected-admit");
              return "duplicate" as const;
            }),
          start: (_profilePath, payload) =>
            Effect.sync(() => {
              lifecycle.push(`start:${payload.messageId}`);
              return true;
            }),
          requeue: () => Effect.void,
          finish: (_profilePath, payload, _ownerId, state) =>
            Effect.sync(() => {
              lifecycle.push(`finish:${payload.messageId}:${state}`);
            }).pipe(Effect.andThen(Deferred.succeed(finished, undefined))),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({
                prompt: (text) =>
                  Effect.sync(() => {
                    lifecycle.push(`prompt:${text}`);
                    return "recovered";
                  }),
                dispose: Effect.void,
              }),
            ),
        };

        yield* Effect.raceFirst(
          makeDiscordGateway(agent, transport, undefined, ingress).runLoop(
            { path: "/tmp/ziggy-discord-replay-test", name: "Test" },
            { botToken: "token", ownerUserId: "123" },
          ),
          Deferred.await(finished),
        );
      }),
    );

    expect(lifecycle).toEqual([
      "initialize",
      "recover",
      "read",
      "start:replay-1",
      "prompt:recover this",
      "finish:replay-1:completed",
    ]);
  });
});
