import { join } from "node:path";
import { Context, Effect, Schema } from "effect";
import {
  UiEmptyParams,
  UiEventFrame,
  UiGatewayError,
  UiResponseFrame,
  UiSessionOpenParams,
  UiSessionParams,
  UiSessionTextParams,
  type UiRequestEnvelope,
  type UiRequestId,
  type UiLiveSession,
  type UiSessionKey,
} from "../domain/ui-gateway";
import type { ProfileTarget } from "../domain/profile";
import type { SessionMetadata } from "../domain/session";
import type { ChatEvent, ZiggyAgentApi } from "./agent";
import type { ChatRegistryApi } from "./chat-registry";
import type { SessionsApi } from "./sessions";

const decodeEmpty = Schema.decodeUnknownEffect(UiEmptyParams, { onExcessProperty: "error" });
const decodeOpen = Schema.decodeUnknownEffect(UiSessionOpenParams, { onExcessProperty: "error" });
const decodeSession = Schema.decodeUnknownEffect(UiSessionParams, { onExcessProperty: "error" });
const decodeSessionText = Schema.decodeUnknownEffect(UiSessionTextParams, {
  onExcessProperty: "error",
});
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(UiResponseFrame));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(UiEventFrame));

export interface UiGatewayConnection {
  readonly request: (request: UiRequestEnvelope) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface UiGatewayApi {
  readonly connect: (send: (frame: string) => void) => UiGatewayConnection;
}

export class UiGateway extends Context.Service<UiGateway, UiGatewayApi>()("ziggy/UiGateway") {}

type UiGatewayResult =
  | { readonly pong: true }
  | { readonly live: ReadonlyArray<UiLiveSession>; readonly stored: ReadonlyArray<SessionMetadata> }
  | { readonly session: UiSessionKey }
  | Record<string, never>;

const protocolFailure = (
  code: UiGatewayError["code"],
  message: string,
  cause?: unknown,
): UiGatewayError =>
  cause === undefined
    ? new UiGatewayError({ code, message })
    : new UiGatewayError({ code, message, cause });

const badParams = (method: string, cause: unknown): UiGatewayError =>
  protocolFailure("bad_params", `invalid params for ${method}`, cause);

const internal = (message: string, cause: unknown): UiGatewayError =>
  protocolFailure("internal", message, cause);

const responseText = (response: UiResponseFrame): string => encodeResponse(response);

const eventFrame = (session: UiSessionKey, event: ChatEvent): UiEventFrame => {
  switch (event.kind) {
    case "assistant-text":
      return {
        event: event.kind,
        session,
        payload: { delta: event.delta, snapshot: event.snapshot },
      };
    case "thinking":
      return { event: event.kind, session, payload: { delta: event.delta } };
    case "tool": {
      const payload = {
        phase: event.phase,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        failed: event.failed,
      };
      return event.detail === undefined
        ? { event: event.kind, session, payload }
        : { event: event.kind, session, payload: { ...payload, detail: event.detail } };
    }
    case "voice":
      return {
        event: event.kind,
        session,
        payload: { agentId: event.agentId, text: event.text },
      };
    case "settled":
      return { event: event.kind, session, payload: {} };
    case "error":
      return { event: event.kind, session, payload: { message: event.message } };
  }
};

const success = (id: UiRequestId, result: UiGatewayResult): UiResponseFrame => ({
  id,
  ok: true,
  result,
});

const rejected = (id: UiRequestId, error: UiGatewayError): UiResponseFrame => ({
  id,
  ok: false,
  error: { code: error.code, message: error.message },
});

export const makeUiGateway = (
  target: ProfileTarget,
  registry: ChatRegistryApi,
  sessions: SessionsApi,
  agent: ZiggyAgentApi,
): UiGatewayApi => ({
  connect: (send) => {
    const subscriptions = new Map<UiSessionKey, () => void>();

    const subscribe = (key: UiSessionKey): Effect.Effect<void, UiGatewayError> => {
      if (subscriptions.has(key)) return Effect.void;
      return registry
        .subscribe(key, (event) => {
          send(encodeEvent(eventFrame(key, event)));
        })
        .pipe(
          Effect.tap((unsubscribe) => Effect.sync(() => subscriptions.set(key, unsubscribe))),
          Effect.asVoid,
        );
    };

    const dispatch = (
      request: UiRequestEnvelope,
    ): Effect.Effect<UiGatewayResult, UiGatewayError> => {
      switch (request.method) {
        case "ping":
          return decodeEmpty(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
            Effect.as({ pong: true }),
          );
        case "session.list":
          return Effect.gen(function* () {
            yield* decodeEmpty(request.params).pipe(
              Effect.mapError((cause) => badParams(request.method, cause)),
            );
            const live = yield* registry.list;
            const stored = yield* sessions
              .list(target)
              .pipe(Effect.mapError((cause) => internal("could not list stored sessions", cause)));
            return { live, stored };
          });
        case "session.open":
          return Effect.gen(function* () {
            const params = yield* decodeOpen(request.params).pipe(
              Effect.mapError((cause) => badParams(request.method, cause)),
            );
            const key: UiSessionKey = `ui/${params.name}`;
            yield* registry.getOrOpenUi(
              key,
              agent.openChat(
                target,
                { kind: "local" },
                join(target.path, "sessions", "ui", params.name),
                "continue",
              ),
            );
            yield* subscribe(key);
            return { session: key };
          });
        case "session.watch":
          return Effect.gen(function* () {
            const params = yield* decodeSession(request.params).pipe(
              Effect.mapError((cause) => badParams(request.method, cause)),
            );
            yield* subscribe(params.session);
            return {};
          });
        case "prompt.submit":
          return Effect.gen(function* () {
            const params = yield* decodeSessionText(request.params).pipe(
              Effect.mapError((cause) => badParams(request.method, cause)),
            );
            yield* registry.submit(params.session, params.text);
            return {};
          });
        case "session.steer":
          return Effect.gen(function* () {
            const params = yield* decodeSessionText(request.params).pipe(
              Effect.mapError((cause) => badParams(request.method, cause)),
            );
            yield* registry.steer(params.session, params.text);
            return {};
          });
        case "session.abort":
          return Effect.gen(function* () {
            const params = yield* decodeSession(request.params).pipe(
              Effect.mapError((cause) => badParams(request.method, cause)),
            );
            yield* registry.abort(params.session);
            return {};
          });
        default:
          return Effect.fail(
            protocolFailure("unknown_method", `unknown UI gateway method ${request.method}`),
          );
      }
    };

    return {
      request: (request) =>
        dispatch(request).pipe(
          Effect.map((result) => success(request.id, result)),
          Effect.catch((error) => Effect.succeed(rejected(request.id, error))),
          Effect.tap((response) => Effect.sync(() => send(responseText(response)))),
          Effect.asVoid,
        ),
      close: Effect.sync(() => {
        for (const unsubscribe of subscriptions.values()) unsubscribe();
        subscriptions.clear();
      }),
    };
  },
});
