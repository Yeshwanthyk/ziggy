import type {
  Api,
  AssistantMessageEvent,
  CacheRetention,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "@earendil-works/pi-ai";
import type {
  ApprovalDecision,
  FinalModelResponse,
  FrozenSessionSnapshot,
  JsonObject,
  JsonValue,
  SessionEnvelope,
  SessionEvent,
  TurnStatus,
} from "@ziggy/protocol";
import { projectProviderContext, toFinalModelResponse } from "./context.ts";
const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 32;
const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 4;
const DEFAULT_STEER_MAILBOX_CAPACITY = 32;
const DEFAULT_FOLLOW_UP_MAILBOX_CAPACITY = 32;

import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

export interface ToolExecutionInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JsonObject;
  readonly signal: AbortSignal;
}

export interface ToolExecutionResult {
  readonly output: JsonValue;
  readonly isError: boolean;
}

export interface SessionTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  execute(input: ToolExecutionInput): Effect.Effect<JsonValue, SessionRuntimeError>;
}

export interface ToolHookInput extends ToolExecutionInput {}

export interface AfterToolHookInput extends ToolExecutionInput {
  readonly result: ToolExecutionResult;
}

export interface SessionWorld {
  /**
   * A live SessionRuntime must be the exclusive appender for its Session.
   * The headless runtime relies on its owner to uphold this contract; the daemon enforces
   * one live runtime per Session when process lifecycle ownership lands.
   */
  appendSession(
    sessionId: string,
    event: SessionEvent,
  ): Effect.Effect<SessionEnvelope, SessionRuntimeError>;
  readSession(
    sessionId: string,
    afterSeq: number,
  ): Effect.Effect<ReadonlyArray<SessionEnvelope>, SessionRuntimeError>;
}

export interface CreateSessionRuntimeOptions<TApi extends Api> {
  readonly sessionId: string;
  readonly snapshot: FrozenSessionSnapshot;
  readonly world: SessionWorld;
  readonly model: Model<TApi>;
  readonly streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
  readonly cacheRetention: CacheRetention;
  readonly reasoning?: SimpleStreamOptions["reasoning"];
  readonly nextTurnId: () => string;
  readonly nextStepId: () => string;
  readonly tools: ReadonlyArray<SessionTool>;
  readonly maxToolCallsPerStep?: number;
  readonly maxConcurrentToolCalls?: number;
  readonly steerMailboxCapacity?: number;
  readonly followUpMailboxCapacity?: number;
  readonly beforeToolCall?: (input: ToolHookInput) => Effect.Effect<void, SessionRuntimeError>;
  readonly afterToolCall?: (
    input: AfterToolHookInput,
  ) => Effect.Effect<ToolExecutionResult | undefined, SessionRuntimeError>;
}

export interface TurnStartResult {
  readonly turnId: string;
  readonly disposition: "started" | "queued";
}

export interface ApprovalResolutionResult {
  readonly outcome: "resolved" | "already-resolved";
}

export interface SessionSubscription {
  readonly replayThroughSeq: number;
  readonly unsubscribe: Effect.Effect<void>;
}

export interface SessionRuntime {
  startTurn(input: {
    readonly message: string;
  }): Effect.Effect<
    TurnStartResult,
    | InvalidSessionRuntimeInputError
    | SessionRuntimeClosedError
    | SessionRuntimeError
    | SessionRuntimeOverloadedError
  >;
  steer(input: {
    readonly expectedTurnId: string;
    readonly message: string;
  }): Effect.Effect<
    { readonly turnId: string },
    | InvalidSessionRuntimeInputError
    | SessionRuntimeError
    | SessionRuntimeOverloadedError
    | StaleTurnError
  >;
  interrupt(input: {
    readonly expectedTurnId: string;
  }): Effect.Effect<{ readonly turnId: string }, SessionRuntimeError | StaleTurnError>;
  resolveApproval(input: {
    readonly approvalId: string;
    readonly decision: ApprovalDecision;
  }): Effect.Effect<
    ApprovalResolutionResult,
    ApprovalDecisionNotAllowedError | SessionRuntimeClosedError | SessionRuntimeError
  >;
  readonly waitForIdle: Effect.Effect<void, SessionRuntimeError>;
  subscribe(input: {
    readonly sinceSeq: number;
    readonly onReplay?: (replay: ReadonlyArray<SessionEnvelope>, replayThroughSeq: number) => void;
    readonly onReplayStart?: (replayThroughSeq: number) => void;
    readonly onEnvelope: (envelope: SessionEnvelope) => void;
  }): Effect.Effect<
    SessionSubscription,
    | InvalidSessionRuntimeInputError
    | SessionRuntimeClosedError
    | SessionRuntimeError
    | SinceSeqBeyondTailError
  >;
  readonly close: Effect.Effect<void, SessionRuntimeError>;
}

interface FollowUp {
  readonly turnId: string;
  readonly message: string;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly message: string;
  readonly origin: "user" | "follow-up";
  readonly controller: AbortController;
  readonly steerMailbox: Queue.Queue<string>;
  readonly followUpMailbox: Queue.Queue<FollowUp>;
}

interface RuntimeState {
  readonly active: ActiveTurn | undefined;
  readonly activeFiber:
    | Fiber.Fiber<void, ProviderStreamFailure | SessionRuntimeError | SessionRuntimeOverloadedError>
    | undefined;
  readonly idle: Deferred.Deferred<void, SessionRuntimeError>;
  readonly closed: boolean;
}

interface Subscriber {
  active: boolean;
  readonly onEnvelope: (envelope: SessionEnvelope) => void;
}

interface ToolCallProjection {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
  readonly sourceIndex: number;
}

interface ToolWork {
  readonly call: ToolCallProjection;
  readonly input: ToolExecutionInput;
}

interface StepOutcome {
  readonly response: FinalModelResponse;
  readonly toolCalls: ReadonlyArray<ToolCallProjection>;
}

class ProviderStreamFailure extends Schema.TaggedErrorClass<ProviderStreamFailure>()(
  "ProviderStreamFailure",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class SessionRuntimeError extends Schema.TaggedErrorClass<SessionRuntimeError>()(
  "SessionRuntimeError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class SessionRuntimeClosedError extends Schema.TaggedErrorClass<SessionRuntimeClosedError>()(
  "SessionRuntimeClosedError",
  {},
) {
  override readonly message = "Session runtime is closed";
}

export class SinceSeqBeyondTailError extends Schema.TaggedErrorClass<SinceSeqBeyondTailError>()(
  "SinceSeqBeyondTailError",
  { sinceSeq: Schema.Finite, durableTailSeq: Schema.Finite },
) {
  override get message(): string {
    return `sinceSeq ${this.sinceSeq} exceeds durable Session tail ${this.durableTailSeq}`;
  }
}

export class StaleTurnError extends Schema.TaggedErrorClass<StaleTurnError>()("StaleTurnError", {
  expectedTurnId: Schema.String,
}) {
  override get message(): string {
    return `Expected active Turn ${this.expectedTurnId}`;
  }
}

export class ApprovalDecisionNotAllowedError extends Schema.TaggedErrorClass<ApprovalDecisionNotAllowedError>()(
  "ApprovalDecisionNotAllowedError",
  { approvalId: Schema.String, decision: Schema.Literals(["approve", "deny"]) },
) {
  override get message(): string {
    return `Approval ${this.approvalId} does not allow ${this.decision}`;
  }
}

export class InvalidSessionRuntimeInputError extends Schema.TaggedErrorClass<InvalidSessionRuntimeInputError>()(
  "InvalidSessionRuntimeInputError",
  { message: Schema.String },
) {}

export class SessionRuntimeOverloadedError extends Schema.TaggedErrorClass<SessionRuntimeOverloadedError>()(
  "SessionRuntimeOverloadedError",
  {
    resource: Schema.Literals(["tool-calls", "steer-mailbox", "follow-up-mailbox"]),
    capacity: Schema.Number,
  },
) {
  override get message(): string {
    return `Session runtime ${this.resource} capacity ${this.capacity} is exhausted`;
  }
}

export class SessionSnapshotMismatchError extends Schema.TaggedErrorClass<SessionSnapshotMismatchError>()(
  "SessionSnapshotMismatchError",
  {},
) {
  override readonly message = "Persisted Session snapshot does not match runtime snapshot";
}

export function createSessionRuntime<TApi extends Api>(
  options: CreateSessionRuntimeOptions<TApi>,
): Effect.Effect<
  SessionRuntime,
  InvalidSessionRuntimeInputError | SessionRuntimeError | SessionSnapshotMismatchError,
  Scope.Scope
> {
  const acquire = Effect.gen(function* () {
    yield* Effect.fromResult(validateRuntimeOptions(options));
    const resources = yield* Effect.gen(function* () {
      const gate = yield* Semaphore.make(1);
      const fibers = yield* FiberSet.make<
        void,
        ProviderStreamFailure | SessionRuntimeError | SessionRuntimeOverloadedError
      >();
      const idle = yield* Deferred.make<void, SessionRuntimeError>();
      yield* Deferred.succeed(idle, undefined);
      const state = yield* Ref.make<RuntimeState>({
        active: undefined,
        activeFiber: undefined,
        idle,
        closed: false,
      });
      return { fibers, gate, state };
    });

    const subscribers = new Set<Subscriber>();
    const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    const maxToolCallsPerStep = options.maxToolCallsPerStep ?? DEFAULT_MAX_TOOL_CALLS_PER_STEP;
    const maxConcurrentToolCalls =
      options.maxConcurrentToolCalls ?? DEFAULT_MAX_CONCURRENT_TOOL_CALLS;
    const steerMailboxCapacity = options.steerMailboxCapacity ?? DEFAULT_STEER_MAILBOX_CAPACITY;
    const followUpMailboxCapacity =
      options.followUpMailboxCapacity ?? DEFAULT_FOLLOW_UP_MAILBOX_CAPACITY;

    const withGate = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Semaphore.withPermit(resources.gate, effect);

    const publish = (envelope: SessionEnvelope): Effect.Effect<void> =>
      Effect.forEach(
        subscribers,
        (subscriber) =>
          subscriber.active
            ? Effect.try({
                try: () => subscriber.onEnvelope(envelope),
                catch: () => subscriber,
              }).pipe(
                Effect.catch((failed) =>
                  Effect.sync(() => {
                    failed.active = false;
                    subscribers.delete(failed);
                  }),
                ),
              )
            : Effect.void,
        { discard: true },
      );

    const appendUnlocked = (
      event: SessionEvent,
    ): Effect.Effect<SessionEnvelope, SessionRuntimeError> =>
      Effect.gen(function* () {
        const envelope = yield* options.world.appendSession(options.sessionId, event);
        yield* publish(envelope);
        return envelope;
      });

    const append = (event: SessionEvent): Effect.Effect<SessionEnvelope, SessionRuntimeError> =>
      withGate(appendUnlocked(event));

    const readAll = (): Effect.Effect<ReadonlyArray<SessionEnvelope>, SessionRuntimeError> =>
      withGate(options.world.readSession(options.sessionId, 0));

    const projectContext = (): Effect.Effect<Context, SessionRuntimeError> =>
      Effect.gen(function* () {
        const envelopes = yield* readAll();
        return yield* Effect.fromResult(projectProviderContext(envelopes)).pipe(
          Effect.mapError(runtimeError),
        );
      });

    const executeTool = (
      active: ActiveTurn,
      stepId: string,
      call: ToolCallProjection,
    ): Effect.Effect<ToolExecutionResult> => {
      const input: ToolExecutionInput = {
        sessionId: options.sessionId,
        turnId: active.turnId,
        stepId,
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        signal: active.controller.signal,
      };
      const work: ToolWork = { call, input };

      const execute = Effect.gen(function* () {
        if (active.controller.signal.aborted) {
          return yield* Effect.interrupt;
        }
        const initial = yield* Effect.gen(function* () {
          if (options.beforeToolCall !== undefined) {
            yield* options.beforeToolCall(work.input);
          }
          const tool = tools.get(work.call.name);
          if (tool === undefined) {
            return {
              output: { error: `Unknown tool: ${work.call.name}` },
              isError: true,
            } satisfies ToolExecutionResult;
          }
          return {
            output: yield* tool.execute(work.input),
            isError: false,
          } satisfies ToolExecutionResult;
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              // oxlint-disable-next-line ziggy-effect/no-unknown-error-message -- typed: SessionRuntimeError.message is the tool failure contract
              output: { error: error.message },
              isError: true,
            } satisfies ToolExecutionResult),
          ),
        );
        if (options.afterToolCall === undefined) {
          return initial;
        }
        const finalized = yield* options.afterToolCall({ ...work.input, result: initial });
        return finalized ?? initial;
      });

      return execute.pipe(
        Effect.catch((error) =>
          Effect.succeed({
            // oxlint-disable-next-line ziggy-effect/no-unknown-error-message -- typed: SessionRuntimeError.message is the hook failure contract
            output: { error: error.message },
            isError: true,
          }),
        ),
      );
    };

    const executeTools = (
      active: ActiveTurn,
      stepId: string,
      calls: ReadonlyArray<ToolCallProjection>,
    ): Effect.Effect<void, SessionRuntimeError> =>
      Effect.gen(function* () {
        for (const call of calls) {
          yield* append({
            type: "tool-call",
            sessionId: options.sessionId,
            turnId: active.turnId,
            stepId,
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
            sourceIndex: call.sourceIndex,
          });
        }

        const results = yield* Effect.forEach(calls, (call) => executeTool(active, stepId, call), {
          concurrency: maxConcurrentToolCalls,
        });
        if (active.controller.signal.aborted) {
          return yield* Effect.interrupt;
        }
        for (let index = 0; index < calls.length; index += 1) {
          const call = calls[index];
          const result = results[index];
          if (call === undefined || result === undefined) {
            return yield* new SessionRuntimeError({
              message: "Parallel tool execution lost source order",
              cause: { callCount: calls.length, resultCount: results.length, index },
            });
          }
          yield* append({
            type: "tool-result",
            sessionId: options.sessionId,
            turnId: active.turnId,
            stepId,
            toolCallId: call.id,
            output: result.output,
            isError: result.isError,
            sourceIndex: call.sourceIndex,
          });
        }
      });

    const runProviderStep = (
      active: ActiveTurn,
      stepId: string,
    ): Effect.Effect<
      StepOutcome,
      ProviderStreamFailure | SessionRuntimeError | SessionRuntimeOverloadedError
    > =>
      Effect.gen(function* () {
        yield* append({
          type: "step-started",
          sessionId: options.sessionId,
          turnId: active.turnId,
          stepId,
          provider: options.model.provider,
          model: options.model.id,
        });
        const context = yield* projectContext();
        const providerStream = yield* Effect.try({
          try: () =>
            options.streamSimple(options.model, context, {
              sessionId: options.sessionId,
              cacheRetention: options.cacheRetention,
              ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
              signal: active.controller.signal,
            }),
          catch: (cause) =>
            new ProviderStreamFailure({
              message: "Provider stream construction failed",
              cause,
            }),
        });

        let terminal: AssistantMessageEvent | undefined;
        const stream = Stream.fromAsyncIterable(
          providerStream,
          (cause) =>
            new ProviderStreamFailure({
              message: "Provider stream iteration failed",
              cause,
            }),
        );
        yield* Stream.runForEach(stream, (event) =>
          Effect.gen(function* () {
            if (event.type === "text_delta" || event.type === "thinking_delta") {
              yield* append({
                type: "model-chunk",
                sessionId: options.sessionId,
                turnId: active.turnId,
                stepId,
                contentIndex: event.contentIndex,
                kind: event.type === "text_delta" ? "text" : "thinking",
                delta: event.delta,
              });
            }
            if (event.type === "done" || event.type === "error") {
              if (terminal !== undefined) {
                return yield* new ProviderStreamFailure({
                  message: "Provider stream emitted multiple terminal events",
                  cause: "multiple terminal events",
                });
              }
              terminal = event;
            }
          }),
        );

        if (terminal === undefined) {
          return yield* new ProviderStreamFailure({
            message: "Provider stream ended without a terminal event",
            cause: "missing terminal event",
          });
        }
        if (terminal.type !== "done" && terminal.type !== "error") {
          return yield* new ProviderStreamFailure({
            message: "Provider stream terminal state was malformed",
            cause: "malformed terminal state",
          });
        }
        const message = terminal.type === "done" ? terminal.message : terminal.error;
        const projected = yield* Effect.fromResult(toFinalModelResponse(message)).pipe(
          Effect.mapError(runtimeError),
        );
        const response: FinalModelResponse =
          terminal.type === "error"
            ? { ...projected, errorMessage: "Provider request failed" }
            : projected;
        yield* append({
          type: "model-response",
          sessionId: options.sessionId,
          turnId: active.turnId,
          stepId,
          response,
        });
        if (terminal.type === "error") {
          return yield* new ProviderStreamFailure({
            message:
              terminal.reason === "aborted"
                ? "Provider stream was aborted"
                : (terminal.error.errorMessage ?? "Provider stream failed"),
            cause: terminal.error,
          });
        }
        const toolCalls = response.content
          .filter((content) => content.type === "toolCall")
          .map((content, sourceIndex) => ({
            id: content.id,
            name: content.name,
            input: content.arguments,
            sourceIndex,
          }));
        if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) {
          return yield* new ProviderStreamFailure({
            message: "Provider emitted duplicate tool call ids",
            cause: "duplicate tool call ids",
          });
        }
        if (response.stopReason === "toolUse" && toolCalls.length === 0) {
          return yield* new ProviderStreamFailure({
            message: "Provider stopped for tool use without tool calls",
            cause: "missing tool calls",
          });
        }
        if (toolCalls.length > maxToolCallsPerStep) {
          return yield* new SessionRuntimeOverloadedError({
            resource: "tool-calls",
            capacity: maxToolCallsPerStep,
          });
        }
        return { response, toolCalls };
      });

    const closeStep = (
      active: ActiveTurn,
      stepId: string,
      status: TurnStatus,
    ): Effect.Effect<void, SessionRuntimeError> =>
      append({
        type: "step-ended",
        sessionId: options.sessionId,
        turnId: active.turnId,
        stepId,
        status,
      }).pipe(Effect.asVoid);

    const launchTurn = (
      active: ActiveTurn,
      idle: Deferred.Deferred<void, SessionRuntimeError>,
    ): Effect.Effect<void, SessionRuntimeError> =>
      Effect.gen(function* () {
        const launch = yield* Deferred.make<void>();
        yield* appendUnlocked({
          type: "turn-started",
          sessionId: options.sessionId,
          turnId: active.turnId,
          message: active.message,
          origin: active.origin,
        });
        yield* Ref.set(resources.state, {
          active,
          activeFiber: undefined,
          idle,
          closed: false,
        });
        const fiber = yield* FiberSet.run(
          resources.fibers,
          Deferred.await(launch).pipe(Effect.andThen(runTurn(active))),
          { startImmediately: true },
        );
        yield* Ref.set(resources.state, {
          active,
          activeFiber: fiber,
          idle,
          closed: false,
        });
        yield* Deferred.succeed(launch, undefined);
      });

    const finishTurn = (
      active: ActiveTurn,
      openStepId: string | undefined,
      completed: boolean,
    ): Effect.Effect<void> =>
      withGate(
        Effect.gen(function* () {
          const status: TurnStatus = active.controller.signal.aborted
            ? "interrupted"
            : completed
              ? "completed"
              : "failed";
          let appendError: SessionRuntimeError | undefined;
          const appendFinal = (event: SessionEvent): Effect.Effect<void> =>
            appendUnlocked(event).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.sync(() => {
                  appendError ??= error;
                }),
              ),
            );
          if (openStepId !== undefined) {
            yield* appendFinal({
              type: "step-ended",
              sessionId: options.sessionId,
              turnId: active.turnId,
              stepId: openStepId,
              status,
            });
          }
          yield* appendFinal({
            type: "turn-ended",
            sessionId: options.sessionId,
            turnId: active.turnId,
            status,
          });

          const state = yield* Ref.get(resources.state);
          if (appendError !== undefined) {
            yield* Ref.set(resources.state, {
              active: undefined,
              activeFiber: undefined,
              idle: state.idle,
              closed: true,
            });
            yield* Deferred.fail(state.idle, appendError);
            return;
          }
          const followUp = yield* Queue.poll(active.followUpMailbox);
          if (state.closed) {
            yield* Ref.set(resources.state, {
              active: undefined,
              activeFiber: undefined,
              idle: state.idle,
              closed: true,
            });
            yield* Deferred.succeed(state.idle, undefined);
            return;
          }
          if (Option.isSome(followUp)) {
            const next: ActiveTurn = {
              turnId: followUp.value.turnId,
              message: followUp.value.message,
              origin: "follow-up",
              controller: new AbortController(),
              steerMailbox: yield* Queue.dropping<string>(steerMailboxCapacity),
              followUpMailbox: active.followUpMailbox,
            };
            const launched = yield* Effect.result(launchTurn(next, state.idle));
            if (Result.isFailure(launched)) {
              yield* Ref.set(resources.state, {
                active: undefined,
                activeFiber: undefined,
                idle: state.idle,
                closed: true,
              });
              yield* Deferred.fail(state.idle, launched.failure);
            }
            return;
          }
          yield* Ref.set(resources.state, {
            active: undefined,
            activeFiber: undefined,
            idle: state.idle,
            closed: false,
          });
          yield* Deferred.succeed(state.idle, undefined);
        }),
      );

    function runTurn(
      active: ActiveTurn,
    ): Effect.Effect<
      void,
      ProviderStreamFailure | SessionRuntimeError | SessionRuntimeOverloadedError
    > {
      let openStepId: string | undefined;
      let completed = false;
      const turn = Effect.gen(function* () {
        let continueTurn = true;
        while (continueTurn) {
          if (active.controller.signal.aborted) {
            return yield* Effect.interrupt;
          }
          const stepId = options.nextStepId();
          openStepId = stepId;
          const outcome = yield* runProviderStep(active, stepId);
          if (outcome.toolCalls.length > 0) {
            yield* executeTools(active, stepId, outcome.toolCalls);
          }
          yield* closeStep(active, stepId, "completed");
          openStepId = undefined;

          let hasSteer = false;
          while (Option.isSome(yield* Queue.poll(active.steerMailbox))) {
            hasSteer = true;
          }
          continueTurn = outcome.response.stopReason === "toolUse" || hasSteer;
        }
        completed = true;
      });

      return turn.pipe(
        Effect.ensuring(
          Effect.suspend(() => finishTurn(active, openStepId, completed)).pipe(
            Effect.andThen(Effect.sync(() => active.controller.abort())),
          ),
        ),
      );
    }

    const initialize = withGate(
      Effect.gen(function* () {
        const existing = yield* options.world.readSession(options.sessionId, 0);
        if (existing.length === 0) {
          yield* appendUnlocked({
            type: "session-started",
            sessionId: options.sessionId,
            snapshot: options.snapshot,
          });
          return;
        }
        const starts = existing.filter((envelope) => envelope.event.type === "session-started");
        const first = existing[0];
        if (
          first?.event.type !== "session-started" ||
          starts.length !== 1 ||
          !snapshotsEqual(first.event.snapshot, options.snapshot)
        ) {
          return yield* new SessionSnapshotMismatchError();
        }
      }),
    );
    yield* initialize;

    const startTurn: SessionRuntime["startTurn"] = (input) =>
      withGate(
        Effect.gen(function* () {
          yield* Effect.fromResult(validateMessage(input.message));
          const state = yield* Ref.get(resources.state);
          if (state.closed) {
            return yield* new SessionRuntimeClosedError();
          }
          const turnId = options.nextTurnId();
          if (state.active !== undefined) {
            if (yield* Queue.isFull(state.active.followUpMailbox)) {
              return yield* new SessionRuntimeOverloadedError({
                resource: "follow-up-mailbox",
                capacity: followUpMailboxCapacity,
              });
            }
            yield* appendUnlocked({
              type: "follow-up-received",
              sessionId: options.sessionId,
              turnId: state.active.turnId,
              message: input.message,
            });
            yield* Queue.offer(state.active.followUpMailbox, {
              turnId,
              message: input.message,
            });
            return { turnId, disposition: "queued" } satisfies TurnStartResult;
          }

          const idle = yield* Deferred.make<void, SessionRuntimeError>();
          const active: ActiveTurn = {
            turnId,
            message: input.message,
            origin: "user",
            controller: new AbortController(),
            steerMailbox: yield* Queue.dropping<string>(steerMailboxCapacity),
            followUpMailbox: yield* Queue.dropping<FollowUp>(followUpMailboxCapacity),
          };
          yield* launchTurn(active, idle);
          return { turnId, disposition: "started" } satisfies TurnStartResult;
        }),
      );

    const steer: SessionRuntime["steer"] = (input) =>
      withGate(
        Effect.gen(function* () {
          yield* Effect.fromResult(validateMessage(input.message));
          const state = yield* Ref.get(resources.state);
          if (
            state.active?.turnId !== input.expectedTurnId ||
            state.active.controller.signal.aborted
          ) {
            return yield* new StaleTurnError({ expectedTurnId: input.expectedTurnId });
          }
          if (yield* Queue.isFull(state.active.steerMailbox)) {
            return yield* new SessionRuntimeOverloadedError({
              resource: "steer-mailbox",
              capacity: steerMailboxCapacity,
            });
          }
          yield* appendUnlocked({
            type: "steer-received",
            sessionId: options.sessionId,
            turnId: state.active.turnId,
            message: input.message,
          });
          yield* Queue.offer(state.active.steerMailbox, input.message);
          return { turnId: state.active.turnId };
        }),
      );

    const interrupt: SessionRuntime["interrupt"] = (input) =>
      withGate(
        Effect.gen(function* () {
          const state = yield* Ref.get(resources.state);
          if (
            state.active?.turnId !== input.expectedTurnId ||
            state.active.controller.signal.aborted
          ) {
            return yield* new StaleTurnError({ expectedTurnId: input.expectedTurnId });
          }
          yield* appendUnlocked({
            type: "interrupt-received",
            sessionId: options.sessionId,
            turnId: state.active.turnId,
          });
          state.active.controller.abort();
          return { turnId: state.active.turnId, fiber: state.activeFiber };
        }),
      ).pipe(
        Effect.flatMap(({ turnId, fiber }) =>
          fiber === undefined
            ? Effect.succeed({ turnId })
            : Fiber.interrupt(fiber).pipe(Effect.as({ turnId })),
        ),
      );

    const resolveApproval: SessionRuntime["resolveApproval"] = (input) =>
      withGate(
        Effect.gen(function* () {
          const state = yield* Ref.get(resources.state);
          if (state.closed) {
            return yield* new SessionRuntimeClosedError();
          }
          const durable = yield* options.world.readSession(options.sessionId, 0);
          const pending = yield* Effect.fromResult(findPendingApproval(durable, input.approvalId));
          if (pending === undefined) {
            return { outcome: "already-resolved" } satisfies ApprovalResolutionResult;
          }
          if (!pending.choices.includes(input.decision)) {
            return yield* new ApprovalDecisionNotAllowedError({
              approvalId: input.approvalId,
              decision: input.decision,
            });
          }
          yield* appendUnlocked({
            type: "approval-resolved",
            sessionId: options.sessionId,
            turnId: pending.turnId,
            approvalId: input.approvalId,
            decision: input.decision,
          });
          return { outcome: "resolved" } satisfies ApprovalResolutionResult;
        }),
      );

    const waitForIdle: SessionRuntime["waitForIdle"] = withGate(Ref.get(resources.state)).pipe(
      Effect.flatMap((state) => Deferred.await(state.idle)),
    );

    const subscribe: SessionRuntime["subscribe"] = (input) =>
      withGate(
        Effect.gen(function* () {
          yield* Effect.fromResult(validateSinceSeq(input.sinceSeq));
          const state = yield* Ref.get(resources.state);
          if (state.closed) {
            return yield* new SessionRuntimeClosedError();
          }
          const durable = yield* options.world.readSession(options.sessionId, 0);
          const replayThroughSeq = durable.at(-1)?.seq ?? 0;
          if (input.sinceSeq > replayThroughSeq) {
            return yield* new SinceSeqBeyondTailError({
              sinceSeq: input.sinceSeq,
              durableTailSeq: replayThroughSeq,
            });
          }
          const replay = durable.filter((envelope) => envelope.seq > input.sinceSeq);
          const subscriber: Subscriber = { active: true, onEnvelope: input.onEnvelope };
          const onReplay = input.onReplay;
          const onReplayStart = input.onReplayStart;
          if (onReplay !== undefined) {
            yield* Effect.try({
              try: () => onReplay(replay, replayThroughSeq),
              catch: runtimeError,
            });
          } else {
            if (onReplayStart !== undefined) {
              yield* Effect.try({
                try: () => onReplayStart(replayThroughSeq),
                catch: runtimeError,
              });
            }
            for (const envelope of replay) {
              yield* Effect.try({
                try: () => input.onEnvelope(envelope),
                catch: runtimeError,
              });
            }
          }
          subscribers.add(subscriber);
          return {
            replayThroughSeq,
            unsubscribe: withGate(
              Effect.sync(() => {
                subscriber.active = false;
                subscribers.delete(subscriber);
              }),
            ),
          };
        }),
      );

    const close: SessionRuntime["close"] = Effect.suspend(() => {
      const cleanup = withGate(
        Effect.sync(() => {
          for (const subscriber of subscribers) {
            subscriber.active = false;
          }
          subscribers.clear();
        }),
      );

      return withGate(
        Effect.gen(function* () {
          const state = yield* Ref.get(resources.state);
          if (state.closed) {
            return state.activeFiber;
          }
          state.active?.controller.abort();
          yield* Ref.set(resources.state, { ...state, closed: true });
          return state.activeFiber;
        }),
      ).pipe(
        Effect.flatMap((fiber) => (fiber === undefined ? Effect.void : Fiber.interrupt(fiber))),
        Effect.andThen(withGate(Ref.get(resources.state))),
        Effect.flatMap((state) => Deferred.await(state.idle)),
        Effect.ensuring(cleanup),
      );
    });

    const runtime: SessionRuntime = {
      startTurn,
      steer,
      interrupt,
      resolveApproval,
      waitForIdle,
      subscribe,
      close,
    };
    yield* Effect.addFinalizer(() =>
      runtime.close.pipe(
        Effect.catch((error) =>
          Effect.logError("Session runtime finalizer failed", error).pipe(
            Effect.andThen(Effect.failCause(Cause.die(error))),
          ),
        ),
      ),
    );
    return runtime;
  });

  return acquire;
}

function findPendingApproval(
  envelopes: ReadonlyArray<SessionEnvelope>,
  approvalId: string,
): Result.Result<
  Extract<SessionEvent, { readonly type: "approval-requested" }> | undefined,
  SessionRuntimeError
> {
  let requested: Extract<SessionEvent, { readonly type: "approval-requested" }> | undefined;
  let pending = false;
  for (const envelope of envelopes) {
    const event = envelope.event;
    if (event.type === "approval-requested" && event.approvalId === approvalId) {
      if (requested !== undefined) {
        return Result.fail(
          new SessionRuntimeError({
            message: `Session contains duplicate approval ${approvalId}`,
          }),
        );
      }
      requested = event;
      pending = true;
      continue;
    }
    if (event.type === "approval-resolved" && event.approvalId === approvalId) {
      if (requested === undefined) {
        return Result.fail(
          new SessionRuntimeError({
            message: `Session resolves unknown approval ${approvalId}`,
          }),
        );
      }
      pending = false;
      continue;
    }
    if (
      requested !== undefined &&
      (event.type === "interrupt-received" || event.type === "turn-ended") &&
      event.turnId === requested.turnId
    ) {
      pending = false;
    }
  }
  return Result.succeed(pending ? requested : undefined);
}

function isJsonArray(value: JsonValue): value is ReadonlyArray<JsonValue> {
  return Array.isArray(value);
}

function snapshotsEqual(left: FrozenSessionSnapshot, right: FrozenSessionSnapshot): boolean {
  return (
    left.systemPrompt === right.systemPrompt &&
    left.tools.length === right.tools.length &&
    left.tools.every((tool, index) => {
      const other = right.tools[index];
      return (
        other !== undefined &&
        tool.name === other.name &&
        tool.description === other.description &&
        canonicalJson(tool.inputSchema) === canonicalJson(other.inputSchema)
      );
    })
  );
}

function canonicalJson(value: JsonValue): string {
  if (isJsonArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateRuntimeOptions<TApi extends Api>(
  options: CreateSessionRuntimeOptions<TApi>,
): Result.Result<void, InvalidSessionRuntimeInputError> {
  if (options.sessionId.length === 0) {
    return invalidInput("sessionId must be explicit and non-empty");
  }
  if (
    options.cacheRetention !== "none" &&
    options.cacheRetention !== "short" &&
    options.cacheRetention !== "long"
  ) {
    return invalidInput("cacheRetention must be explicit");
  }
  for (const [name, value] of [
    ["maxToolCallsPerStep", options.maxToolCallsPerStep ?? DEFAULT_MAX_TOOL_CALLS_PER_STEP],
    ["maxConcurrentToolCalls", options.maxConcurrentToolCalls ?? DEFAULT_MAX_CONCURRENT_TOOL_CALLS],
    ["steerMailboxCapacity", options.steerMailboxCapacity ?? DEFAULT_STEER_MAILBOX_CAPACITY],
    [
      "followUpMailboxCapacity",
      options.followUpMailboxCapacity ?? DEFAULT_FOLLOW_UP_MAILBOX_CAPACITY,
    ],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return invalidInput(`${name} must be a positive safe integer`);
    }
  }
  const implementations = new Map(options.tools.map((tool) => [tool.name, tool]));
  if (implementations.size !== options.tools.length) {
    return invalidInput("Tool implementation names must be unique");
  }
  const frozenNames = new Set(options.snapshot.tools.map((tool) => tool.name));
  if (frozenNames.size !== options.snapshot.tools.length) {
    return invalidInput("Frozen snapshot tool names must be unique");
  }
  if (implementations.size !== frozenNames.size) {
    return invalidInput("Tool implementations and frozen snapshot must form an exact bijection");
  }
  for (const frozen of options.snapshot.tools) {
    const implementation = implementations.get(frozen.name);
    if (implementation === undefined) {
      return invalidInput(`Missing tool implementation: ${frozen.name}`);
    }
    if (
      implementation.description !== frozen.description ||
      canonicalJson(implementation.inputSchema) !== canonicalJson(frozen.inputSchema)
    ) {
      return invalidInput(`Tool implementation differs from frozen snapshot: ${frozen.name}`);
    }
  }
  return Result.succeed(undefined);
}

function validateMessage(message: string): Result.Result<void, InvalidSessionRuntimeInputError> {
  if (message.length === 0) {
    return invalidInput("Turn message must be non-empty");
  }
  return Result.succeed(undefined);
}

function validateSinceSeq(sinceSeq: number): Result.Result<void, InvalidSessionRuntimeInputError> {
  if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
    return invalidInput("sinceSeq must be a non-negative safe integer");
  }
  return Result.succeed(undefined);
}

function runtimeError(cause: unknown): SessionRuntimeError {
  return new SessionRuntimeError({
    message: "Session runtime operation failed",
    cause,
  });
}

function invalidInput(message: string): Result.Result<never, InvalidSessionRuntimeInputError> {
  return Result.fail(new InvalidSessionRuntimeInputError({ message }));
}
