import { join } from "node:path";
import { Context, Effect, Schema } from "effect";
import {
  UiEmptyParams,
  UiEventFrame,
  UiExtensionAddParams,
  UiExtensionListForProfileParams,
  UiExtensionListForProfileResult,
  UiExtensionMutationResult,
  UiExtensionRemoveParams,
  UiExtensionValidationResult,
  UiExtensionValidateParams,
  UiGatewayError,
  UiGatewayResult as UiGatewayResultSchema,
  UiResponseFrame,
  UiSessionOpenParams,
  UiSessionParams,
  UiSessionTextParams,
  type UiExtensionFailure as UiExtensionFailureValue,
  type UiExtensionFailureStage,
  type UiExtensionOperation,
  type UiRequestEnvelope,
  type UiRequestId,
  type UiEventFrame as UiEventFrameValue,
  type UiSessionKey,
} from "../domain/ui-gateway";
import type { ProfileTarget } from "../domain/profile";
import type { ProfileExtensionError, ProfileExtensionsApi } from "../domain/profile-extension";
import type { ChatEvent, ZiggyAgentApi } from "./agent";
import type { ChatRegistryApi } from "./chat-registry";
import type { SessionsApi } from "./sessions";

const decodeEmpty = Schema.decodeUnknownEffect(UiEmptyParams, { onExcessProperty: "error" });
const decodeOpen = Schema.decodeUnknownEffect(UiSessionOpenParams, { onExcessProperty: "error" });
const decodeSession = Schema.decodeUnknownEffect(UiSessionParams, { onExcessProperty: "error" });
const decodeSessionText = Schema.decodeUnknownEffect(UiSessionTextParams, {
  onExcessProperty: "error",
});
const decodeExtensionListForProfile = Schema.decodeUnknownEffect(UiExtensionListForProfileParams, {
  onExcessProperty: "error",
});
const decodeExtensionAdd = Schema.decodeUnknownEffect(UiExtensionAddParams, {
  onExcessProperty: "error",
});
const decodeExtensionRemove = Schema.decodeUnknownEffect(UiExtensionRemoveParams, {
  onExcessProperty: "error",
});
const decodeExtensionValidate = Schema.decodeUnknownEffect(UiExtensionValidateParams, {
  onExcessProperty: "error",
});
const decodeExtensionListing = Schema.decodeUnknownEffect(UiExtensionListForProfileResult, {
  onExcessProperty: "error",
});
const decodeExtensionMutation = Schema.decodeUnknownEffect(UiExtensionMutationResult, {
  onExcessProperty: "error",
});
const decodeExtensionValidation = Schema.decodeUnknownEffect(UiExtensionValidationResult, {
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

type UiGatewayResult = typeof UiGatewayResultSchema.Type;

const MAX_UI_GATEWAY_MESSAGE = 360;
const MAX_UI_EXTENSION_ID = 128;
const MAX_UI_EXTENSION_CODE = 64;
const MAX_UI_EXTENSION_SOURCE = 240;

const boundedFailureText = (value: string, maximum: number, fallback: string): string => {
  const normalized = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  let bounded = "";
  for (const character of normalized) {
    if (bounded.length + character.length > maximum) break;
    bounded += character;
  }
  return bounded || fallback;
};

const boundedFailureCode = (value: string): string =>
  boundedFailureText(
    value.replace(/[^A-Za-z0-9_.-]+/gu, "_"),
    MAX_UI_EXTENSION_CODE,
    "extension_operation_failed",
  );

const boundedExtensionId = (value: string): string => {
  const candidate = boundedFailureText(value, MAX_UI_EXTENSION_ID, "extension").replace(/-+$/u, "");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(candidate) ? candidate : "extension";
};

interface MutableExtensionFailureMetadata {
  id?: string;
  source?: string;
}

type ExtensionFailureMetadata = {
  readonly id?: string;
  readonly source?: string;
};

const failureMetadata = (id: string | undefined, source?: string): ExtensionFailureMetadata => {
  const metadata: MutableExtensionFailureMetadata = {};
  if (id !== undefined) metadata.id = id;
  if (source !== undefined) metadata.source = source;
  return metadata;
};

const makeExtensionFailure = (
  operation: UiExtensionOperation,
  stage: UiExtensionFailureStage,
  code: string,
  message: string,
  selectionChanged: boolean,
  metadata: ExtensionFailureMetadata = {},
): UiExtensionFailureValue => {
  const base = {
    operation,
    stage,
    code: boundedFailureCode(code),
    message: boundedFailureText(
      message,
      MAX_UI_GATEWAY_MESSAGE,
      "Profile extension operation failed",
    ),
    selectionChanged,
  };
  if (metadata.id !== undefined && metadata.source !== undefined) {
    return {
      ...base,
      id: boundedExtensionId(metadata.id),
      source: boundedFailureText(metadata.source, MAX_UI_EXTENSION_SOURCE, "unavailable"),
    };
  }
  if (metadata.id !== undefined) {
    return { ...base, id: boundedExtensionId(metadata.id) };
  }
  if (metadata.source !== undefined) {
    return {
      ...base,
      source: boundedFailureText(metadata.source, MAX_UI_EXTENSION_SOURCE, "unavailable"),
    };
  }
  return base;
};

const extensionFailureProjection = (
  operation: UiExtensionOperation,
  failure: ProfileExtensionError,
  requestedId?: string,
): UiExtensionFailureValue => {
  switch (failure._tag) {
    case "ProfileExtensionInvalid":
      return makeExtensionFailure(
        operation,
        "validate",
        "invalid",
        failure.message,
        false,
        failureMetadata(requestedId),
      );
    case "ProfileFileSystemError":
      return makeExtensionFailure(
        operation,
        "filesystem",
        failure.code ?? "filesystem_error",
        failure.message,
        false,
        failureMetadata(requestedId),
      );
    case "ExtensionCatalogInvalid":
      return makeExtensionFailure(
        operation,
        "catalog",
        "catalog_invalid",
        failure.message,
        false,
        failureMetadata(requestedId, failure.source),
      );
    case "ExtensionCatalogUnavailable":
      return makeExtensionFailure(
        operation,
        "catalog",
        "catalog_unavailable",
        failure.message,
        false,
        failureMetadata(requestedId),
      );
    case "ExtensionCatalogInstallFailed":
      return makeExtensionFailure(
        operation,
        failure.reason,
        "catalog_install_failed",
        failure.message,
        false,
        failureMetadata(failure.id, failure.path),
      );
    case "ProfileExtensionPreflightFailed":
      return makeExtensionFailure(
        operation,
        failure.stage,
        "preflight_failed",
        failure.message,
        false,
        failureMetadata(requestedId),
      );
    case "ProfileExtensionLockFailed":
      return makeExtensionFailure(
        operation,
        "lock",
        "lock_failed",
        failure.message,
        false,
        failureMetadata(requestedId),
      );
    case "ProfileExtensionRollbackFailed":
      return makeExtensionFailure(
        operation,
        "rollback",
        "rollback_failed",
        failure.message,
        true,
        failureMetadata(requestedId),
      );
  }
};

const protocolFailure = (
  code: UiGatewayError["code"],
  message: string,
  cause?: unknown,
  details?: UiExtensionFailureValue,
): UiGatewayError => {
  const boundedMessage = boundedFailureText(
    message,
    MAX_UI_GATEWAY_MESSAGE,
    "UI gateway request failed",
  );
  if (cause !== undefined && details !== undefined) {
    return new UiGatewayError({ code, message: boundedMessage, cause, details });
  }
  if (cause !== undefined) {
    return new UiGatewayError({ code, message: boundedMessage, cause });
  }
  if (details !== undefined) {
    return new UiGatewayError({ code, message: boundedMessage, details });
  }
  return new UiGatewayError({ code, message: boundedMessage });
};

const badParams = (method: string, cause: unknown): UiGatewayError =>
  protocolFailure("bad_params", `invalid params for ${method}`, cause);

const internal = (message: string, cause: unknown): UiGatewayError =>
  protocolFailure("internal", message, cause);

const extensionFailure = (
  operation: UiExtensionOperation,
  cause: ProfileExtensionError,
  requestedId?: string,
): UiGatewayError =>
  protocolFailure(
    "internal",
    `could not ${operation} Profile extensions`,
    cause,
    extensionFailureProjection(operation, cause, requestedId),
  );

const invalidExtensionResult = (
  operation: UiExtensionOperation,
  cause: unknown,
  requestedId?: string,
): UiGatewayError =>
  protocolFailure(
    "internal",
    `invalid Profile extension ${operation} response`,
    cause,
    makeExtensionFailure(
      operation,
      "response",
      "invalid_response",
      "Profile extension response failed validation",
      false,
      failureMetadata(requestedId),
    ),
  );

const responseText = (response: UiResponseFrame): string => encodeResponse(response);

const eventFrame = (session: UiSessionKey, event: ChatEvent): UiEventFrameValue => {
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

const rejected = (id: UiRequestId, error: UiGatewayError): UiResponseFrame => {
  const responseError = {
    code: error.code,
    message: boundedFailureText(error.message, MAX_UI_GATEWAY_MESSAGE, "UI gateway request failed"),
  };
  if (error.details !== undefined) {
    return { id, ok: false, error: { ...responseError, details: error.details } };
  }
  return { id, ok: false, error: responseError };
};

export const makeUiGateway = (
  target: ProfileTarget,
  registry: ChatRegistryApi,
  sessions: SessionsApi,
  agent: ZiggyAgentApi,
  repositoryRoot: string,
  profileExtensions: ProfileExtensionsApi,
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
            return {
              live,
              stored: stored.map(({ id, path, createdAt }) => ({ id, path, createdAt })),
            };
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
        case "extension.list-for-profile":
          return Effect.gen(function* () {
            yield* decodeExtensionListForProfile(request.params).pipe(
              Effect.mapError((cause) => badParams(request.method, cause)),
            );
            const result = yield* profileExtensions
              .listForProfile(target.path, repositoryRoot)
              .pipe(Effect.mapError((cause) => extensionFailure("list", cause)));
            return yield* decodeExtensionListing(result).pipe(
              Effect.mapError((cause) => invalidExtensionResult("list", cause)),
            );
          });
        case "extension.add":
          return Effect.gen(function* () {
            const params = yield* decodeExtensionAdd(request.params).pipe(
              Effect.mapError((cause) => badParams(request.method, cause)),
            );
            const result = yield* profileExtensions
              .add(target, repositoryRoot, params.id)
              .pipe(Effect.mapError((cause) => extensionFailure("add", cause, params.id)));
            return yield* decodeExtensionMutation(result).pipe(
              Effect.mapError((cause) => invalidExtensionResult("add", cause, params.id)),
            );
          });
        case "extension.remove":
          return Effect.gen(function* () {
            const params = yield* decodeExtensionRemove(request.params).pipe(
              Effect.mapError((cause) => badParams(request.method, cause)),
            );
            const result = yield* profileExtensions
              .remove(target, repositoryRoot, params.id)
              .pipe(Effect.mapError((cause) => extensionFailure("remove", cause, params.id)));
            return yield* decodeExtensionMutation(result).pipe(
              Effect.mapError((cause) => invalidExtensionResult("remove", cause, params.id)),
            );
          });
        case "extension.validate":
          return Effect.gen(function* () {
            yield* decodeExtensionValidate(request.params).pipe(
              Effect.mapError((cause) => badParams(request.method, cause)),
            );
            const result = yield* profileExtensions
              .validate(target, repositoryRoot)
              .pipe(Effect.mapError((cause) => extensionFailure("validate", cause)));
            return yield* decodeExtensionValidation(result).pipe(
              Effect.mapError((cause) => invalidExtensionResult("validate", cause)),
            );
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
