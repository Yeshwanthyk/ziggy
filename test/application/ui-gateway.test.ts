/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun test functions own the Effect Promise boundary */
import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { makeChatHandle, type ChatEvent, type ZiggyAgentApi } from "ziggy/application/agent";
import { makeChatRegistry } from "ziggy/application/chat-registry";
import type { SessionsApi } from "ziggy/application/sessions";
import { makeUiGateway } from "ziggy/application/ui-gateway";
import {
  ProfileExtensionPreflightFailed,
  type ProfileExtensionsApi,
} from "ziggy/domain/profile-extension";
import { ExtensionCatalogInstallFailed } from "ziggy/domain/extension-catalog";
import { SessionNotFound } from "ziggy/domain/session";
import { UiEventFrame, UiResponseFrame } from "ziggy/domain/ui-gateway";

const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(UiResponseFrame));
const decodeEventResult = Schema.decodeUnknownResult(Schema.fromJsonString(UiEventFrame));

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

test("UI gateway opens, subscribes, acknowledges prompts, and closes only its subscriptions", async () => {
  const sent: string[] = [];
  const listeners = new Set<(event: ChatEvent) => void>();
  let opened:
    | {
        readonly directory: string;
        readonly mode: string | undefined;
        readonly context: string;
      }
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
  const agent: ZiggyAgentApi = {
    runOnce: () => Effect.succeed(0),
    openTui: () => Effect.succeed(0),
    openChat: (_target, context, directory, mode) => {
      opened = { directory, mode, context: context.kind };
      return Effect.succeed(handle);
    },
    openSpecialistChat: () => Effect.succeed(handle),
    runSpecialist: () =>
      Effect.succeed({ answer: "ok", session: { id: "child", file: "child.jsonl" } }),
  };
  const sessions: SessionsApi = {
    list: () => Effect.succeed([]),
    show: (_target, reference) =>
      Effect.fail(new SessionNotFound({ reference, message: "missing" })),
    resolve: (_target, reference) =>
      Effect.fail(new SessionNotFound({ reference, message: "missing" })),
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();
        const gateway = makeUiGateway(
          { path: "/profile", name: "Profile" },
          registry,
          sessions,
          agent,
          "/repository",
          makeProfileExtensions(),
        );
        const connection = gateway.connect((frame) => sent.push(frame));
        yield* connection.request({ id: "1", method: "session.open", params: { name: "main" } });
        expect(opened).toEqual({
          directory: "/profile/sessions/ui/main",
          mode: "continue",
          context: "local",
        });
        expect(decodeResponse(sent[0] ?? "null")).toEqual({
          id: "1",
          ok: true,
          result: { session: "ui/main" },
        });

        yield* connection.request({
          id: "2",
          method: "prompt.submit",
          params: { session: "ui/main", text: "hello" },
        });
        yield* Effect.yieldNow;
        const events = sent.flatMap((frame) => {
          const decoded = decodeEventResult(frame);
          return Result.isSuccess(decoded) ? [decoded.success] : [];
        });
        expect(events).toContainEqual({
          event: "assistant-text",
          session: "ui/main",
          payload: { delta: "hello", snapshot: "hello" },
        });

        const beforeClose = sent.length;
        yield* connection.close;
        for (const listener of listeners) listener({ kind: "settled" });
        expect(sent).toHaveLength(beforeClose);
        expect((yield* registry.get("ui/main")).handle).toBe(handle);
      }),
    ),
  );
});

test("UI gateway returns typed method, params, session, and watch-only failures", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();
        const channel = makeChatHandle({ prompt: () => Effect.succeed("channel") });
        yield* registry.registerAlias("slack/user-1", "slack", channel);
        const sessions: SessionsApi = {
          list: () => Effect.succeed([]),
          show: () => Effect.never,
          resolve: () => Effect.never,
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.never,
          openTui: () => Effect.never,
          openChat: () => Effect.never,
          openSpecialistChat: () => Effect.never,
          runSpecialist: () => Effect.never,
        };
        const connection = makeUiGateway(
          { path: "/profile", name: "Profile" },
          registry,
          sessions,
          agent,
          "/repository",
          makeProfileExtensions(),
        ).connect((frame) => responses.push(decodeResponse(frame)));

        yield* connection.request({ id: "1", method: "missing", params: {} });
        yield* connection.request({ id: "2", method: "ping", params: { extra: true } });
        yield* connection.request({
          id: "3",
          method: "session.watch",
          params: { session: "ui/missing" },
        });
        yield* connection.request({
          id: "4",
          method: "prompt.submit",
          params: { session: "slack/user-1", text: "no" },
        });
        yield* connection.request({ id: "5", method: "extension.add", params: { id: "Bad_ID" } });
      }),
    ),
  );
  expect(responses.map((response) => (response.ok ? undefined : response.error.code))).toEqual([
    "unknown_method",
    "bad_params",
    "unknown_session",
    "watch_only",
    "bad_params",
  ]);
});

test("UI gateway forwards extension operations with bounded domain-shaped responses", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];
  const calls: string[] = [];
  const profileExtensions = makeProfileExtensions({
    listForProfile: (profilePath, repositoryRoot) => {
      calls.push(`list:${profilePath}:${repositoryRoot}`);
      return Effect.succeed({
        available: [{ id: "weather", description: "Weather", kind: "skill", source: "bundled" }],
        selected: ["weather"],
      });
    },
    add: (target, repositoryRoot, id) => {
      calls.push(`add:${target.path}:${repositoryRoot}:${id}`);
      return Effect.succeed({ id, profilePath: target.path, changed: true, selected: true });
    },
    remove: (target, repositoryRoot, id) => {
      calls.push(`remove:${target.path}:${repositoryRoot}:${id}`);
      return Effect.succeed({ id, profilePath: target.path, changed: true, selected: false });
    },
    validate: (target, repositoryRoot) => {
      calls.push(`validate:${target.path}:${repositoryRoot}`);
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
        const sessions: SessionsApi = {
          list: () => Effect.succeed([]),
          show: () => Effect.never,
          resolve: () => Effect.never,
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.never,
          openTui: () => Effect.never,
          openChat: () => Effect.never,
          openSpecialistChat: () => Effect.never,
          runSpecialist: () => Effect.never,
        };
        const connection = makeUiGateway(
          { path: "/profile", name: "Profile" },
          registry,
          sessions,
          agent,
          "/repository",
          profileExtensions,
        ).connect((frame) => responses.push(decodeResponse(frame)));

        yield* connection.request({
          id: "1",
          method: "extension.list-for-profile",
          params: {},
        });
        yield* connection.request({
          id: "2",
          method: "extension.add",
          params: { id: "weather" },
        });
        yield* connection.request({
          id: "3",
          method: "extension.remove",
          params: { id: "weather" },
        });
        yield* connection.request({ id: "4", method: "extension.validate", params: {} });
      }),
    ),
  );

  expect(calls).toEqual([
    "list:/profile:/repository",
    "add:/profile:/repository:weather",
    "remove:/profile:/repository:weather",
    "validate:/profile:/repository",
  ]);
  expect(responses).toEqual([
    {
      id: "1",
      ok: true,
      result: {
        available: [{ id: "weather", description: "Weather", kind: "skill", source: "bundled" }],
        selected: ["weather"],
      },
    },
    {
      id: "2",
      ok: true,
      result: { id: "weather", profilePath: "/profile", changed: true, selected: true },
    },
    {
      id: "3",
      ok: true,
      result: { id: "weather", profilePath: "/profile", changed: true, selected: false },
    },
    {
      id: "4",
      ok: true,
      result: {
        selected: ["weather"],
        preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
      },
    },
  ]);
});

test("UI gateway projects typed extension failures into bounded response details", async () => {
  const responses: Array<typeof UiResponseFrame.Type> = [];
  const catalogId = "a".repeat(160);
  const failureMessage = "m".repeat(400);
  const failureSource = "p".repeat(400);
  const profileExtensions = makeProfileExtensions({
    add: () =>
      Effect.fail(
        new ExtensionCatalogInstallFailed({
          id: catalogId,
          path: failureSource,
          reason: "download",
          message: failureMessage,
          cause: "catalog download failed",
        }),
      ),
    validate: () =>
      Effect.fail(
        new ProfileExtensionPreflightFailed({
          profilePath: "/profile",
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
        const sessions: SessionsApi = {
          list: () => Effect.succeed([]),
          show: () => Effect.never,
          resolve: () => Effect.never,
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.never,
          openTui: () => Effect.never,
          openChat: () => Effect.never,
          openSpecialistChat: () => Effect.never,
          runSpecialist: () => Effect.never,
        };
        const connection = makeUiGateway(
          { path: "/profile", name: "Profile" },
          registry,
          sessions,
          agent,
          "/repository",
          profileExtensions,
        ).connect((frame) => responses.push(decodeResponse(frame)));

        yield* connection.request({
          id: "1",
          method: "extension.add",
          params: { id: "weather" },
        });
        yield* connection.request({ id: "2", method: "extension.validate", params: {} });
      }),
    ),
  );

  expect(responses).toEqual([
    {
      id: "1",
      ok: false,
      error: {
        code: "internal",
        message: "could not add Profile extensions",
        details: {
          operation: "add",
          stage: "download",
          code: "catalog_install_failed",
          message: "m".repeat(360),
          id: "a".repeat(128),
          source: "p".repeat(240),
          selectionChanged: false,
        },
      },
    },
    {
      id: "2",
      ok: false,
      error: {
        code: "internal",
        message: "could not validate Profile extensions",
        details: {
          operation: "validate",
          stage: "extensions",
          code: "preflight_failed",
          message: "package import is unavailable",
          selectionChanged: false,
        },
      },
    },
  ]);
});
