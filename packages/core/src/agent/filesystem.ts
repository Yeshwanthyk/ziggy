import type { Api } from "@earendil-works/pi-ai";
import type { FrozenTool, SessionEnvelope } from "@ziggy/protocol";
import { Cause, Effect, Exit, Result, Scope } from "effect";
import { openSession } from "../memory/session.ts";
import { createMemoryTool } from "../memory/tool.ts";
import type { FilesystemWorld } from "../world/filesystem.ts";
import {
  createSessionRuntime,
  type CreateSessionRuntimeOptions,
  type SessionRuntime,
  SessionRuntimeError,
  type SessionSubscription,
  type SessionTool,
  type SessionWorld,
} from "./runtime.ts";

type RuntimeCompositionOptions<TApi extends Api> = Omit<
  CreateSessionRuntimeOptions<TApi>,
  "snapshot" | "tools" | "world"
> & {
  readonly world: FilesystemWorld;
  readonly baseSystemPrompt: string;
  readonly tools: ReadonlyArray<SessionTool>;
};

export type CreateFilesystemSessionRuntimeOptions<TApi extends Api> =
  RuntimeCompositionOptions<TApi>;

export type ResumeFilesystemSessionOptions<TApi extends Api> = RuntimeCompositionOptions<TApi> & {
  readonly sinceSeq: number;
  readonly onEnvelope: (envelope: SessionEnvelope) => void;
};

export interface ResumedFilesystemSession {
  readonly runtime: SessionRuntime;
  readonly subscription: SessionSubscription;
}

export function createFilesystemSessionRuntime<TApi extends Api>(
  options: CreateFilesystemSessionRuntimeOptions<TApi>,
): Effect.Effect<SessionRuntime, SessionRuntimeError, Scope.Scope> {
  return Effect.gen(function* () {
    const memory = createMemoryTool(options.world);
    const tools: ReadonlyArray<SessionTool> = [memory, ...options.tools];
    yield* Effect.fromResult(requireUniqueToolNames(tools));
    const snapshot = yield* openSession({
      world: options.world,
      sessionId: options.sessionId,
      baseSystemPrompt: options.baseSystemPrompt,
      tools: freezeTools(tools),
    }).pipe(Effect.mapError(filesystemRuntimeFailure("Failed to open Session")));
    const world: SessionWorld = {
      appendSession: (sessionId, event) =>
        options.world
          .appendSession(sessionId, event)
          .pipe(Effect.mapError(filesystemRuntimeFailure("Failed to append Session event"))),
      readSession: (sessionId, afterSeq) =>
        options.world
          .readSession(sessionId, afterSeq)
          .pipe(Effect.mapError(filesystemRuntimeFailure("Failed to read Session"))),
    };
    return yield* createSessionRuntime({
      sessionId: options.sessionId,
      snapshot,
      world,
      model: options.model,
      streamSimple: options.streamSimple,
      cacheRetention: options.cacheRetention,
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      nextTurnId: options.nextTurnId,
      nextStepId: options.nextStepId,
      tools,
      ...(options.beforeToolCall === undefined ? {} : { beforeToolCall: options.beforeToolCall }),
      ...(options.afterToolCall === undefined ? {} : { afterToolCall: options.afterToolCall }),
    }).pipe(Effect.mapError(filesystemRuntimeFailure("Failed to create Session runtime")));
  });
}

export function resumeFilesystemSession<TApi extends Api>(
  options: ResumeFilesystemSessionOptions<TApi>,
): Effect.Effect<ResumedFilesystemSession, SessionRuntimeError, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* createFilesystemSessionRuntime(options);
    const subscription = yield* runtime
      .subscribe({
        sinceSeq: options.sinceSeq,
        onEnvelope: options.onEnvelope,
      })
      .pipe(
        Effect.mapError(filesystemRuntimeFailure("Failed to resume Session subscription")),
        Effect.catchCause((resumeCause) =>
          Effect.exit(runtime.close).pipe(
            Effect.flatMap((cleanup) =>
              Exit.isFailure(cleanup)
                ? Effect.failCause(Cause.combine(resumeCause, cleanup.cause))
                : Effect.failCause(resumeCause),
            ),
          ),
        ),
      );
    return { runtime, subscription };
  });
}

function requireUniqueToolNames(
  tools: ReadonlyArray<SessionTool>,
): Result.Result<void, SessionRuntimeError> {
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== tools.length) {
    return Result.fail(
      new SessionRuntimeError({
        message: "Filesystem Session tool names must be unique",
      }),
    );
  }
  return Result.succeed(undefined);
}

function freezeTools(tools: ReadonlyArray<SessionTool>): ReadonlyArray<FrozenTool> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
  }));
}

function filesystemRuntimeFailure(
  message: string,
): (cause: { readonly message: string }) => SessionRuntimeError {
  return (cause) =>
    new SessionRuntimeError({
      // oxlint-disable-next-line ziggy-effect/no-unknown-error-message -- typed: every mapped Session boundary error exposes its stable message contract
      message: cause.message.length > 0 ? cause.message : message,
      cause,
    });
}
