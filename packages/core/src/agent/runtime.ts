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
  FinalModelResponse,
  FrozenSessionSnapshot,
  JsonObject,
  JsonValue,
  SessionEnvelope,
  SessionEvent,
  TurnStatus,
} from "@ziggy/protocol";
import { projectProviderContext, toFinalModelResponse } from "./context.ts";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
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
  execute(input: ToolExecutionInput): Promise<JsonValue>;
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
  appendSession(sessionId: string, event: SessionEvent): Promise<SessionEnvelope>;
  readSession(sessionId: string, afterSeq: number): Promise<ReadonlyArray<SessionEnvelope>>;
}

export interface CreateSessionRuntimeOptions<TApi extends Api> {
  readonly sessionId: string;
  readonly snapshot: FrozenSessionSnapshot;
  readonly world: SessionWorld;
  readonly model: Model<TApi>;
  readonly streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
  readonly cacheRetention: CacheRetention;
  readonly nextTurnId: () => string;
  readonly nextStepId: () => string;
  readonly tools: ReadonlyArray<SessionTool>;
  readonly beforeToolCall?: (input: ToolHookInput) => Promise<void>;
  readonly afterToolCall?: (input: AfterToolHookInput) => Promise<ToolExecutionResult | undefined>;
}

export interface TurnStartResult {
  readonly turnId: string;
  readonly disposition: "started" | "queued";
}

export interface SessionSubscription {
  readonly replayThroughSeq: number;
  unsubscribe(): void;
}

export interface SessionRuntime {
  startTurn(input: { readonly message: string }): Promise<TurnStartResult>;
  steer(input: {
    readonly expectedTurnId: string;
    readonly message: string;
  }): Promise<{ readonly turnId: string }>;
  interrupt(input: { readonly expectedTurnId: string }): Promise<{ readonly turnId: string }>;
  waitForIdle(): Promise<void>;
  subscribe(input: {
    readonly sinceSeq: number;
    readonly onEnvelope: (envelope: SessionEnvelope) => void;
  }): Promise<SessionSubscription>;
  close(): Promise<void>;
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
  readonly activeFiber: Fiber.Fiber<void, never> | undefined;
  readonly idle: Deferred.Deferred<void, Error>;
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

class ProviderStreamFailure extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderStreamFailure";
  }
}

class RuntimeClosed extends Error {
  constructor() {
    super("Session runtime is closed");
    this.name = "RuntimeClosed";
  }
}

export async function createSessionRuntime<TApi extends Api>(
  options: CreateSessionRuntimeOptions<TApi>,
): Promise<SessionRuntime> {
  validateRuntimeOptions(options);

  const resources = await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Semaphore.make(1);
      const scope = yield* Scope.make();
      const idle = yield* Deferred.make<void, Error>();
      yield* Deferred.succeed(idle, undefined);
      const state = yield* Ref.make<RuntimeState>({
        active: undefined,
        activeFiber: undefined,
        idle,
        closed: false,
      });
      return { gate, scope, state };
    }),
  );

  const subscribers = new Set<Subscriber>();
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));

  const withGate = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Semaphore.withPermit(resources.gate, effect);

  const fromPromise = <A>(operation: () => Promise<A>): Effect.Effect<A, Error> =>
    Effect.tryPromise({
      try: operation,
      catch: toError,
    });

  const publish = (envelope: SessionEnvelope): Effect.Effect<void> =>
    Effect.sync(() => {
      for (const subscriber of subscribers) {
        if (!subscriber.active) {
          continue;
        }
        try {
          subscriber.onEnvelope(envelope);
        } catch {
          subscriber.active = false;
          subscribers.delete(subscriber);
        }
      }
    });

  const appendUnlocked = (event: SessionEvent): Effect.Effect<SessionEnvelope, Error> =>
    Effect.gen(function* () {
      const envelope = yield* fromPromise(() =>
        options.world.appendSession(options.sessionId, event),
      );
      yield* publish(envelope);
      return envelope;
    });

  const append = (event: SessionEvent): Effect.Effect<SessionEnvelope, Error> =>
    withGate(appendUnlocked(event));

  const readAll = (): Effect.Effect<ReadonlyArray<SessionEnvelope>, Error> =>
    withGate(fromPromise(() => options.world.readSession(options.sessionId, 0)));

  const projectContext = (): Effect.Effect<Context, Error> =>
    Effect.gen(function* () {
      const envelopes = yield* readAll();
      return projectProviderContext(envelopes);
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
          yield* fromPromise(() => options.beforeToolCall?.(work.input) ?? Promise.resolve());
        }
        const tool = tools.get(work.call.name);
        if (tool === undefined) {
          return {
            output: { error: `Unknown tool: ${work.call.name}` },
            isError: true,
          } satisfies ToolExecutionResult;
        }
        return {
          output: yield* fromPromise(() => tool.execute(work.input)),
          isError: false,
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            output: { error: error.message },
            isError: true,
          } satisfies ToolExecutionResult),
        ),
      );
      if (options.afterToolCall === undefined) {
        return initial;
      }
      const finalized = yield* fromPromise(
        () =>
          options.afterToolCall?.({ ...work.input, result: initial }) ?? Promise.resolve(undefined),
      );
      return finalized ?? initial;
    });

    return execute.pipe(
      Effect.catch((error) =>
        Effect.succeed({
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
  ): Effect.Effect<void, Error> =>
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
        concurrency: "unbounded",
      });
      if (active.controller.signal.aborted) {
        return yield* Effect.interrupt;
      }
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        const result = results[index];
        if (call === undefined || result === undefined) {
          return yield* Effect.die(new Error("Parallel tool execution lost source order"));
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
  ): Effect.Effect<StepOutcome, Error | ProviderStreamFailure> =>
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
            signal: active.controller.signal,
          }),
        catch: (cause) => new ProviderStreamFailure("Provider stream construction failed", cause),
      });

      let terminal: AssistantMessageEvent | undefined;
      const stream = Stream.fromAsyncIterable(
        providerStream,
        (cause) => new ProviderStreamFailure("Provider stream iteration failed", cause),
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
              return yield* Effect.fail(
                new ProviderStreamFailure("Provider stream emitted multiple terminal events"),
              );
            }
            terminal = event;
          }
        }),
      );

      if (terminal === undefined) {
        return yield* Effect.fail(
          new ProviderStreamFailure("Provider stream ended without a terminal event"),
        );
      }
      if (terminal.type !== "done" && terminal.type !== "error") {
        return yield* Effect.fail(
          new ProviderStreamFailure("Provider stream terminal state was malformed"),
        );
      }
      const message = terminal.type === "done" ? terminal.message : terminal.error;
      const response = toFinalModelResponse(message);
      yield* append({
        type: "model-response",
        sessionId: options.sessionId,
        turnId: active.turnId,
        stepId,
        response,
      });
      if (terminal.type === "error") {
        return yield* Effect.fail(
          new ProviderStreamFailure(
            terminal.reason === "aborted"
              ? "Provider stream was aborted"
              : (terminal.error.errorMessage ?? "Provider stream failed"),
          ),
        );
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
        return yield* Effect.fail(
          new ProviderStreamFailure("Provider emitted duplicate tool call ids"),
        );
      }
      if (response.stopReason === "toolUse" && toolCalls.length === 0) {
        return yield* Effect.fail(
          new ProviderStreamFailure("Provider stopped for tool use without tool calls"),
        );
      }
      return { response, toolCalls };
    });

  const closeStep = (
    active: ActiveTurn,
    stepId: string,
    status: TurnStatus,
  ): Effect.Effect<void, Error> =>
    append({
      type: "step-ended",
      sessionId: options.sessionId,
      turnId: active.turnId,
      stepId,
      status,
    }).pipe(Effect.asVoid);

  const launchTurn = (
    active: ActiveTurn,
    idle: Deferred.Deferred<void, Error>,
  ): Effect.Effect<void, Error> =>
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
      const fiber = yield* Effect.forkIn(
        Deferred.await(launch).pipe(Effect.andThen(runTurn(active)), Effect.orDie),
        resources.scope,
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
        let appendError: Error | undefined;
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
            steerMailbox: yield* Queue.unbounded<string>(),
            followUpMailbox: active.followUpMailbox,
          };
          const launched = yield* Effect.result(launchTurn(next, state.idle));
          if (launched._tag === "Failure") {
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
    ).pipe(Effect.orDie);

  function runTurn(active: ActiveTurn): Effect.Effect<void, Error | ProviderStreamFailure> {
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
      const existing = yield* fromPromise(() => options.world.readSession(options.sessionId, 0));
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
        return yield* Effect.fail(
          new Error("Persisted Session snapshot does not match runtime snapshot"),
        );
      }
    }),
  );
  await Effect.runPromise(initialize);

  const startTurn = (input: { readonly message: string }): Promise<TurnStartResult> =>
    Effect.runPromise(
      withGate(
        Effect.gen(function* () {
          validateMessage(input.message);
          const state = yield* Ref.get(resources.state);
          if (state.closed) {
            return yield* Effect.fail(new RuntimeClosed());
          }
          const turnId = options.nextTurnId();
          if (state.active !== undefined) {
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
            return { turnId, disposition: "queued" };
          }

          const idle = yield* Deferred.make<void, Error>();
          const active: ActiveTurn = {
            turnId,
            message: input.message,
            origin: "user",
            controller: new AbortController(),
            steerMailbox: yield* Queue.unbounded<string>(),
            followUpMailbox: yield* Queue.unbounded<FollowUp>(),
          };
          yield* launchTurn(active, idle);
          return { turnId, disposition: "started" };
        }),
      ),
    );

  const steer = (input: {
    readonly expectedTurnId: string;
    readonly message: string;
  }): Promise<{ readonly turnId: string }> =>
    Effect.runPromise(
      withGate(
        Effect.gen(function* () {
          validateMessage(input.message);
          const state = yield* Ref.get(resources.state);
          if (state.active?.turnId !== input.expectedTurnId) {
            return yield* Effect.fail(new Error(`Expected active Turn ${input.expectedTurnId}`));
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
      ),
    );

  const interrupt = (input: {
    readonly expectedTurnId: string;
  }): Promise<{ readonly turnId: string }> =>
    Effect.runPromise(
      withGate(
        Effect.gen(function* () {
          const state = yield* Ref.get(resources.state);
          if (state.active?.turnId !== input.expectedTurnId) {
            return yield* Effect.fail(new Error(`Expected active Turn ${input.expectedTurnId}`));
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
      ),
    );

  const waitForIdle = (): Promise<void> =>
    Effect.runPromise(
      withGate(Ref.get(resources.state)).pipe(
        Effect.flatMap((state) => Deferred.await(state.idle)),
      ),
    );

  const subscribe = (input: {
    readonly sinceSeq: number;
    readonly onEnvelope: (envelope: SessionEnvelope) => void;
  }): Promise<SessionSubscription> =>
    Effect.runPromise(
      withGate(
        Effect.gen(function* () {
          validateSinceSeq(input.sinceSeq);
          const state = yield* Ref.get(resources.state);
          if (state.closed) {
            return yield* Effect.fail(new RuntimeClosed());
          }
          const durable = yield* fromPromise(() => options.world.readSession(options.sessionId, 0));
          const replay = durable.filter((envelope) => envelope.seq > input.sinceSeq);
          const subscriber: Subscriber = { active: true, onEnvelope: input.onEnvelope };
          for (const envelope of replay) {
            yield* Effect.try({
              try: () => input.onEnvelope(envelope),
              catch: toError,
            });
          }
          subscribers.add(subscriber);
          const replayThroughSeq = durable.at(-1)?.seq ?? 0;
          return {
            replayThroughSeq,
            unsubscribe() {
              subscriber.active = false;
              Effect.runFork(
                withGate(
                  Effect.sync(() => {
                    subscribers.delete(subscriber);
                  }),
                ),
              );
            },
          };
        }),
      ),
    );

  const close = (): Promise<void> => {
    const cleanup = withGate(
      Effect.sync(() => {
        for (const subscriber of subscribers) {
          subscriber.active = false;
        }
        subscribers.clear();
      }),
    ).pipe(Effect.andThen(Scope.close(resources.scope, Exit.void)));

    return Effect.runPromise(
      withGate(
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
      ),
    );
  };

  return { startTurn, steer, interrupt, waitForIdle, subscribe, close };
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
): void {
  if (options.sessionId.length === 0) {
    throw new Error("sessionId must be explicit and non-empty");
  }
  if (
    options.cacheRetention !== "none" &&
    options.cacheRetention !== "short" &&
    options.cacheRetention !== "long"
  ) {
    throw new Error("cacheRetention must be explicit");
  }
  const implementations = new Map(options.tools.map((tool) => [tool.name, tool]));
  if (implementations.size !== options.tools.length) {
    throw new Error("Tool implementation names must be unique");
  }
  const frozenNames = new Set(options.snapshot.tools.map((tool) => tool.name));
  if (frozenNames.size !== options.snapshot.tools.length) {
    throw new Error("Frozen snapshot tool names must be unique");
  }
  if (implementations.size !== frozenNames.size) {
    throw new Error("Tool implementations and frozen snapshot must form an exact bijection");
  }
  for (const frozen of options.snapshot.tools) {
    const implementation = implementations.get(frozen.name);
    if (implementation === undefined) {
      throw new Error(`Missing tool implementation: ${frozen.name}`);
    }
    if (
      implementation.description !== frozen.description ||
      canonicalJson(implementation.inputSchema) !== canonicalJson(frozen.inputSchema)
    ) {
      throw new Error(`Tool implementation differs from frozen snapshot: ${frozen.name}`);
    }
  }
}

function validateMessage(message: string): void {
  if (message.length === 0) {
    throw new Error("Turn message must be non-empty");
  }
}

function validateSinceSeq(sinceSeq: number): void {
  if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
    throw new Error("sinceSeq must be a non-negative safe integer");
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
