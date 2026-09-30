/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun's test callback API is Promise-shaped */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Deferred, Effect, Fiber, Result, Schema } from "effect";
import {
  type ChatEvent,
  type ChatSessionModelState,
  type ZiggyAgentApi,
} from "ziggy/application/agent";
import { makeChatHandle } from "../harness/chat-handle";
import { SessionBusy, SessionHeld } from "ziggy/domain/agent";
import {
  LIVE_REPLAY_LIMIT,
  makeLiveSessions,
  type LiveSessionEvent,
  type LiveSessionsApi,
} from "ziggy/resident/live-sessions";
import { makeDestinationBook } from "ziggy/resident/destinations";
import type { ProfileAgentsApi } from "ziggy/agents/index";
import { makeUiGateway } from "ziggy/application/ui-gateway";
import type { UiGroupStore } from "ziggy/adapters/fs/ui-state";
import { stableProfileId } from "ziggy/application/profile-directory";
import { ExtensionLoadFailed, type ExtensionsApi } from "ziggy/extensions/index";
import { ProfileFileSystemError } from "ziggy/profile/index";
import { SessionNotFound, SessionReadFailed, type SessionsApi } from "ziggy/session/index";
import { ProfileAgentEditConflict } from "ziggy/domain/profile";
import {
  UiEventFrame,
  UiResponseFrame,
  UiSessionSummaryResult,
  type UiGroupRecord,
} from "ziggy/domain/ui-gateway";
import { UiGroupState, type UiGroupState as UiGroupStateValue } from "ziggy/domain/ui-state";
import { type ModelsApi, type AuthApi } from "ziggy/profile/index";

const target = { path: "/profile", name: "Profile" } as const;

const profileId = stableProfileId(target.path);

const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(UiResponseFrame));

const decodeEventResult = Schema.decodeUnknownResult(Schema.fromJsonString(UiEventFrame));

const decodeSummaryResult = Schema.decodeUnknownSync(UiSessionSummaryResult);

const decodeEmptyGroupState = Schema.decodeUnknownSync(UiGroupState);

/** The retained live events after `afterSeq`, read through a throwaway subscription. */
const retainedEvents = (live: LiveSessionsApi, key: string, afterSeq?: number) =>
  Effect.gen(function* () {
    const events: LiveSessionEvent[] = [];
    const stop = yield* live.watch(key, (event) => events.push(event), afterSeq);
    stop();

    return events;
  });

const makeProfileExtensions = (overrides: Partial<ExtensionsApi> = {}): ExtensionsApi => {
  const listForProfile: ExtensionsApi["listForProfile"] =
    overrides.listForProfile ??
    (() => Effect.succeed({ available: [], selected: [], required: [] }));

  return {
    list: () => Effect.never,
    show: () => Effect.never,
    listForProfile,
    add: (_target, id) =>
      Effect.succeed({
        id,
        profilePath: "/profile",
        changed: true,
        selected: true,
        automations: [],
      }),
    remove: (_target, id) =>
      Effect.succeed({
        id,
        profilePath: "/profile",
        changed: true,
        selected: false,
        automations: [],
      }),
    setSelected: () => Effect.never,
    validate: () =>
      Effect.succeed({
        selected: [],
        preflight: { extensionPathCount: 0, skillPathCount: 0, extensionFactoryCount: 0 },
      }),
    health: (profilePath) =>
      Effect.map(listForProfile(profilePath), (listing) => ({ listing, skipped: [] })),
    update: () => Effect.never,
    ...overrides,
  };
};

const makeSessions = (): SessionsApi => ({
  summaries: () => Effect.succeed([]),
  held: () => Effect.succeed(false),
  list: () => Effect.succeed([]),
  show: (_target, reference) => Effect.fail(new SessionNotFound({ reference, message: "missing" })),
  locate: (_target, reference) =>
    Effect.fail(new SessionNotFound({ reference, message: "missing" })),
  history: (_target, reference) =>
    Effect.fail(new SessionNotFound({ reference, message: "missing" })),
});

const makeAgent = (
  handle: ReturnType<typeof makeChatHandle>,
  overrides: Partial<ZiggyAgentApi> = {},
): ZiggyAgentApi => ({
  runOnce: () => Effect.succeed(0),
  open: () => Effect.succeed(handle),
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
  live: LiveSessionsApi,
  agent: ZiggyAgentApi,
  profileExtensions = makeProfileExtensions(),
  extra: TestConfigExtras = {},
) => ({
  defaultProfile: { profileId, target, live, destinations: makeDestinationBook() },
  sessions: makeSessions(),
  agent,
  profileExtensions,
  ...extra,
});

test("session.open refuses a held writer with a plain session_busy error", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];

  const agent = makeAgent(makeChatHandle({ prompt: () => Effect.succeed("") }), {
    open: () => Effect.fail(new SessionHeld({ profilePath: "/secret", message: "held" })),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(makeConfig(live, agent))).connect((frame) =>
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
    open: ({ context, directory, session: mode }) => {
      opened = { directory, mode, context: context.kind };

      return Effect.succeed(handle);
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(makeConfig(live, agent))).connect((frame) =>
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
        expect((yield* live.get("ui/main")).handle).toBe(handle);
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(live, makeAgent(handle), makeProfileExtensions(), { sessions }),
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(live, makeAgent(handle), makeProfileExtensions(), { sessions }),
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(live, makeAgent(handle), makeProfileExtensions(), { sessions }),
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
        const live = yield* makeLiveSessions();
        const gateway = yield* makeUiGateway(makeConfig(live, makeAgent(handle)));
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

        const third = (yield* makeUiGateway(makeConfig(live, makeAgent(handle)))).connect((frame) =>
          restarted.push(decodeResponse(frame)),
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
        const live = yield* makeLiveSessions();

        const handle = makeChatHandle({
          prompt: () => Effect.succeed("ok"),
          currentSession: Effect.succeed({ id: "durable-session", file: "/private/session.jsonl" }),
        });

        let opens = 0;

        const agent = makeAgent(handle, {
          open: () =>
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

        const gateway = yield* makeUiGateway(makeConfig(live, agent, undefined, { sessions }));
        const frames: string[] = [];
        const connection = gateway.connect((frame) => frames.push(frame));
        const ref = { profileId, kind: "live" as const, key: "local/main" };
        yield* connection.request({
          id: "open",
          method: "session.open",
          params: { profileId, context: { kind: "local" } },
        });

        for (let index = 0; index <= LIVE_REPLAY_LIMIT; index += 1) {
          yield* live.publish("local/main", { kind: "settled" });
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

          expect(events).toHaveLength(LIVE_REPLAY_LIMIT);
          expect(events[0]?.seq).toBe(2);
          expect(events.at(-1)?.seq).toBe(LIVE_REPLAY_LIMIT + 1);
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
          { ref, afterSeq: LIVE_REPLAY_LIMIT + 1, epoch: "expired-epoch" },
        ]) {
          yield* connection.request({ id: "invalid-resume", method: "session.watch", params });
          expect(decodeResponse(frames.at(-1) ?? "null")).toMatchObject({
            ok: false,
            error: { code: "replay_gap" },
          });
        }

        frames.length = 0;
        yield* live.publish("local/main", { kind: "settled" });
        expect(frames).toHaveLength(1);
        expect(decodeEventResult(frames[0] ?? "null")).toMatchObject({
          success: { seq: LIVE_REPLAY_LIMIT + 2 },
        });
        yield* connection.request({ id: "unwatch", method: "session.unwatch", params: { ref } });
        frames.length = 0;
        yield* live.publish("local/main", { kind: "settled" });
        expect(frames).toEqual([]);
        yield* connection.request({ id: "rewatch", method: "session.watch", params: { ref } });
        yield* connection.close;
        frames.length = 0;
        yield* live.publish("local/main", { kind: "settled" });
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
    open: () => {
      openCount += 1;

      return Effect.succeed(handle);
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(makeConfig(live, agent))).connect((frame) =>
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
        const live = yield* makeLiveSessions();
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
            live,
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(live, makeAgent(handle), makeProfileExtensions(), { profileAgents }),
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
    status: () => Effect.succeed([...unconfigured, configured]),
    login: () => Effect.never,
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(live, makeAgent(handle), makeProfileExtensions(), { auth }),
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(makeConfig(live, makeAgent(handle)))).connect(
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(
            live,
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
    open: ({ agent }) => {
      calls.push(agent === undefined ? "channel-or-host" : `specialist:${agent}`);

      return Effect.succeed(handle);
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();
        yield* live.acquire("slack/user-1", "slack", Effect.succeed(handle));

        const connection = (yield* makeUiGateway(makeConfig(live, agent))).connect(() => undefined);

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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(
            live,
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
        const live = yield* makeLiveSessions();
        const sent: string[] = [];

        const connection = (yield* makeUiGateway(
          makeConfig(live, agent, makeProfileExtensions(), {
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
    listForProfile: (profilePath) => {
      calls.push(`list:${profilePath}`);

      return Effect.succeed({
        available: [{ id: "weather", description: "Weather", kind: "skill", source: "bundled" }],
        selected: ["weather"],
        required: [],
      });
    },
    add: (profile, id) => {
      calls.push(`add:${profile.path}:${id}`);

      return Effect.succeed({
        id,
        profilePath: profile.path,
        changed: true,
        selected: true,
        automations: [],
      });
    },
    remove: (profile, id) => {
      calls.push(`remove:${profile.path}:${id}`);

      return Effect.succeed({
        id,
        profilePath: profile.path,
        changed: true,
        selected: false,
        automations: [],
      });
    },
    validate: (profile) => {
      calls.push(`validate:${profile.path}`);

      return Effect.succeed({
        selected: ["weather"],
        preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
      });
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(
            live,
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
    "list:/profile",
    "add:/profile:weather",
    "remove:/profile:weather",
    "validate:/profile",
  ]);
  expect(responses.map((response) => response.ok)).toEqual([true, true, true, true]);
  expect(responses[0]).toMatchObject({ ok: true, result: { profileId } });
  expect(responses[1]).toMatchObject({ ok: true, result: { profileId, id: "weather" } });
  expect(JSON.stringify(responses)).not.toContain("profilePath");
});

const sessionAt = (
  id: string,
  path: string,
): import("../../src/session/index").SessionMetadata => ({
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(live, makeAgent(handle), undefined, {
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
    check: () => Effect.never,
    status: () =>
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(live, makeAgent(handle), makeProfileExtensions(), { models }),
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

  const listing = {
    available: choices,
    selected: choices.map((choice) => choice.id),
    required: [],
  };

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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway({
          ...makeConfig(
            live,
            makeAgent(makeChatHandle({ prompt: () => Effect.never })),
            makeProfileExtensions({
              listForProfile: () => Effect.succeed(listing),
              health: () => Effect.succeed({ listing, skipped }),
            }),
          ),
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway({
          ...makeConfig(
            live,
            makeAgent(makeChatHandle({ prompt: () => Effect.succeed("") })),
            makeProfileExtensions({
              health: () =>
                Effect.succeed({
                  listing: { available: [], selected: ["broken-one"], required: [] },
                  skipped: [
                    {
                      id: "broken-one",
                      diagnostics: [
                        { source: "broken-one/index.ts", message: "invalid command registration" },
                      ],
                    },
                  ],
                }),
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
        new ProfileFileSystemError({
          operation: "rename",
          path: "/secret/extensions/weather",
          message: "m".repeat(400),
          code: "EACCES",
          cause: "unpack failed",
        }),
      ),
    validate: () =>
      Effect.fail(
        new ExtensionLoadFailed({
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(
            live,
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
    error: { code: "internal", details: { operation: "add", stage: "filesystem" } },
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
    check: () => Effect.never,
    status: () =>
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
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(
          makeConfig(
            live,
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

test("session picker filters transcripts before its bound and probes leases only for returned rows", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];
  const ref = { profileId, kind: "live" as const, key: "local/main" as const };
  const probed: string[] = [];

  const summaries = [
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `channel-${i}`,
      path: `telegram/chat/${i}.jsonl`,
      title: "Channel",
      updatedAt: "2026-01-01",
    })),
    ...Array.from({ length: 33 }, (_, i) => ({
      id: `web-${i}`,
      path: `ui/work/${i}.jsonl`,
      title: "Web",
      updatedAt: "2026-01-01",
    })),
    {
      id: "group",
      path: "ui/group-work/group.jsonl",
      title: "Group",
      updatedAt: "2026-01-01",
    },
    {
      id: "agent",
      path: "local/agents/agent.jsonl",
      title: "Agent",
      updatedAt: "2026-01-01",
    },
    {
      id: ".invalid",
      path: "local/main/invalid.jsonl",
      title: "Invalid",
      updatedAt: "2026-01-01",
    },
  ];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();

        const gateway = yield* makeUiGateway(
          makeConfig(
            live,
            makeAgent(makeChatHandle({ prompt: () => Effect.succeed("") })),
            undefined,
            {
              sessions: {
                ...makeSessions(),
                summaries: () => Effect.succeed(summaries),
                held: (_target, id) =>
                  Effect.sync(() => {
                    probed.push(id);

                    return id === "web-0";
                  }),
              },
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
  expect(probed).toEqual(result.sessions.map((item) => item.id));
  expect(result.sessions.filter((item) => item.held).map((item) => item.id)).toEqual(["web-0"]);
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
        const live = yield* makeLiveSessions();

        const gateway = yield* makeUiGateway(
          makeConfig(live, makeAgent(handle), undefined, {
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
        yield* live.acquire("ui/group-test", "ui", Effect.succeed(handle), {
          context: { kind: "group", groupId: "test" },
        });
        yield* connection.request({
          id: "group",
          method: "session.resume",
          params: { ref: { profileId, kind: "live", key: "ui/group-test" }, sessionId: "allowed" },
        });
        yield* live.acquire("local/agents/specialist", "ui", Effect.succeed(handle), {
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
    resume: (sessionId) =>
      Effect.sync(() => {
        expect(sessionId).toBe("new");
        current = "new";
        resumeCalled = true;

        return { cancelled: false };
      }),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();

        const gateway = yield* makeUiGateway(
          makeConfig(live, makeAgent(handle), undefined, {
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
        yield* live.publish("local/main", {
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
        const replay = yield* retainedEvents(live, "local/main", 0).pipe(Effect.result);
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

test("a streaming model switch reports SessionBusy without changing the session", async () => {
  const frames: string[] = [];

  const handle = makeChatHandle({
    prompt: () => Effect.succeed(""),
    setModel: () => Effect.fail(new SessionBusy({ profilePath: "/secret", message: "streaming" })),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();

        const connection = (yield* makeUiGateway(makeConfig(live, makeAgent(handle)))).connect(
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
        const live = yield* makeLiveSessions();

        const extensions = makeProfileExtensions({
          listForProfile: () =>
            Effect.succeed({ selected: ["weather"], available: [], required: [] }),
          health: () =>
            Effect.fail(
              new ExtensionLoadFailed({
                profilePath: "/secret",
                stage: "extensions",
                diagnostics: [],
                message: "health inspection failed",
                cause: undefined,
              }),
            ),
        });

        const connection = (yield* makeUiGateway({
          ...makeConfig(
            live,
            makeAgent(makeChatHandle({ prompt: () => Effect.succeed("") })),
            extensions,
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
