/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun test functions own the Effect Promise boundary */
import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { makeChatHandle, type ChatEvent, type ZiggyAgentApi } from "ziggy/application/agent";
import { makeChatRegistry } from "ziggy/application/chat-registry";
import type { SessionsApi } from "ziggy/application/sessions";
import { makeUiGateway } from "ziggy/application/ui-gateway";
import { SessionNotFound } from "ziggy/domain/session";
import { UiEventFrame, UiResponseFrame } from "ziggy/domain/ui-gateway";

const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(UiResponseFrame));
const decodeEventResult = Schema.decodeUnknownResult(Schema.fromJsonString(UiEventFrame));

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
      }),
    ),
  );
  expect(responses.map((response) => (response.ok ? undefined : response.error.code))).toEqual([
    "unknown_method",
    "bad_params",
    "unknown_session",
    "watch_only",
  ]);
});
