/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun's test callback API is Promise-shaped */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Effect, Result, Schema } from "effect";
import { makeChatHandle, type ChatEvent, type ZiggyAgentApi } from "ziggy/application/agent";
import { makeChatRegistry, type ChatRegistryApi } from "ziggy/application/chat-registry";
import type { SessionsApi } from "ziggy/application/sessions";
import { makeUiGateway } from "ziggy/application/ui-gateway";
import type { UiGroupStore } from "ziggy/adapters/fs/ui-state";
import { stableProfileId } from "ziggy/application/profile-directory";
import {
  ProfileExtensionPreflightFailed,
  type ProfileExtensionsApi,
} from "ziggy/domain/profile-extension";
import { ExtensionCatalogInstallFailed } from "ziggy/domain/extension-catalog";
import { SessionNotFound } from "ziggy/domain/session";
import { UiEventFrame, UiResponseFrame, type UiGroupRecord } from "ziggy/domain/ui-gateway";
import { UiGroupState, type UiGroupState as UiGroupStateValue } from "ziggy/domain/ui-state";

const target = { path: "/profile", name: "Profile" } as const;
const profileId = stableProfileId(target.path);
const repositoryRoot = "/repository";
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(UiResponseFrame));
const decodeEventResult = Schema.decodeUnknownResult(Schema.fromJsonString(UiEventFrame));
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
  openTui: () => Effect.succeed(0),
  openChat: () => Effect.succeed(handle),
  openSpecialistChat: () => Effect.succeed(handle),
  runSpecialist: () =>
    Effect.succeed({ answer: "specialist answer", session: { id: "child", file: "child.jsonl" } }),
  ...overrides,
});

interface TestConfigExtras {
  readonly groups?: UiGroupStore;
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
  ...extra,
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
        const connection = makeUiGateway(makeConfig(registry, agent)).connect((frame) =>
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
        const gateway = makeUiGateway(makeConfig(registry, makeAgent(handle)));
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
        const third = makeUiGateway(makeConfig(registry, makeAgent(handle))).connect((frame) =>
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
        const connection = makeUiGateway(makeConfig(registry, agent)).connect((frame) =>
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
        const connection = makeUiGateway(makeConfig(registry, agent)).connect(() => undefined);
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
        const connection = makeUiGateway(
          makeConfig(registry, agent, makeProfileExtensions(), {
            groups,
          }),
        ).connect((frame) => sent.push(frame));
        const context = {
          kind: "group" as const,
          groupId: "planning",
          memberAgentIds: ["researcher", "writer"],
          defaultRecipient: { kind: "host" as const },
        };
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
        const connection = makeUiGateway(
          makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.never })),
            profileExtensions,
          ),
        ).connect((frame) => responses.push(decodeResponse(frame)));
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
        const connection = makeUiGateway(
          makeConfig(
            registry,
            makeAgent(makeChatHandle({ prompt: () => Effect.never })),
            profileExtensions,
          ),
        ).connect((frame) => responses.push(decodeResponse(frame)));
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
