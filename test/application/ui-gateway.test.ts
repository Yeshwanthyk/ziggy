/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun's test callback API is Promise-shaped */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Deferred, Effect, Fiber, Result, Schema } from "effect";
import {
  makeChatHandle,
  type ChatEvent,
  type ChatSessionModelState,
  type ZiggyAgentApi,
} from "ziggy/application/agent";
import { SessionBusy, SessionHeld } from "ziggy/domain/agent";
import {
  CHAT_REPLAY_LIMIT,
  makeChatRegistry,
  type ChatRegistryApi,
} from "ziggy/application/chat-registry";
import type { SessionsApi } from "ziggy/application/sessions";
import type { ModelsApi } from "ziggy/application/models";
import type { AuthApi } from "ziggy/application/auth";
import type { ProfileAgentsApi } from "ziggy/application/profile-agents";
import { makeUiGateway } from "ziggy/application/ui-gateway";
import type { UiGroupStore } from "ziggy/adapters/fs/ui-state";
import { stableProfileId } from "ziggy/application/profile-directory";
import {
  ProfileExtensionPreflightFailed,
  type ProfileExtensionsApi,
} from "ziggy/domain/profile-extension";
import { ExtensionCatalogInstallFailed } from "ziggy/domain/extension-catalog";
import { SessionNotFound, SessionReadFailed } from "ziggy/domain/session";
import { ProfileAgentEditConflict } from "ziggy/domain/profile";
import {
  UiEventFrame,
  UiResponseFrame,
  UiSessionSummaryResult,
  type UiGroupRecord,
} from "ziggy/domain/ui-gateway";
import { UiGroupState, type UiGroupState as UiGroupStateValue } from "ziggy/domain/ui-state";

const target = { path: "/profile", name: "Profile" } as const;

const profileId = stableProfileId(target.path);

const repositoryRoot = "/repository";

const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(UiResponseFrame));

const decodeEventResult = Schema.decodeUnknownResult(Schema.fromJsonString(UiEventFrame));

const decodeSummaryResult = Schema.decodeUnknownSync(UiSessionSummaryResult);

const decodeEmptyGroupState = Schema.decodeUnknownSync(UiGroupState);

const makeProfileExtensions = (
  overrides: Partial<ProfileExtensionsApi> = {},
): ProfileExtensionsApi => ({
  list: () => Effect.never,
  show: () => Effect.never,
  listForProfile: () => Effect.succeed({ available: [], selected: [] }),
  add: (_target, _repositoryRoot, id) =>
    Effect.succeed({ id, profilePath: "/profile", changed: true, selected: true }),
  remove: (_target, _repositoryRoot, id) =>
    Effect.succeed({ id, profilePath: "/profile", changed: true, selected: false }),
  setSelected: () => Effect.never,
  validate: () =>
    Effect.succeed({
      selected: [],
      preflight: { extensionPathCount: 0, skillPathCount: 0, extensionFactoryCount: 0 },
    }),
  prepareRuntime: () => Effect.never,
  activateRuntime: () => Effect.never,
  ...overrides,
});

const makeSessions = (): SessionsApi => ({
  summaries: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
  show: (_target, reference) => Effect.fail(new SessionNotFound({ reference, message: "missing" })),
  resolve: (_target, reference) =>
    Effect.fail(new SessionNotFound({ reference, message: "missing" })),
});

const makeAgent = (
  handle: ReturnType<typeof makeChatHandle>,
  overrides: Partial<ZiggyAgentApi> = {},
): ZiggyAgentApi => ({
  runOnce: () => Effect.succeed(0),
  openChat: () => Effect.succeed(handle),
  openSpecialistChat: () => Effect.succeed(handle),
  runSpecialist: () =>
    Effect.succeed({ answer: "specialist answer", session: { id: "child", file: "child.jsonl" } }),
  ...overrides,
});

const makeProfileAgents = (overrides: Partial<ProfileAgentsApi> = {}): ProfileAgentsApi => ({
  create: () => Effect.never,
  list: () => Effect.never,
  show: () => Effect.never,
  document: () => Effect.never,
  save: () => Effect.never,
  validate: () => Effect.never,
  run: () => Effect.never,
  ...overrides,
});

interface TestConfigExtras {
  readonly groups?: UiGroupStore;
  readonly models?: ModelsApi;
  readonly sessions?: SessionsApi;
  readonly profileAgents?: ProfileAgentsApi;
  readonly auth?: AuthApi;
}

const makeConfig = (
  registry: ChatRegistryApi,
  agent: ZiggyAgentApi,
  profileExtensions = makeProfileExtensions(),
  extra: TestConfigExtras = {},
) => ({
  defaultProfile: { profileId, target, registry },
  repositoryRoot,
  sessions: makeSessions(),
  agent,
  profileExtensions,
  extensionHealth: (_path: string, root: string, extensions: ProfileExtensionsApi) =>
    extensions
      .listForProfile(target.path, root)
      .pipe(Effect.map((listing) => ({ listing, skipped: [] }))),
  ...extra,
});

test("session.open refuses a held writer with a plain session_busy error", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];

  const agent = makeAgent(makeChatHandle({ prompt: () => Effect.succeed("") }), {
    openChat: () => Effect.fail(new SessionHeld({ profilePath: "/secret", message: "held" })),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(makeConfig(registry, agent))).connect((frame) =>
          responses.push(decodeResponse(frame)),
        );

        yield* connection.request({
          id: "held",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });
      }),
    ),
  );

  expect(responses).toMatchObject([{ id: "held", ok: false, error: { code: "session_busy" } }]);
  expect(JSON.stringify(responses)).not.toContain("/secret");
});

test("UI gateway opens local Pi sessions, emits sequenced events, and detaches on close", async () => {
  const sent: string[] = [];
  const listeners = new Set<(event: ChatEvent) => void>();

  let opened:
    | { readonly directory: string; readonly mode: string | undefined; readonly context: string }
    | undefined;

  const handle = makeChatHandle({
    prompt: (text) =>
      Effect.sync(() => {
        for (const listener of listeners) {
          listener({ kind: "assistant-text", delta: text, snapshot: text });
          listener({ kind: "settled" });
        }

        return text;
      }),
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  });

  const agent = makeAgent(handle, {
    openChat: (_target, context, directory, mode) => {
      opened = { directory, mode, context: context.kind };

      return Effect.succeed(handle);
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(makeConfig(registry, agent))).connect((frame) =>
          sent.push(frame),
        );

        yield* connection.request({
          id: "1",
          method: "session.open",
          params: { profileId, context: { kind: "local" }, name: "main" },
        });
        expect(opened).toEqual({
          directory: "/profile/sessions/ui/main",
          mode: "continue",
          context: "local",
        });
        expect(decodeResponse(sent[0] ?? "null")).toEqual({
          id: "1",
          ok: true,
          result: { ref: { profileId, kind: "live", key: "ui/main" } },
        });

        yield* connection.request({
          id: "show",
          method: "session.show",
          params: { ref: { profileId, kind: "live", key: "ui/main" } },
        });
        expect(decodeResponse(sent[1] ?? "null")).toEqual({
          id: "show",
          ok: true,
          result: {
            profileId,
            ref: { profileId, kind: "live", key: "ui/main" },
            kind: "live",
            live: {
              ref: { profileId, kind: "live", key: "ui/main" },
              kind: "ui",
              idle: true,
              context: { kind: "local" },
            },
          },
        });

        yield* connection.request({
          id: "2",
          method: "prompt.submit",
          params: { ref: { profileId, kind: "live", key: "ui/main" }, text: "hello" },
        });
        yield* Effect.yieldNow;

        const events = sent.flatMap((frame) => {
          const decoded = decodeEventResult(frame);

          return Result.isSuccess(decoded) ? [decoded.success] : [];
        });

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
          profileId,
          session: { profileId, kind: "live", key: "ui/main" },
          epoch: expect.any(String),
          seq: 1,
          eventId: expect.any(String),
          event: "assistant-text",
          payload: { delta: "hello", snapshot: "hello" },
        });
        expect(events[1]).toMatchObject({ seq: 2, event: "settled" });

        const beforeClose = sent.length;
        yield* connection.close;

        for (const listener of listeners) listener({ kind: "settled" });
        expect(sent).toHaveLength(beforeClose);
        expect((yield* registry.get("ui/main")).handle).toBe(handle);
      }),
    ),
  );
});

test("live session history resolves the handle's current transcript identity at request time", async () => {
  const sent: string[] = [];
  const historyReferences: string[] = [];
  let currentId = "pi-session-a";

  const handle = makeChatHandle({
    currentSession: Effect.sync(() => ({ id: currentId, file: `/private/${currentId}.jsonl` })),
    prompt: () => Effect.succeed("ok"),
  });

  const sessions: SessionsApi = {
    ...makeSessions(),
    history: (_target, reference) =>
      Effect.sync(() => {
        historyReferences.push(reference);

        return {
          entries: [
            {
              kind: "assistant" as const,
              timestamp: "2026-09-15T12:00:00.000Z",
              text: reference,
            },
          ],
          terminalState: "completed" as const,
          truncated: false,
          hasMore: false,
        };
      }),
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), makeProfileExtensions(), { sessions }),
        )).connect((frame) => sent.push(frame));

        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });
        yield* connection.request({
          id: "history-a",
          method: "session.history",
          params: { ref: { profileId, kind: "live", key: "local/main" } },
        });
        currentId = "pi-session-b";
        yield* connection.request({
          id: "history-b",
          method: "session.history",
          params: { ref: { profileId, kind: "live", key: "local/main" } },
        });

        expect(historyReferences).toEqual(["pi-session-a", "pi-session-b"]);
        expect(decodeResponse(sent.at(-2) ?? "null")).toMatchObject({
          id: "history-a",
          ok: true,
          result: { entries: [{ text: "pi-session-a" }] },
        });
        expect(decodeResponse(sent.at(-1) ?? "null")).toMatchObject({
          id: "history-b",
          ok: true,
          result: { entries: [{ text: "pi-session-b" }] },
        });
      }),
    ),
  );
});

test("live session history is empty only while its Pi transcript is not materialized", async () => {
  const sent: string[] = [];
  let historyCalls = 0;

  const handle = makeChatHandle({
    currentSession: Effect.succeed(undefined),
    prompt: () => Effect.succeed("ok"),
  });

  const sessions: SessionsApi = {
    ...makeSessions(),
    history: () =>
      Effect.sync(() => {
        historyCalls += 1;

        return {
          entries: [],
          terminalState: "incomplete" as const,
          truncated: false,
          hasMore: false,
        };
      }),
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), makeProfileExtensions(), { sessions }),
        )).connect((frame) => sent.push(frame));

        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });
        yield* connection.request({
          id: "history",
          method: "session.history",
          params: { ref: { profileId, kind: "live", key: "local/main" } },
        });

        expect(historyCalls).toBe(0);
        expect(decodeResponse(sent.at(-1) ?? "null")).toEqual({
          id: "history",
          ok: true,
          result: {
            profileId,
            ref: { profileId, kind: "live", key: "local/main" },
            entries: [],
            terminalState: "incomplete",
            truncated: false,
            hasMore: false,
          },
        });
        yield* connection.request({
          id: "stale-history",
          method: "session.history",
          params: {
            ref: { profileId, kind: "live", key: "local/main" },
            before: "cursor-from-a-materialized-session",
          },
        });
        expect(decodeResponse(sent.at(-1) ?? "null")).toEqual({
          id: "stale-history",
          ok: false,
          error: { code: "stale_cursor", message: "session history cursor is stale" },
        });
      }),
    ),
  );
});

test("live session history preserves transcript read failures without exposing its path", async () => {
  const sent: string[] = [];

  const handle = makeChatHandle({
    currentSession: Effect.succeed({ id: "pi-session", file: "/private/pi-session.jsonl" }),
    prompt: () => Effect.succeed("ok"),
  });

  const sessions: SessionsApi = {
    ...makeSessions(),
    history: () =>
      Effect.fail(
        new SessionReadFailed({
          path: "/private/pi-session.jsonl",
          operation: "read",
          message: "sensitive read failure",
          cause: { code: "EACCES", message: "permission denied" },
        }),
      ),
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), makeProfileExtensions(), { sessions }),
        )).connect((frame) => sent.push(frame));

        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });
        yield* connection.request({
          id: "history",
          method: "session.history",
          params: { ref: { profileId, kind: "live", key: "local/main" } },
        });

        expect(decodeResponse(sent.at(-1) ?? "null")).toEqual({
          id: "history",
          ok: false,
          error: { code: "internal", message: "session.history failed" },
        });
        expect(sent.at(-1)).not.toContain("/private/");
      }),
    ),
  );
});

test("UI gateway uses sequenced replay and reports epoch/replay gaps", async () => {
  const listeners = new Set<(event: ChatEvent) => void>();

  const handle = makeChatHandle({
    prompt: () => Effect.succeed("ok"),
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  });

  const events: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();
        const gateway = yield* makeUiGateway(makeConfig(registry, makeAgent(handle)));
        const first = gateway.connect((frame) => events.push(frame));
        yield* first.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" }, name: "main" },
        });

        for (const listener of listeners)
          listener({ kind: "assistant-text", delta: "one", snapshot: "one" });

        const firstEvent = events
          .map((frame) => decodeEventResult(frame))
          .flatMap((result) => (Result.isSuccess(result) ? [result.success] : []))[0];

        expect(firstEvent).toBeDefined();
        yield* first.close;

        const replayed: string[] = [];
        const second = gateway.connect((frame) => replayed.push(frame));

        const watchParams =
          firstEvent?.epoch === undefined
            ? { ref: { profileId, kind: "live" as const, key: "ui/main" }, afterSeq: 0 }
            : {
                ref: { profileId, kind: "live" as const, key: "ui/main" },
                afterSeq: 0,
                epoch: firstEvent.epoch,
              };

        yield* second.request({
          id: "watch",
          method: "session.watch",
          params: watchParams,
        });
        expect(
          replayed.some((frame) => {
            const decoded = decodeEventResult(frame);

            return Result.isSuccess(decoded) && decoded.success.seq === 1;
          }),
        ).toBe(true);

        const restarted: (typeof UiResponseFrame.Type)[] = [];

        const third = (yield* makeUiGateway(makeConfig(registry, makeAgent(handle)))).connect(
          (frame) => restarted.push(decodeResponse(frame)),
        );

        yield* third.request({
          id: "restart",
          method: "session.watch",
          params: {
            ref: { profileId, kind: "live", key: "ui/main" },
            afterSeq: 1,
            epoch: "old-epoch",
          },
        });
        expect(restarted.at(-1)).toMatchObject({ ok: false, error: { code: "replay_gap" } });
      }),
    ),
  );
});

test("rolled replay windows allow fresh opens and watches without losing history or subscriptions", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const handle = makeChatHandle({
          prompt: () => Effect.succeed("ok"),
          currentSession: Effect.succeed({ id: "durable-session", file: "/private/session.jsonl" }),
        });

        let opens = 0;

        const agent = makeAgent(handle, {
          openChat: () =>
            Effect.sync(() => {
              opens += 1;

              return handle;
            }),
        });

        const historyEntries = [
          {
            kind: "assistant" as const,
            timestamp: "2026-09-16T12:00:00Z",
            text: "Durable history",
          },
        ];

        const sessions: SessionsApi = {
          ...makeSessions(),
          history: (_target, reference) =>
            Effect.sync(() => {
              expect(reference).toBe("durable-session");

              return {
                entries: historyEntries,
                terminalState: "completed" as const,
                truncated: false,
                hasMore: false,
              };
            }),
        };

        const gateway = yield* makeUiGateway(makeConfig(registry, agent, undefined, { sessions }));
        const frames: string[] = [];
        const connection = gateway.connect((frame) => frames.push(frame));
        const ref = { profileId, kind: "live" as const, key: "local/main" };
        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });

        for (let index = 0; index <= CHAT_REPLAY_LIMIT; index += 1) {
          yield* registry.publish("local/main", { kind: "settled" });
        }

        for (const method of ["session.open", "session.watch"] as const) {
          frames.length = 0;
          yield* connection.request({
            id: method,
            method,
            params: method === "session.open" ? { profileId, context: { kind: "local" } } : { ref },
          });
          expect(decodeResponse(frames.at(-1) ?? "null")).toMatchObject({ id: method, ok: true });

          const events = frames
            .map((frame) => decodeEventResult(frame))
            .filter(Result.isSuccess)
            .map((result) => result.success);

          expect(events).toHaveLength(CHAT_REPLAY_LIMIT);
          expect(events[0]?.seq).toBe(2);
          expect(events.at(-1)?.seq).toBe(CHAT_REPLAY_LIMIT + 1);
        }

        expect(opens).toBe(1);
        yield* connection.request({ id: "history", method: "session.history", params: { ref } });
        expect(decodeResponse(frames.at(-1) ?? "null")).toMatchObject({
          id: "history",
          ok: true,
          result: { entries: historyEntries },
        });

        for (const params of [
          { ref, afterSeq: 0 },
          { ref, afterSeq: CHAT_REPLAY_LIMIT + 1, epoch: "expired-epoch" },
        ]) {
          yield* connection.request({ id: "invalid-resume", method: "session.watch", params });
          expect(decodeResponse(frames.at(-1) ?? "null")).toMatchObject({
            ok: false,
            error: { code: "replay_gap" },
          });
        }

        frames.length = 0;
        yield* registry.publish("local/main", { kind: "settled" });
        expect(frames).toHaveLength(1);
        expect(decodeEventResult(frames[0] ?? "null")).toMatchObject({
          success: { seq: CHAT_REPLAY_LIMIT + 2 },
        });
        yield* connection.request({ id: "unwatch", method: "session.unwatch", params: { ref } });
        frames.length = 0;
        yield* registry.publish("local/main", { kind: "settled" });
        expect(frames).toEqual([]);
        yield* connection.request({ id: "rewatch", method: "session.watch", params: { ref } });
        yield* connection.close;
        frames.length = 0;
        yield* registry.publish("local/main", { kind: "settled" });
        expect(frames).toEqual([]);
      }),
    ),
  );
});

test("command retries preserve the current transport request id", async () => {
  const sent: string[] = [];
  let openCount = 0;
  const handle = makeChatHandle({ prompt: () => Effect.succeed("ok") });

  const agent = makeAgent(handle, {
    openChat: () => {
      openCount += 1;

      return Effect.succeed(handle);
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(makeConfig(registry, agent))).connect((frame) =>
          sent.push(frame),
        );

        const params = {
          profileId,
          context: { kind: "local" as const },
          name: "retry",
          commandId: "same-logical-command",
        };

        yield* connection.request({ id: "transport-1", method: "session.open", params });
        yield* connection.request({ id: "transport-2", method: "session.open", params });
      }),
    ),
  );

  expect(sent.map((frame) => decodeResponse(frame).id)).toEqual(["transport-1", "transport-2"]);
  expect(openCount).toBe(1);
});

test("a disconnected command owner does not interrupt another connection's agent run", async () => {
  const sent: string[] = [];
  let executions = 0;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        const agents = makeProfileAgents({
          run: () =>
            Effect.gen(function* () {
              executions++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);

              return { answer: "completed", session: { id: "child", file: "child.jsonl" } };
            }),
        });

        const gateway = yield* makeUiGateway(
          makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.succeed("ok") })),
            makeProfileExtensions(),
            { profileAgents: agents },
          ),
        );

        const first = gateway.connect(() => {});
        const second = gateway.connect((frame) => sent.push(frame));

        const params = {
          profileId,
          agentId: "researcher",
          task: "research",
          commandId: "same-run",
        };

        const owner = yield* Effect.forkChild(
          first.request({ id: "first", method: "agent.run", params }),
        );

        yield* Deferred.await(started);

        const waiter = yield* Effect.forkChild(
          second.request({ id: "second", method: "agent.run", params }),
        );

        yield* Effect.yieldNow;
        yield* first.close;
        yield* Fiber.interrupt(owner);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(waiter);
      }),
    ),
  );

  expect(executions).toBe(1);
  expect(sent.map((frame) => decodeResponse(frame))).toEqual([
    {
      id: "second",
      ok: true,
      result: { profileId, agentId: "researcher", answer: "completed", sessionId: "child" },
    },
  ]);
});

test("agent document/save preserves source, deduplicates command ids, and maps conflicts", async () => {
  const sent: string[] = [];
  const handle = makeChatHandle({ prompt: () => Effect.succeed("ok") });
  const source = "---\nversion: 1\ndescription: Researcher\n---\n\nResearch.\n";
  const edited = source.replace("Research.", "Research carefully.");
  let saveCount = 0;

  const profileAgents = makeProfileAgents({
    document: (_target, id) => Effect.succeed({ id, source }),
    save: (_target, id, expectedSource, nextSource) => {
      saveCount += 1;

      return expectedSource === source
        ? Effect.succeed({ id, source: nextSource })
        : Effect.fail(
            new ProfileAgentEditConflict({
              id,
              path: `/profile/agents/${id}.md`,
              message: "stale",
            }),
          );
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), makeProfileExtensions(), { profileAgents }),
        )).connect((frame) => sent.push(frame));

        yield* connection.request({
          id: "document",
          method: "agent.document",
          params: { profileId, agentId: "researcher" },
        });

        const saveParams = {
          profileId,
          agentId: "researcher",
          expectedSource: source,
          source: edited,
          commandId: "save-researcher-1",
        } as const;

        yield* connection.request({ id: "save-1", method: "agent.save", params: saveParams });
        yield* connection.request({ id: "save-2", method: "agent.save", params: saveParams });
        yield* connection.request({
          id: "conflict",
          method: "agent.save",
          params: {
            profileId,
            agentId: "researcher",
            expectedSource: "stale",
            source: edited,
          },
        });
      }),
    ),
  );

  expect(sent.map((frame) => decodeResponse(frame))).toEqual([
    { id: "document", ok: true, result: { profileId, id: "researcher", source } },
    { id: "save-1", ok: true, result: { profileId, id: "researcher", source: edited } },
    { id: "save-2", ok: true, result: { profileId, id: "researcher", source: edited } },
    {
      id: "conflict",
      ok: false,
      error: { code: "conflict", message: "the resource changed; reload before retrying" },
    },
  ]);
  expect(saveCount).toBe(2);
});

test("auth status retains configured providers beyond the sixteen-provider cap", async () => {
  const sent: string[] = [];
  const handle = makeChatHandle({ prompt: () => Effect.succeed("ok") });

  const unconfigured = Array.from({ length: 17 }, (_, index) => ({
    id: `provider-${String(index).padStart(2, "0")}`,
    name: `Provider ${String(index).padStart(2, "0")}`,
    supportsApiKeyLogin: true,
    ambientOnly: false,
    supportsOauth: false,
    configured: undefined,
  }));

  const configured = {
    id: "zulu-configured",
    name: "Zulu Configured",
    supportsApiKeyLogin: false,
    ambientOnly: false,
    supportsOauth: true,
    configured: { type: "oauth" as const },
  };

  const auth: AuthApi = {
    status: () => Effect.never,
    readOnlyStatus: () => Effect.succeed([...unconfigured, configured]),
    login: () => Effect.never,
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), makeProfileExtensions(), { auth }),
        )).connect((frame) => sent.push(frame));

        yield* connection.request({
          id: "auth",
          method: "auth.status",
          params: { profileId },
        });
      }),
    ),
  );

  expect(decodeResponse(sent[0] ?? "null")).toEqual({
    id: "auth",
    ok: true,
    result: {
      profileId,
      providers: [
        {
          id: "zulu-configured",
          name: "Zulu Configured",
          configured: true,
          type: "oauth",
          supportsApiKeyLogin: false,
          supportsOauth: true,
        },
        ...unconfigured.slice(0, 15).map((provider) => ({
          id: provider.id,
          name: provider.name,
          configured: false,
          supportsApiKeyLogin: true,
          supportsOauth: false,
        })),
      ],
    },
  });
});

test("reopening a session replaces its subscription instead of leaking listeners", async () => {
  const sent: string[] = [];
  const listeners = new Set<(event: ChatEvent) => void>();

  const handle = makeChatHandle({
    prompt: (text) =>
      Effect.sync(() => {
        for (const listener of listeners) {
          listener({ kind: "assistant-text", delta: text, snapshot: text });
          listener({ kind: "settled" });
        }

        return text;
      }),
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(makeConfig(registry, makeAgent(handle)))).connect(
          (frame) => sent.push(frame),
        );

        const params = { profileId, context: { kind: "local" as const }, name: "same" };
        yield* connection.request({ id: "open-1", method: "session.open", params });
        yield* connection.request({ id: "open-2", method: "session.open", params });
        yield* connection.request({
          id: "prompt",
          method: "prompt.submit",
          params: { ref: { profileId, kind: "live", key: "ui/same" }, text: "hello" },
        });
        yield* Effect.yieldNow;
      }),
    ),
  );

  const events = sent.flatMap((frame) => {
    const decoded = decodeEventResult(frame);

    return Result.isSuccess(decoded) ? [decoded.success] : [];
  });

  expect(events).toHaveLength(2);
});

test("returns a bounded internal frame when a successful result cannot be encoded", async () => {
  const oversizedSessions: SessionsApi = {
    ...makeSessions(),
    list: () =>
      Effect.succeed([
        {
          path: "local/oversized.jsonl",
          id: "x".repeat(300),
          kind: "root" as const,
          createdAt: "2026-08-30T00:00:00.000Z",
          entryCount: 0,
          parent: undefined,
          parentUnknown: false,
          children: [],
          modelChanges: [],
          thinkingChanges: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: 0,
          },
          terminalState: "incomplete" as const,
        },
      ]),
  };

  const sent: string[] = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.succeed("ok") })),
            makeProfileExtensions(),
            { sessions: oversizedSessions },
          ),
        )).connect((frame) => sent.push(frame));

        yield* connection.request({
          id: "list",
          method: "session.list",
          params: { profileId },
        });
      }),
    ),
  );

  expect(decodeResponse(sent[0] ?? "null")).toEqual({
    id: "list",
    ok: false,
    error: { code: "internal", message: "response could not be encoded" },
  });
});

test("specialist session.open uses local specialist Pi primitive, never a channel alias", async () => {
  const calls: string[] = [];
  const handle = makeChatHandle({ prompt: () => Effect.succeed("ok") });

  const agent = makeAgent(handle, {
    openChat: () => {
      calls.push("channel-or-host");

      return Effect.succeed(handle);
    },
    openSpecialistChat: (_target, agentId) => {
      calls.push(`specialist:${agentId}`);

      return Effect.succeed(handle);
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();
        yield* registry.registerAlias("slack/user-1", "slack", handle);

        const connection = (yield* makeUiGateway(makeConfig(registry, agent))).connect(
          () => undefined,
        );

        yield* connection.request({
          id: "specialist",
          method: "session.open",
          params: { profileId, context: { kind: "local" }, agentId: "researcher" },
        });
      }),
    ),
  );
  expect(calls).toEqual(["specialist:researcher"]);
});

test("group.list discovers persisted groups for the requested Profile", async () => {
  const persisted: UiGroupRecord = {
    groupId: "planning",
    conversationId: "ui/group-planning",
    hostProfileId: profileId,
    memberAgentIds: ["researcher", "writer"],
    defaultRecipient: { kind: "host" },
    revision: 2,
  };

  const groups: UiGroupStore = {
    read: () =>
      Effect.succeed({
        version: 1,
        groups: [persisted],
        commands: [],
      }),
    upsert: () => Effect.never,
    remove: () => Effect.never,
  };

  const sent: string[] = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.succeed("ok") })),
            makeProfileExtensions(),
            { groups },
          ),
        )).connect((frame) => sent.push(frame));

        yield* connection.request({
          id: "groups",
          method: "group.list",
          params: { profileId },
        });
      }),
    ),
  );

  expect(decodeResponse(sent[0] ?? "null")).toEqual({
    id: "groups",
    ok: true,
    result: { profileId, groups: [persisted] },
  });
});

test("group prompts run bounded specialist turns sequentially and synthesize through one host writer", async () => {
  const specialistCalls: Array<{ readonly agentId: string; readonly directory: string }> = [];
  const promptOptions: Array<unknown> = [];

  const handle = makeChatHandle({
    prompt: (text, options) =>
      Effect.sync(() => {
        promptOptions.push(options);

        return text;
      }),
  });

  const agent = makeAgent(handle, {
    runSpecialist: (profile, agentId, _task, context) => {
      specialistCalls.push({ agentId, directory: context.sessionDirectory });

      return Effect.succeed({
        answer: `${agentId} answer`,
        session: { id: `${agentId}-child`, file: `${agentId}.jsonl` },
      });
    },
  });

  let groupState: UiGroupStateValue = decodeEmptyGroupState({
    version: 1,
    groups: [],
    commands: [],
  });

  const groups: UiGroupStore = {
    read: () => Effect.succeed(groupState),
    upsert: (_path, group, _expectedRevision, commandId) =>
      Effect.sync(() => {
        const persisted: UiGroupRecord = { ...group, revision: group.revision + 1 };
        groupState = {
          ...groupState,
          groups: [persisted],
          commands: [
            ...groupState.commands,
            {
              commandId,
              fingerprint: JSON.stringify({ action: "upsert", group }),
              groupId: group.groupId,
              revision: persisted.revision,
            },
          ],
        };

        return groupState;
      }),
    remove: () => Effect.succeed(groupState),
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();
        const sent: string[] = [];

        const connection = (yield* makeUiGateway(
          makeConfig(registry, agent, makeProfileExtensions(), {
            groups,
          }),
        )).connect((frame) => sent.push(frame));

        const context = {
          kind: "group" as const,
          groupId: "planning",
          memberAgentIds: ["researcher", "writer"],
          defaultRecipient: { kind: "host" as const },
        };

        yield* connection.request({
          id: "empty-group",
          method: "session.open",
          params: {
            profileId,
            context: { kind: "group", groupId: "solo", memberAgentIds: [] },
          },
        });
        expect(decodeResponse(sent[0] ?? "null")).toMatchObject({
          id: "empty-group",
          ok: true,
        });
        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context },
        });

        const groupRef = {
          profileId,
          kind: "live" as const,
          key: `ui/group-${createHash("sha256").update("planning").digest("hex").slice(0, 32)}` as const,
        };

        yield* connection.request({
          id: "watch",
          method: "session.watch",
          params: { ref: groupRef },
        });
        yield* connection.request({
          id: "prompt",
          method: "prompt.submit",
          params: {
            ref: groupRef,
            text: "decide",
            recipient: { kind: "all" },
          },
        });
        yield* Effect.yieldNow;
        expect(specialistCalls).toHaveLength(2);
        expect(specialistCalls.map((call) => call.agentId)).toEqual(["researcher", "writer"]);
        expect(specialistCalls[0]?.directory).toContain("/sessions/groups/");
        expect(specialistCalls[0]?.directory).toContain("/agents/researcher");
        expect(promptOptions).toHaveLength(1);
        expect(promptOptions[0]).toMatchObject({
          ephemeralContext: expect.stringContaining("researcher"),
        });

        const firstVoices = sent
          .map((frame) => decodeEventResult(frame))
          .filter(Result.isSuccess)
          .map((result) => result.success)
          .filter((event) => event.event === "voice");

        expect(firstVoices.map((event) => event.payload.agentId)).toEqual(["researcher", "writer"]);
        yield* connection.request({
          id: "default-host",
          method: "prompt.submit",
          params: { ref: groupRef, text: "host only" },
        });
        expect(specialistCalls).toHaveLength(2);
        yield* connection.request({
          id: "addressed",
          method: "prompt.submit",
          params: {
            ref: groupRef,
            text: "research this",
            recipient: { kind: "agent", agentId: "researcher" },
          },
        });
        yield* Effect.yieldNow;
        expect(specialistCalls.map((call) => call.agentId)).toEqual([
          "researcher",
          "writer",
          "researcher",
        ]);

        const allVoices = sent
          .map((frame) => decodeEventResult(frame))
          .filter(Result.isSuccess)
          .map((result) => result.success)
          .filter((event) => event.event === "voice");

        expect(allVoices.map((event) => event.payload.agentId)).toEqual([
          "researcher",
          "writer",
          "researcher",
        ]);
        yield* connection.request({
          id: "non-member",
          method: "prompt.submit",
          params: {
            ref: groupRef,
            text: "intrude",
            recipient: { kind: "agent", agentId: "outsider" },
          },
        });
        expect(decodeResponse(sent.at(-1) ?? "")).toMatchObject({
          id: "non-member",
          ok: false,
          error: { code: "ownership" },
        });
        yield* connection.request({
          id: "duplicate-members",
          method: "session.open",
          params: {
            profileId,
            context: {
              kind: "group",
              groupId: "duplicates",
              memberAgentIds: ["researcher", "researcher"],
              defaultRecipient: { kind: "all" },
            },
          },
        });
        expect(decodeResponse(sent.at(-1) ?? "")).toMatchObject({
          id: "duplicate-members",
          ok: false,
          error: { code: "bad_params" },
        });
        expect(sent.some((frame) => decodeResponse(frame).ok)).toBe(true);
      }),
    ),
  );
});

test("UI gateway routes all management operations through decoded explicit Profile params", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];
  const calls: string[] = [];

  const profileExtensions = makeProfileExtensions({
    listForProfile: (profilePath, root) => {
      calls.push(`list:${profilePath}:${root}`);

      return Effect.succeed({
        available: [{ id: "weather", description: "Weather", kind: "skill", source: "bundled" }],
        selected: ["weather"],
      });
    },
    add: (profile, root, id) => {
      calls.push(`add:${profile.path}:${root}:${id}`);

      return Effect.succeed({ id, profilePath: profile.path, changed: true, selected: true });
    },
    remove: (profile, root, id) => {
      calls.push(`remove:${profile.path}:${root}:${id}`);

      return Effect.succeed({ id, profilePath: profile.path, changed: true, selected: false });
    },
    validate: (profile, root) => {
      calls.push(`validate:${profile.path}:${root}`);

      return Effect.succeed({
        selected: ["weather"],
        preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
      });
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.never })),
            profileExtensions,
          ),
        )).connect((frame) => responses.push(decodeResponse(frame)));

        yield* connection.request({
          id: "1",
          method: "extension.list-for-profile",
          params: { profileId },
        });
        yield* connection.request({
          id: "2",
          method: "extension.add",
          params: { profileId, id: "weather" },
        });
        yield* connection.request({
          id: "3",
          method: "extension.remove",
          params: { profileId, id: "weather" },
        });
        yield* connection.request({ id: "4", method: "extension.validate", params: { profileId } });
      }),
    ),
  );
  expect(calls).toEqual([
    "list:/profile:/repository",
    "add:/profile:/repository:weather",
    "remove:/profile:/repository:weather",
    "validate:/profile:/repository",
  ]);
  expect(responses.map((response) => response.ok)).toEqual([true, true, true, true]);
  expect(responses[0]).toMatchObject({ ok: true, result: { profileId } });
  expect(responses[1]).toMatchObject({ ok: true, result: { profileId, id: "weather" } });
  expect(JSON.stringify(responses)).not.toContain("profilePath");
});

const sessionAt = (
  id: string,
  path: string,
): import("../../src/domain/session").SessionMetadata => ({
  id,
  path,
  kind: "root",
  createdAt: "2026-01-01",
  entryCount: 0,
  parent: undefined,
  parentUnknown: false,
  children: [],
  modelChanges: [],
  thinkingChanges: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  terminalState: "incomplete",
});

test("held resume refuses without replacing the current UI session", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];
  const ref = { profileId, kind: "live" as const, key: "local/main" as const };

  const handle = makeChatHandle({
    prompt: () => Effect.succeed(""),
    resume: () =>
      Effect.fail(new SessionHeld({ profilePath: "/secret", message: "held elsewhere" })),
    modelState: Effect.succeed({ providerId: "openai", modelId: "current", thinking: "low" }),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), undefined, {
            sessions: {
              ...makeSessions(),
              show: () => Effect.succeed(sessionAt("older-1", "local/main/older-1.jsonl")),
            },
          }),
        )).connect((frame) => responses.push(decodeResponse(frame)));

        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });
        yield* connection.request({
          id: "held",
          method: "session.resume",
          params: { ref, sessionId: "older-1" },
        });
        yield* connection.request({ id: "state", method: "session.model.status", params: { ref } });
      }),
    ),
  );

  expect(responses[1]).toMatchObject({
    ok: false,
    error: { code: "session_busy", message: "Session is held by another process" },
  });
  expect(responses[2]).toMatchObject({ ok: true, result: { modelId: "current" } });
  expect(JSON.stringify(responses)).not.toContain("/secret");
});

test("session model and thinking mutations stay on the open handle, not the Profile default", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];
  const ref = { profileId, kind: "live" as const, key: "local/main" as const };

  let sessionState: ChatSessionModelState = {
    providerId: "openai",
    modelId: "first",
    thinking: "low",
  };

  let defaultWrites = 0;

  const handle = makeChatHandle({
    prompt: () => Effect.succeed(""),
    modelState: Effect.sync(() => sessionState),
    setModel: (providerId, modelId) =>
      Effect.sync(() => {
        sessionState = { providerId, modelId, thinking: "low" };

        return sessionState;
      }),
    setThinkingLevel: (thinking) =>
      Effect.sync(() => {
        sessionState = { ...sessionState, thinking };

        return sessionState;
      }),
  });

  const models: ModelsApi = {
    status: () =>
      Effect.succeed({
        providerId: "default",
        modelId: "unchanged",
        thinking: "medium",
        authConfigured: true,
      }),
    readOnlyStatus: () =>
      Effect.succeed({
        providerId: "default",
        modelId: "unchanged",
        thinking: "medium",
        authConfigured: true,
      }),
    list: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    set: () =>
      Effect.sync(() => {
        defaultWrites += 1;

        return { providerId: "changed", modelId: "changed", thinking: "low" };
      }),
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), makeProfileExtensions(), { models }),
        )).connect((frame) => {
          if (Result.isFailure(decodeEventResult(frame))) responses.push(decodeResponse(frame));
        });

        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });

        yield* connection.request({
          id: "switch",
          method: "session.model.set",
          params: { ref, providerId: "anthropic", modelId: "second" },
        });

        yield* connection.request({
          id: "thinking",
          method: "session.thinking.set",
          params: { ref, thinking: "high" },
        });

        yield* connection.request({ id: "default", method: "model.status", params: { profileId } });
      }),
    ),
  );

  expect(responses[1]).toMatchObject({
    ok: true,
    result: { providerId: "anthropic", modelId: "second" },
  });
  expect(responses[2]).toMatchObject({ ok: true, result: { thinking: "high" } });
  expect(responses[3]).toMatchObject({
    ok: true,
    result: { providerId: "default", modelId: "unchanged" },
  });
  expect(defaultWrites).toBe(0);
});

test("UI extension listing respects the frame budget and reports truncation", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];

  const choices = Array.from({ length: 70 }, (_, index) => ({
    id: `extension-${index}`,
    description: "🦊".repeat(512),
    kind: "code" as const,
    source: "bundled" as const,
  }));

  const profileExtensions = makeProfileExtensions({
    listForProfile: () =>
      Effect.succeed({ available: choices, selected: choices.map((choice) => choice.id) }),
  });

  const skipped = Array.from({ length: 16 }, (_, index) => ({
    id: `broken-${index}`,
    diagnostics: Array.from({ length: 8 }, () => ({
      source: "package",
      message: "🦊".repeat(180),
    })),
  }));

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway({
          ...makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.never })),
            profileExtensions,
          ),
          extensionHealth: () =>
            Effect.succeed({
              listing: { available: choices, selected: choices.map((choice) => choice.id) },
              skipped,
            }),
        })).connect((frame) => responses.push(decodeResponse(frame)));

        yield* connection.request({
          id: "list",
          method: "extension.list-for-profile",
          params: { profileId },
        });
      }),
    ),
  );

  const response = responses[0];
  const result = response?.ok === true ? response.result : undefined;
  const available = result !== undefined && "available" in result ? result.available : undefined;
  const selected = result !== undefined && "selected" in result ? result.selected : undefined;

  expect(response?.ok).toBe(true);
  expect(result).toMatchObject({ truncated: true });
  expect(available?.length).toBeLessThanOrEqual(64);
  expect(selected).toHaveLength(64);
  expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThan(64 * 1_024);
});

test("extension listing reports quarantined package diagnostics", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway({
          ...makeConfig(registry, makeAgent(makeChatHandle({ prompt: () => Effect.succeed("") }))),
          extensionHealth: () =>
            Effect.succeed({
              listing: { available: [], selected: ["broken-one"] },
              skipped: [
                {
                  id: "broken-one",
                  diagnostics: [
                    { source: "broken-one/index.ts", message: "invalid command registration" },
                  ],
                },
              ],
            }),
        })).connect((frame) => responses.push(decodeResponse(frame)));

        yield* connection.request({
          id: "health",
          method: "extension.list-for-profile",
          params: { profileId },
        });
      }),
    ),
  );

  expect(responses).toMatchObject([
    {
      ok: true,
      result: {
        selected: ["broken-one"],
        skipped: [{ id: "broken-one", diagnostics: [{ message: "invalid command registration" }] }],
      },
    },
  ]);
});

test("UI gateway maps extension failures to bounded typed details without filesystem paths", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];

  const profileExtensions = makeProfileExtensions({
    add: () =>
      Effect.fail(
        new ExtensionCatalogInstallFailed({
          id: "weather",
          path: "/secret/catalog.tar.gz",
          reason: "download",
          message: "m".repeat(400),
          cause: "catalog download failed",
        }),
      ),
    validate: () =>
      Effect.fail(
        new ProfileExtensionPreflightFailed({
          profilePath: "/secret/profile",
          stage: "extensions",
          message: "package import is unavailable",
          diagnostics: [],
          cause: "preflight failed",
        }),
      ),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.never })),
            profileExtensions,
          ),
        )).connect((frame) => responses.push(decodeResponse(frame)));

        yield* connection.request({
          id: "1",
          method: "extension.add",
          params: { profileId, id: "weather" },
        });
        yield* connection.request({ id: "2", method: "extension.validate", params: { profileId } });
      }),
    ),
  );
  expect(responses[0]).toMatchObject({
    ok: false,
    error: { code: "internal", details: { operation: "add", stage: "download" } },
  });
  expect(responses[1]).toMatchObject({
    ok: false,
    error: { code: "internal", details: { operation: "validate", stage: "extensions" } },
  });
  expect(JSON.stringify(responses)).not.toContain("/secret");
});

test("UI gateway fairly truncates a large model catalog below the response wire budget", async () => {
  const models = Array.from({ length: 800 }, (_, index) => ({
    providerId: `provider-${index % 12}`,
    modelId: `model-${index.toString().padStart(4, "0")}`,
    name: "\u0000".repeat(256),
    thinkingLevels: ["off", "low", "medium", "high"],
  }));

  const modelService: ModelsApi = {
    status: () =>
      Effect.succeed({
        providerId: "provider-0",
        modelId: "model-0000",
        thinking: "off",
        authConfigured: true,
      }),
    readOnlyStatus: () =>
      Effect.succeed({
        providerId: "provider-0",
        modelId: "model-0000",
        thinking: "off",
        authConfigured: true,
      }),
    list: () => Effect.succeed(models),
    available: () => Effect.succeed(models),
    set: (_target, providerId, modelId, thinking) =>
      Effect.succeed({ providerId, modelId, thinking }),
  };

  const sent: string[] = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(
          makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.never })),
            makeProfileExtensions(),
            { models: modelService },
          ),
        )).connect((frame) => sent.push(frame));

        yield* connection.request({
          id: "large-model-catalog",
          method: "model.available",
          params: { profileId },
        });
      }),
    ),
  );

  expect(Buffer.byteLength(sent[0] ?? "", "utf8")).toBeLessThan(64 * 1_024);
  const response = decodeResponse(sent[0] ?? "null");
  expect(response).toMatchObject({
    id: "large-model-catalog",
    ok: true,
    result: {
      profileId,
      truncated: true,
    },
  });
  expect(JSON.stringify(response)).toContain('"providerId":"provider-0"');
  expect(JSON.stringify(response)).toContain('"providerId":"provider-11"');
});

test("session picker filters channel, group, and specialist transcripts before its bound", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];
  const ref = { profileId, kind: "live" as const, key: "local/main" as const };

  const summaries = [
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `channel-${i}`,
      path: `telegram/chat/${i}.jsonl`,
      title: "Channel",
      updatedAt: "2026-01-01",
      held: false,
    })),
    ...Array.from({ length: 33 }, (_, i) => ({
      id: `web-${i}`,
      path: `ui/work/${i}.jsonl`,
      title: "Web",
      updatedAt: "2026-01-01",
      held: false,
    })),
    {
      id: "group",
      path: "ui/group-work/group.jsonl",
      title: "Group",
      updatedAt: "2026-01-01",
      held: false,
    },
    {
      id: "agent",
      path: "local/agents/agent.jsonl",
      title: "Agent",
      updatedAt: "2026-01-01",
      held: false,
    },
    {
      id: ".invalid",
      path: "local/main/invalid.jsonl",
      title: "Invalid",
      updatedAt: "2026-01-01",
      held: false,
    },
  ];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const gateway = yield* makeUiGateway(
          makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.succeed("") })),
            undefined,
            {
              sessions: { ...makeSessions(), summaries: () => Effect.succeed(summaries) },
            },
          ),
        );

        const connection = gateway.connect((frame) => responses.push(decodeResponse(frame)));
        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });
        yield* connection.request({ id: "picker", method: "session.summaries", params: { ref } });
      }),
    ),
  );
  expect(responses[1]).toMatchObject({ ok: true, result: { canResume: true, truncated: true } });

  const result = decodeSummaryResult(responses[1]?.ok ? responses[1].result : undefined);

  expect(result.sessions).toHaveLength(32);
  expect(result.sessions.every((item) => item.id.startsWith("web-"))).toBe(true);
});

test("resume rejects non-web targets and non-plain web contexts without touching the handle", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];
  const resumed: string[] = [];

  const handle = makeChatHandle({
    prompt: () => Effect.succeed(""),
    resume: (path) =>
      Effect.sync(() => {
        resumed.push(path);

        return { cancelled: false };
      }),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const gateway = yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), undefined, {
            sessions: {
              ...makeSessions(),
              show: (_target, id) =>
                Effect.succeed(
                  sessionAt(
                    id,
                    id === "channel" ? "telegram/chat/channel.jsonl" : "local/main/allowed.jsonl",
                  ),
                ),
            },
          }),
        );

        const connection = gateway.connect((frame) => responses.push(decodeResponse(frame)));
        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });
        yield* connection.request({
          id: "channel",
          method: "session.resume",
          params: { ref: { profileId, kind: "live", key: "local/main" }, sessionId: "channel" },
        });
        yield* registry.getOrOpenUi("ui/group-test", Effect.succeed(handle), {
          context: { kind: "group", groupId: "test" },
        });
        yield* connection.request({
          id: "group",
          method: "session.resume",
          params: { ref: { profileId, kind: "live", key: "ui/group-test" }, sessionId: "allowed" },
        });
        yield* registry.getOrOpenUi("local/agents/specialist", Effect.succeed(handle), {
          context: { kind: "local" },
          agentId: "specialist",
        });
        yield* connection.request({
          id: "specialist",
          method: "session.resume",
          params: {
            ref: { profileId, kind: "live", key: "local/agents/specialist" },
            sessionId: "allowed",
          },
        });
      }),
    ),
  );
  expect(
    responses.filter((response) => !response.ok).map((response) => response.error.code),
  ).toEqual(["watch_only", "watch_only", "watch_only"]);
  expect(resumed).toEqual([]);
});

test("successful resume selects the resolved web transcript and resets live history and replay", async () => {
  const frames: string[] = [];
  let current = "old";
  let resumeCalled = false;
  const ref = { profileId, kind: "live" as const, key: "local/main" as const };

  const handle = makeChatHandle({
    prompt: () => Effect.succeed(""),
    currentSession: Effect.sync(() => ({ id: current, file: `${current}.jsonl` })),
    resume: (path) =>
      Effect.sync(() => {
        expect(path).toBe("ui/work/new.jsonl");
        current = "new";
        resumeCalled = true;

        return { cancelled: false };
      }),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const gateway = yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), undefined, {
            sessions: {
              ...makeSessions(),
              show: () => Effect.succeed(sessionAt("new", "ui/work/new.jsonl")),
              history: (_target, id) =>
                Effect.succeed({
                  entries: [{ kind: "assistant" as const, timestamp: "2026-01-01", text: id }],
                  terminalState: "completed" as const,
                  truncated: false,
                  hasMore: false,
                }),
            },
          }),
        );

        const connection = gateway.connect((frame) => frames.push(frame));
        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });
        yield* registry.publish("local/main", {
          kind: "assistant-text",
          delta: "old",
          snapshot: "old",
        });
        yield* connection.request({
          id: "resume",
          method: "session.resume",
          params: { ref, sessionId: "new" },
        });
        yield* connection.request({ id: "history", method: "session.history", params: { ref } });
        const replay = yield* registry.replay("local/main", 0).pipe(Effect.result);
        expect(replay._tag).toBe("Failure");
      }),
    ),
  );
  expect(resumeCalled).toBe(true);

  const responses = frames.flatMap((frame) =>
    Result.isSuccess(decodeEventResult(frame)) ? [] : [decodeResponse(frame)],
  );

  const history = responses.find((response) => response.id === "history");
  expect(history?.ok && history.result).toMatchObject({ entries: [{ text: "new" }] });
  expect(
    frames
      .map((frame) => decodeEventResult(frame))
      .filter(Result.isSuccess)
      .some(
        (event) =>
          event.success.event === "session-state" && event.success.payload.scope === "transcript",
      ),
  ).toBe(true);
});

test("concurrent resumes publish each reset before the next switch starts", async () => {
  const frames: string[] = [];
  const ref = { profileId, kind: "live" as const, key: "local/main" as const };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const secondShown = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const calls: string[] = [];
        const registry = yield* makeChatRegistry();

        const handle = makeChatHandle({
          prompt: () => Effect.succeed(""),
          resume: (path) =>
            Effect.gen(function* () {
              calls.push(path);

              if (calls.length === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }

              return { cancelled: false };
            }),
        });

        const connection = (yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), undefined, {
            sessions: {
              ...makeSessions(),
              show: (_target, id) =>
                Effect.gen(function* () {
                  if (id === "second") yield* Deferred.succeed(secondShown, undefined);

                  return sessionAt(id, `ui/work/${id}.jsonl`);
                }),
            },
          }),
        )).connect((frame) => frames.push(frame));

        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });

        const request = (id: string) =>
          connection.request({
            id,
            method: "session.resume",
            params: { ref, sessionId: id },
          });

        const first = yield* Effect.forkChild(request("first"));
        yield* Deferred.await(entered);
        const second = yield* Effect.forkChild(request("second"));
        yield* Deferred.await(secondShown);
        yield* Effect.yieldNow;
        yield* registry.publish(ref.key, { kind: "assistant-text", delta: "old", snapshot: "old" });
        expect(calls).toEqual(["ui/work/first.jsonl"]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(calls).toEqual(["ui/work/first.jsonl", "ui/work/second.jsonl"]);

        const events = frames.flatMap((frame) => {
          const decoded = decodeEventResult(frame);

          return Result.isSuccess(decoded) ? [decoded.success] : [];
        });

        expect(
          events.filter((event) => event.event === "session-state").map((event) => event.seq),
        ).toEqual([2, 3]);
        const replay = yield* registry.replay(ref.key, 2);
        expect(replay.events.map((event) => event.event)).toEqual([
          { kind: "session-state", scope: "transcript" },
        ]);
      }),
    ),
  );
});

test("interrupting a resume waits for Pi and publishes its reset before releasing control", async () => {
  const ref = { profileId, kind: "live" as const, key: "local/main" as const };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const registry = yield* makeChatRegistry();

        const handle = makeChatHandle({
          prompt: () => Effect.succeed(""),
          resume: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);

              return { cancelled: false };
            }),
        });

        const connection = (yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), undefined, {
            sessions: {
              ...makeSessions(),
              show: (_target, id) => Effect.succeed(sessionAt(id, `ui/work/${id}.jsonl`)),
            },
          }),
        )).connect(() => {});

        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });

        const first = yield* Effect.forkChild(
          connection.request({
            id: "resume",
            method: "session.resume",
            params: { ref, sessionId: "first" },
          }),
        );

        yield* Deferred.await(entered);
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(first));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupted);
        const replay = yield* registry.replay(ref.key);
        expect(replay.events.map((event) => event.event)).toEqual([
          { kind: "session-state", scope: "transcript" },
        ]);
      }),
    ),
  );
});

test("a prompt submitted during resume starts after the transcript reset", async () => {
  const ref = { profileId, kind: "live" as const, key: "local/main" as const };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const prompted = yield* Deferred.make<void>();
        const registry = yield* makeChatRegistry();

        const handle = makeChatHandle({
          prompt: () =>
            registry
              .publish(ref.key, { kind: "assistant-text", delta: "new", snapshot: "new" })
              .pipe(
                Effect.catch(() => Effect.void),
                Effect.andThen(Deferred.succeed(prompted, undefined)),
                Effect.as(""),
              ),
          resume: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);

              return { cancelled: false };
            }),
        });

        const connection = (yield* makeUiGateway(
          makeConfig(registry, makeAgent(handle), undefined, {
            sessions: {
              ...makeSessions(),
              show: (_target, id) => Effect.succeed(sessionAt(id, `ui/work/${id}.jsonl`)),
            },
          }),
        )).connect(() => {});

        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });

        const resume = yield* Effect.forkChild(
          connection.request({
            id: "resume",
            method: "session.resume",
            params: { ref, sessionId: "first" },
          }),
        );

        yield* Deferred.await(entered);

        const prompt = yield* Effect.forkChild(
          connection.request({
            id: "prompt",
            method: "prompt.submit",
            params: { ref, text: "hi" },
          }),
        );

        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(prompted)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(resume);
        yield* Fiber.join(prompt);
        yield* Deferred.await(prompted);
        const replay = yield* registry.replay(ref.key);
        expect(replay.events.map((event) => event.event)).toContainEqual({
          kind: "assistant-text",
          delta: "new",
          snapshot: "new",
        });
      }),
    ),
  );
});

test("a streaming model switch reports SessionBusy without changing the session", async () => {
  const frames: string[] = [];

  const handle = makeChatHandle({
    prompt: () => Effect.succeed(""),
    setModel: () => Effect.fail(new SessionBusy({ profilePath: "/secret", message: "streaming" })),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const connection = (yield* makeUiGateway(makeConfig(registry, makeAgent(handle)))).connect(
          (frame) => frames.push(frame),
        );

        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });
        yield* connection.request({
          id: "busy",
          method: "session.model.set",
          params: {
            ref: { profileId, kind: "live", key: "local/main" },
            providerId: "openai",
            modelId: "new",
          },
        });
      }),
    ),
  );
  expect(
    frames.map((frame) => decodeResponse(frame)).find((response) => response.id === "busy"),
  ).toMatchObject({
    ok: false,
    error: {
      code: "session_busy",
      message: "Session is busy; wait for the current turn to finish",
    },
  });
  expect(JSON.stringify(frames)).not.toContain("/secret");
});

test("health inspection failure still lists selected extensions with a diagnostic", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const extensions = makeProfileExtensions({
          listForProfile: () => Effect.succeed({ selected: ["weather"], available: [] }),
        });

        const connection = (yield* makeUiGateway({
          ...makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.succeed("") })),
            extensions,
          ),
          extensionHealth: () =>
            Effect.fail(
              new ProfileExtensionPreflightFailed({
                profilePath: "/secret",
                stage: "extensions",
                diagnostics: [],
                message: "health inspection failed",
                cause: undefined,
              }),
            ),
        })).connect((frame) => responses.push(decodeResponse(frame)));

        yield* connection.request({
          id: "health",
          method: "extension.list-for-profile",
          params: { profileId },
        });
      }),
    ),
  );

  expect(responses[0]).toMatchObject({
    ok: true,
    result: {
      selected: ["weather"],
      skipped: [
        {
          id: "health-inspection",
          diagnostics: [{ message: "Could not inspect extension health" }],
        },
      ],
    },
  });
  expect(JSON.stringify(responses)).not.toContain("/secret");
});
