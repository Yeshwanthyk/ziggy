/* oxlint-disable ziggy-effect/no-native-promise-ownership -- ACP SDK handlers and notifications require Promise callbacks at this face boundary. */
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  ndJsonStream,
  type AgentApp,
  type ContentBlock,
} from "@agentclientprotocol/sdk";
import { Effect, Queue, Result, Schema, Semaphore, type Scope } from "effect";
import packageJson from "../../package.json" with { type: "json" };
import type { ChatHandle, ChatProgressEvent, ZiggyAgentApi } from "../application/agent";
import type { ProfileTarget } from "../domain/profile";

interface AcpTurn {
  cancelled: boolean;
}

interface AcpSession {
  readonly handle: ChatHandle;
  active: AcpTurn | undefined;
}

interface DispatchEnvelope {
  readonly run: Effect.Effect<void>;
  readonly reject: (cause: unknown) => void;
}

type AcpDispatch = <A>(effect: Effect.Effect<A, RequestError>) => Promise<A>;

export class AcpFaceError extends Schema.TaggedErrorClass<AcpFaceError>()("AcpFaceError", {
  operation: Schema.Literals(["connect", "serve"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const invalidParams = (message: string): RequestError =>
  RequestError.invalidParams(undefined, message);

const makeDispatch = (): Effect.Effect<AcpDispatch, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<DispatchEnvelope>();
    const pending = new Set<DispatchEnvelope>();
    let open = true;

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        open = false;
        const failure = RequestError.internalError(undefined, "ACP face is closing");
        for (const envelope of pending) envelope.reject(failure);
        pending.clear();
      }).pipe(Effect.andThen(Queue.shutdown(queue))),
    );

    yield* Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap((envelope) =>
          envelope.run.pipe(
            Effect.ensuring(Effect.sync(() => pending.delete(envelope))),
            Effect.forkScoped,
          ),
        ),
        Effect.asVoid,
      ),
    ).pipe(Effect.forkScoped);

    return <A>(effect: Effect.Effect<A, RequestError>): Promise<A> => {
      if (!open) return Promise.reject(RequestError.internalError(undefined, "ACP face is closed"));
      return new Promise<A>((resolve, reject) => {
        const envelope: DispatchEnvelope = {
          run: effect.pipe(
            Effect.match({
              onFailure: (cause) => reject(cause),
              onSuccess: (value) => resolve(value),
            }),
          ),
          reject,
        };
        pending.add(envelope);
        if (!Queue.offerUnsafe(queue, envelope)) {
          pending.delete(envelope);
          reject(RequestError.internalError(undefined, "ACP request queue is closed"));
        }
      });
    };
  });

const renderPrompt = (blocks: ReadonlyArray<ContentBlock>): Effect.Effect<string, RequestError> =>
  Effect.gen(function* () {
    const rendered: Array<string> = [];
    for (const block of blocks) {
      if (block.type === "text") {
        rendered.push(block.text);
        continue;
      }
      if (block.type === "resource_link") {
        rendered.push(
          [
            `Resource: ${block.name}`,
            `URI: ${block.uri}`,
            ...(block.description === undefined || block.description === null
              ? []
              : [`Description: ${block.description}`]),
          ].join("\n"),
        );
        continue;
      }
      return yield* Effect.fail(invalidParams(`unsupported ACP prompt content type ${block.type}`));
    }
    const text = rendered.join("\n\n");
    if (text.trim().length === 0) {
      return yield* Effect.fail(invalidParams("ACP prompt must not be empty"));
    }
    return text;
  });

export const makeAcpAgent = (
  target: ProfileTarget,
  shared: boolean,
  agentApi: ZiggyAgentApi,
): Effect.Effect<AgentApp, never, Scope.Scope> =>
  Effect.gen(function* () {
    const dispatch = yield* makeDispatch();
    const sessions = new Map<string, AcpSession>();
    const statePermit = Semaphore.makeUnsafe(1);

    yield* Effect.addFinalizer(() =>
      statePermit
        .withPermit(
          Effect.sync(() => {
            const current = [...sessions.values()];
            sessions.clear();
            return current;
          }),
        )
        .pipe(
          Effect.flatMap((current) =>
            Effect.forEach(
              current,
              (session) =>
                session.handle.dispose.pipe(
                  Effect.catch((cause) =>
                    Effect.sync(() => console.error("[acp] session disposal failed", cause)),
                  ),
                ),
              { concurrency: "unbounded", discard: true },
            ),
          ),
        ),
    );

    return agent({ name: "ziggy" })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        agentInfo: { name: "ziggy", title: "Ziggy", version: packageJson.version },
      }))
      .onRequest(methods.agent.session.new, ({ params }) =>
        dispatch(
          Effect.gen(function* () {
            if (!isAbsolute(params.cwd)) {
              return yield* Effect.fail(invalidParams("ACP cwd must be absolute"));
            }
            if (params.mcpServers.length !== 0) {
              return yield* Effect.fail(invalidParams("ACP MCP servers are not supported"));
            }
            if ((params.additionalDirectories?.length ?? 0) !== 0) {
              return yield* Effect.fail(
                invalidParams("ACP additional directories are not supported"),
              );
            }
            const sessionId = randomUUID();
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                agentApi
                  .openChat(
                    target,
                    shared ? { kind: "group", groupId: `acp-${sessionId}` } : { kind: "local" },
                    join(target.path, "sessions", "acp", sessionId),
                    "fresh",
                  )
                  .pipe(
                    Effect.mapError(() =>
                      RequestError.internalError(undefined, "could not open ACP session"),
                    ),
                  ),
              ).pipe(
                Effect.flatMap((handle) =>
                  statePermit.withPermit(
                    Effect.sync(() => sessions.set(sessionId, { handle, active: undefined })),
                  ),
                ),
              ),
            );
            return { sessionId };
          }),
        ),
      )
      .onRequest(methods.agent.session.prompt, ({ params, client, signal }) =>
        dispatch(
          Effect.gen(function* () {
            const text = yield* renderPrompt(params.prompt);
            const reserved = yield* statePermit.withPermit(
              Effect.gen(function* () {
                const session = sessions.get(params.sessionId);
                if (session === undefined) {
                  return yield* Effect.fail(invalidParams("unknown ACP session"));
                }
                if (session.active !== undefined) {
                  return yield* Effect.fail(
                    RequestError.invalidRequest(
                      undefined,
                      "ACP session already has an active prompt",
                    ),
                  );
                }
                const active: AcpTurn = { cancelled: false };
                session.active = active;
                return { session, active };
              }),
            );

            let notifications = Promise.resolve();
            const prompt = reserved.session.handle.prompt(text, {
              onProgress: (event: ChatProgressEvent) => {
                if (event.kind !== "assistant-text" || event.delta.length === 0) return;
                notifications = notifications.then(() =>
                  client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: event.delta },
                    },
                  }),
                );
              },
            });
            const cancelled = Effect.callback<never, RequestError>((resume) => {
              const onAbort = () =>
                resume(
                  Effect.fail(
                    RequestError.requestCancelled(undefined, "ACP prompt request was cancelled"),
                  ),
                );
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
              return Effect.sync(() => signal.removeEventListener("abort", onAbort));
            });
            const promptResult = yield* Effect.raceFirst(
              prompt.pipe(
                Effect.mapError(() => RequestError.internalError(undefined, "ACP prompt failed")),
              ),
              cancelled,
            ).pipe(Effect.result);
            const notificationResult = yield* Effect.tryPromise({
              try: () => notifications,
              catch: () => RequestError.internalError(undefined, "ACP update delivery failed"),
            }).pipe(Effect.result);
            yield* statePermit.withPermit(
              Effect.sync(() => {
                if (reserved.session.active === reserved.active)
                  reserved.session.active = undefined;
              }),
            );
            if (reserved.active.cancelled) return { stopReason: "cancelled" as const };
            if (Result.isFailure(promptResult)) return yield* Effect.fail(promptResult.failure);
            if (Result.isFailure(notificationResult)) {
              return yield* Effect.fail(notificationResult.failure);
            }
            return { stopReason: "end_turn" as const };
          }),
        ),
      )
      .onNotification(methods.agent.session.cancel, ({ params }) =>
        dispatch(
          statePermit
            .withPermit(
              Effect.sync(() => {
                const session = sessions.get(params.sessionId);
                if (session?.active === undefined) return undefined;
                session.active.cancelled = true;
                return session.handle;
              }),
            )
            .pipe(
              Effect.flatMap((handle) =>
                handle === undefined
                  ? Effect.void
                  : handle.abort.pipe(
                      Effect.catch(() =>
                        Effect.sync(() => console.error("[acp] session abort failed")),
                      ),
                    ),
              ),
            ),
        ),
      );
  });

export const runAcp = (
  target: ProfileTarget,
  shared: boolean,
  agentApi: ZiggyAgentApi,
): Effect.Effect<void, AcpFaceError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const protocolWrite = process.stdout.write.bind(process.stdout);
      const protocolOutput = new WritableStream<Uint8Array>({
        write: (chunk) => {
          if (protocolWrite(chunk)) return;
          return new Promise<void>((resolve) => process.stdout.once("drain", resolve));
        },
      });
      const stdoutWriteDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "write");
      const consoleLogDescriptor = Object.getOwnPropertyDescriptor(console, "log");
      const consoleInfoDescriptor = Object.getOwnPropertyDescriptor(console, "info");
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          Object.defineProperty(process.stdout, "write", {
            configurable: true,
            writable: true,
            value: process.stderr.write.bind(process.stderr),
          });
          Object.defineProperty(console, "log", {
            configurable: true,
            writable: true,
            value: console.error.bind(console),
          });
          Object.defineProperty(console, "info", {
            configurable: true,
            writable: true,
            value: console.error.bind(console),
          });
        }),
        () =>
          Effect.sync(() => {
            if (stdoutWriteDescriptor === undefined)
              Reflect.deleteProperty(process.stdout, "write");
            else Object.defineProperty(process.stdout, "write", stdoutWriteDescriptor);
            if (consoleLogDescriptor === undefined) Reflect.deleteProperty(console, "log");
            else Object.defineProperty(console, "log", consoleLogDescriptor);
            if (consoleInfoDescriptor === undefined) Reflect.deleteProperty(console, "info");
            else Object.defineProperty(console, "info", consoleInfoDescriptor);
          }),
      );
      const app = yield* makeAcpAgent(target, shared, agentApi);
      const stream = ndJsonStream(protocolOutput, Readable.toWeb(process.stdin));
      const connection = yield* Effect.acquireRelease(
        Effect.try({
          try: () => app.connect(stream),
          catch: (cause) =>
            new AcpFaceError({ operation: "connect", message: "could not start ACP", cause }),
        }),
        (active) => Effect.sync(() => active.close()),
      );
      yield* Effect.tryPromise({
        try: () => connection.closed,
        catch: (cause) =>
          new AcpFaceError({ operation: "serve", message: "ACP connection failed", cause }),
      });
    }),
  );
