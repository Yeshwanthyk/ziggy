import {
  createInitialState,
  initialCommands,
  startZiggyTuiHost,
  type TuiAction,
  type TuiCommand,
  type ZiggyTuiHost,
} from "@ziggy/tui";
import type { SessionSummary } from "@ziggy/protocol";
import { Deferred, Effect, FiberSet, Predicate, Queue, Ref, Scope } from "effect";
import type { AttachClient, AttachClientError, AttachSubscription } from "./attach-client.ts";

export type TuiHostFactory = (
  emit: (command: TuiCommand) => void,
) => Effect.Effect<ZiggyTuiHost, never, Scope.Scope>;

const COMMAND_QUEUE_CAPACITY = 32;

interface TuiCommandInterpreter {
  readonly execute: (command: TuiCommand) => Effect.Effect<void, never>;
  readonly close: Effect.Effect<void, AttachClientError>;
}

function createTuiCommandInterpreter(
  client: AttachClient,
  dispatch: (action: TuiAction) => Effect.Effect<void>,
  currentGeneration: () => number,
): Effect.Effect<TuiCommandInterpreter, never, Scope.Scope> {
  return Effect.gen(function* () {
    const readers = yield* FiberSet.make<void, never>();
    const subscription = yield* Ref.make<AttachSubscription | undefined>(undefined);
    const closed = yield* Ref.make(false);
    const summaries = new Map<string, SessionSummary>();

    const stopReaders = FiberSet.clear(readers);

    const close: Effect.Effect<void, AttachClientError> = Effect.suspend(() =>
      Ref.getAndSet(closed, true).pipe(
        Effect.flatMap((alreadyClosed) => {
          if (alreadyClosed) return Effect.void;
          return Ref.getAndSet(subscription, undefined).pipe(
            Effect.flatMap((current) =>
              stopReaders.pipe(Effect.andThen(current === undefined ? Effect.void : current.close)),
            ),
          );
        }),
      ),
    );

    const dispatchCurrent = (actionGeneration: number, action: TuiAction): Effect.Effect<void> =>
      Ref.get(closed).pipe(
        Effect.flatMap((isClosed) =>
          isClosed || actionGeneration !== currentGeneration() ? Effect.void : dispatch(action),
        ),
      );

    const readSubscription = (
      current: AttachSubscription,
      readerGeneration: number,
      reportFailure: (error: AttachClientError) => Effect.Effect<void>,
    ): Effect.Effect<void> =>
      Effect.forever(
        current.next.pipe(
          Effect.flatMap((envelope) =>
            dispatchCurrent(readerGeneration, {
              type: "envelope-received",
              generation: readerGeneration,
              envelope,
            }),
          ),
        ),
      ).pipe(Effect.catch(reportFailure));

    const readChanges = (
      current: AttachSubscription,
      readerGeneration: number,
      summary: SessionSummary,
      reportFailure: (error: AttachClientError) => Effect.Effect<void>,
    ): Effect.Effect<void> =>
      Effect.forever(
        (current.nextChange ?? Effect.never).pipe(
          Effect.flatMap((change) => {
            if (change.type === "connection-lost") {
              return dispatchCurrent(readerGeneration, {
                type: "connection-lost",
                generation: readerGeneration,
                message: "Attach connection closed.",
              });
            }
            if (change.type === "retry-started") {
              return dispatchCurrent(readerGeneration, {
                type: "retry-started",
                generation: readerGeneration,
                attempt: change.attempt,
              });
            }
            return dispatchCurrent(readerGeneration, {
              type: "replay-started",
              generation: readerGeneration,
              session: summary,
              replayThroughSeq: change.replayThroughSeq,
            });
          }),
        ),
      ).pipe(Effect.catch(reportFailure));

    const replaceSubscription = (
      command: Extract<TuiCommand, { readonly type: "resume-session" }>,
    ): Effect.Effect<void, AttachClientError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return;
        if (command.generation !== currentGeneration()) return;
        yield* stopReaders;
        const previous = yield* Ref.getAndSet(subscription, undefined);
        if (previous !== undefined) yield* previous.close;

        const next = yield* client.subscribe(command.sessionId, command.sinceSeq);
        if ((yield* Ref.get(closed)) || command.generation !== currentGeneration()) {
          yield* next.close;
          return;
        }
        const summary = summaries.get(command.sessionId);
        if (summary === undefined) {
          yield* next.close;
          yield* dispatchCurrent(command.generation, {
            type: "failure",
            generation: command.generation,
            message: "Selected Session summary is unavailable.",
          });
          return;
        }
        yield* Ref.set(subscription, next);
        yield* dispatchCurrent(command.generation, {
          type: "replay-started",
          generation: command.generation,
          session: summary,
          replayThroughSeq: yield* next.replayThroughSeq,
        });
        const failureReported = yield* Ref.make(false);
        const reportSubscriptionFailure = (error: AttachClientError): Effect.Effect<void> =>
          Ref.getAndSet(failureReported, true).pipe(
            Effect.flatMap((alreadyReported) =>
              alreadyReported
                ? Effect.void
                : dispatchCurrent(command.generation, {
                    type: "failure",
                    generation: command.generation,
                    message: Predicate.isTagged(error, "AttachReconnectExhaustedError")
                      ? `Attach reconnect exhausted after ${error.attempts} attempts.`
                      : "TUI subscription failed at the Attach boundary.",
                  }),
            ),
          );
        yield* FiberSet.run(
          readers,
          readSubscription(next, command.generation, reportSubscriptionFailure),
          { startImmediately: true },
        );
        yield* FiberSet.run(
          readers,
          readChanges(next, command.generation, summary, reportSubscriptionFailure),
          { startImmediately: true },
        );
      });

    const executeFallible = (
      command: Exclude<TuiCommand, { readonly type: "detach" }>,
    ): Effect.Effect<void, AttachClientError> => {
      switch (command.type) {
        case "ensure-main":
          return client.ensureMain.pipe(
            Effect.tap((summary) =>
              Effect.sync(() => {
                summaries.set(summary.sessionId, summary);
              }),
            ),
            Effect.flatMap((session) => dispatch({ type: "main-ensured", session })),
          );
        case "list-sessions":
          return client.listSessions.pipe(
            Effect.tap((sessions) =>
              Effect.sync(() => {
                for (const summary of sessions) summaries.set(summary.sessionId, summary);
              }),
            ),
            Effect.flatMap((sessions) => dispatch({ type: "sessions-listed", sessions })),
          );
        case "resume-session":
          return replaceSubscription(command);
        case "start-turn":
        case "queue-follow-up":
          return client
            .startTurn(command.request.sessionId, command.request.message)
            .pipe(Effect.asVoid);
        case "steer-turn":
          return client
            .steerTurn(
              command.request.sessionId,
              command.request.expectedTurnId,
              command.request.message,
            )
            .pipe(Effect.asVoid);
        case "interrupt-turn":
          return client
            .interruptTurn(command.request.sessionId, command.request.expectedTurnId)
            .pipe(Effect.asVoid);
        case "resolve-approval":
          return client
            .resolveApproval(
              command.request.sessionId,
              command.request.approvalId,
              command.request.decision,
            )
            .pipe(Effect.asVoid);
      }
    };

    const reportFailure = (command: TuiCommand, error: AttachClientError): Effect.Effect<void> => {
      if (command.type === "detach") return Effect.void;
      if (Predicate.isTagged(error, "AttachOutcomeUnknownError")) {
        const composer =
          command.type === "start-turn" ||
          command.type === "queue-follow-up" ||
          command.type === "steer-turn"
            ? command.request.message
            : "";
        const commandGeneration = generationOf(command) ?? 0;
        return dispatch({
          type: "outcome-unknown",
          generation: commandGeneration,
          message: "Turn outcome unknown; composer text was preserved.",
          composer,
        });
      }
      return dispatch({
        type: "failure",
        ...(command.type === "ensure-main" || command.type === "list-sessions"
          ? {}
          : { generation: command.generation }),
        message: "TUI command failed at the Attach boundary.",
      });
    };

    const execute = (command: TuiCommand): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        if (command.type === "detach") return yield* close;
        if (yield* Ref.get(closed)) return;
        const commandGeneration = generationOf(command);
        if (commandGeneration !== undefined && commandGeneration !== currentGeneration()) return;
        yield* executeFallible(command);
      }).pipe(Effect.catch((error) => reportFailure(command, error)));

    return { execute, close };
  });
}

export function runTuiWithClient(
  client: AttachClient,
  hostFactory: TuiHostFactory = acquireTuiHost,
): Effect.Effect<void, AttachClientError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<void>();
      const commands = yield* Queue.dropping<TuiCommand>(COMMAND_QUEUE_CAPACITY);
      const overloads = yield* Queue.sliding<TuiAction>(1);
      const commandFibers = yield* FiberSet.make<void, never>();
      let detached = false;
      let latestGeneration = 0;
      const pendingAdmissions: TuiAction[] = [];
      let dispatchAdmission: ((action: TuiAction) => void) | undefined;

      const host = yield* hostFactory((command) => {
        if (detached) return;
        if (command.type === "detach") {
          detached = true;
          Deferred.doneUnsafe(stopped, Effect.void);
          return;
        }
        const commandGeneration = generationOf(command);
        if (Queue.offerUnsafe(commands, command)) {
          if (commandGeneration !== undefined) {
            latestGeneration = Math.max(latestGeneration, commandGeneration);
          }
          const admission: TuiAction = { type: "command-admitted", command };
          if (dispatchAdmission === undefined) pendingAdmissions.push(admission);
          else dispatchAdmission(admission);
          return;
        }
        Queue.offerUnsafe(overloads, {
          type: "failure",
          message: "TUI command queue is full; command was not sent. Composer text was preserved.",
        });
      });
      dispatchAdmission = host.dispatch;
      for (const admission of pendingAdmissions) host.dispatch(admission);
      const dispatch = (action: TuiAction): Effect.Effect<void> =>
        Effect.sync(() => host.dispatch(action));
      yield* Effect.acquireUseRelease(
        createTuiCommandInterpreter(client, dispatch, () => latestGeneration),
        (interpreter) =>
          Effect.gen(function* () {
            for (const command of initialCommands()) Queue.offerUnsafe(commands, command);
            yield* Effect.forkScoped(
              Effect.forever(Queue.take(overloads).pipe(Effect.flatMap(dispatch))),
            );
            yield* Effect.forkScoped(
              Effect.forever(
                Queue.take(commands).pipe(
                  Effect.flatMap((command) =>
                    FiberSet.run(commandFibers, interpreter.execute(command), {
                      startImmediately: true,
                    }).pipe(Effect.andThen(FiberSet.awaitEmpty(commandFibers))),
                  ),
                ),
              ),
            );
            yield* Deferred.await(stopped);
            yield* Queue.shutdown(commands);
            yield* FiberSet.clear(commandFibers);
          }),
        (interpreter) => interpreter.close,
      );
    }),
  );
}

function generationOf(command: TuiCommand): number | undefined {
  switch (command.type) {
    case "resume-session":
    case "start-turn":
    case "queue-follow-up":
    case "steer-turn":
    case "interrupt-turn":
    case "resolve-approval":
      return command.generation;
    case "ensure-main":
    case "list-sessions":
    case "detach":
      return undefined;
  }
}

function acquireTuiHost(
  emit: (command: TuiCommand) => void,
): Effect.Effect<ZiggyTuiHost, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => startZiggyTuiHost({ state: createInitialState(), emit })),
    (host) => Effect.sync(host.stop),
  );
}
