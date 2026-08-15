import { randomUUID } from "node:crypto";
import { Context, Deferred, Effect, FiberMap, Semaphore, type Scope } from "effect";
import type { ZiggyAgentError } from "../domain/agent";
import { UiGatewayError, type UiLiveSession, type UiSessionKey } from "../domain/ui-gateway";
import type { ChatEvent, ChatHandle } from "./agent";

export const MAX_UI_SESSIONS = 32;

export type ChatRegistryKind = "telegram" | "discord" | "slack" | "ui";
export type ChatRegistryListener = (event: ChatEvent) => void;

type PromptPhase =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Prompting"; readonly token: string; errorSeen: boolean };

interface LiveEntry {
  readonly _tag: "Live";
  readonly key: UiSessionKey;
  readonly kind: ChatRegistryKind;
  readonly ownership: "channel" | "registry";
  readonly handle: ChatHandle;
  readonly listeners: Set<ChatRegistryListener>;
  readonly unsubscribeHandle: () => void;
  phase: PromptPhase;
}

interface OpeningEntry {
  readonly _tag: "Opening";
  readonly key: UiSessionKey;
  readonly token: string;
  readonly result: Deferred.Deferred<ChatHandle, UiGatewayError>;
}

type RegistryEntry = LiveEntry | OpeningEntry;

export interface ChatRegistryLiveEntry {
  readonly key: UiSessionKey;
  readonly kind: ChatRegistryKind;
  readonly handle: ChatHandle;
  readonly idle: boolean;
}

export interface ChatRegistryApi {
  readonly registerAlias: (
    key: UiSessionKey,
    kind: Exclude<ChatRegistryKind, "ui">,
    handle: ChatHandle,
  ) => Effect.Effect<void, UiGatewayError>;
  readonly unregisterAlias: (key: UiSessionKey, handle: ChatHandle) => Effect.Effect<void>;
  readonly get: (key: UiSessionKey) => Effect.Effect<ChatRegistryLiveEntry, UiGatewayError>;
  readonly list: Effect.Effect<ReadonlyArray<UiLiveSession>>;
  readonly getOrOpenUi: (
    key: UiSessionKey,
    open: Effect.Effect<ChatHandle, ZiggyAgentError>,
  ) => Effect.Effect<ChatHandle, UiGatewayError>;
  readonly subscribe: (
    key: UiSessionKey,
    listener: ChatRegistryListener,
  ) => Effect.Effect<() => void, UiGatewayError>;
  readonly submit: (key: UiSessionKey, text: string) => Effect.Effect<void, UiGatewayError>;
  readonly steer: (key: UiSessionKey, text: string) => Effect.Effect<void, UiGatewayError>;
  readonly abort: (key: UiSessionKey) => Effect.Effect<void, UiGatewayError>;
}

export class ChatRegistry extends Context.Service<ChatRegistry, ChatRegistryApi>()(
  "ziggy/ChatRegistry",
) {}

const failure = (code: UiGatewayError["code"], message: string, cause?: unknown): UiGatewayError =>
  cause === undefined
    ? new UiGatewayError({ code, message })
    : new UiGatewayError({ code, message, cause });

const internalFailure = (message: string, cause: unknown): UiGatewayError =>
  failure("internal", message, cause);

const unknownSession = (key: string): UiGatewayError =>
  failure("unknown_session", `live session ${key} was not found`);

const emit = (entry: LiveEntry, event: ChatEvent): void => {
  if (entry.phase._tag === "Prompting" && event.kind === "error") {
    entry.phase.errorSeen = true;
  }
  for (const listener of Array.from(entry.listeners)) listener(event);
};

const makeLiveEntry = (
  key: UiSessionKey,
  kind: ChatRegistryKind,
  ownership: LiveEntry["ownership"],
  handle: ChatHandle,
): Effect.Effect<LiveEntry, UiGatewayError> =>
  Effect.try({
    try: () => {
      const listeners = new Set<ChatRegistryListener>();
      let unsubscribe: () => void = () => undefined;
      const entry: LiveEntry = {
        _tag: "Live" as const,
        key,
        kind,
        ownership,
        handle,
        listeners,
        phase: { _tag: "Idle" as const },
        unsubscribeHandle: () => unsubscribe(),
      };
      unsubscribe = handle.subscribe((event) => emit(entry, event));
      return entry;
    },
    catch: (cause) => internalFailure(`could not subscribe to live session ${key}`, cause),
  });

const liveView = (entry: LiveEntry): ChatRegistryLiveEntry => ({
  key: entry.key,
  kind: entry.kind,
  handle: entry.handle,
  idle: entry.phase._tag === "Idle" && entry.handle.isIdle,
});

export const makeChatRegistry = (): Effect.Effect<ChatRegistryApi, never, Scope.Scope> =>
  Effect.gen(function* () {
    const entries = new Map<UiSessionKey, RegistryEntry>();
    const statePermit = Semaphore.makeUnsafe(1);

    // This finalizer is registered before the FiberMap. LIFO scope cleanup therefore interrupts
    // opening/prompt fibers before it detaches and disposes registry-owned UI handles.
    yield* Effect.addFinalizer(() =>
      statePermit
        .withPermit(
          Effect.sync(() => {
            const current = [...entries.values()];
            entries.clear();
            return current;
          }),
        )
        .pipe(
          Effect.flatMap((current) =>
            Effect.forEach(
              current,
              (entry) => {
                if (entry._tag === "Opening") {
                  return Deferred.fail(
                    entry.result,
                    failure("internal", "UI gateway stopped while opening a session"),
                  ).pipe(Effect.asVoid);
                }
                entry.unsubscribeHandle();
                return entry.ownership === "registry"
                  ? entry.handle.dispose.pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("UI session disposal failed", { key: entry.key, cause }),
                      ),
                    )
                  : Effect.void;
              },
              { concurrency: "unbounded", discard: true },
            ),
          ),
        ),
    );
    const work = yield* FiberMap.make<string, void, never>();

    const requireLive = (key: UiSessionKey): Effect.Effect<LiveEntry, UiGatewayError> =>
      statePermit.withPermit(
        Effect.gen(function* () {
          const entry = entries.get(key);
          if (entry === undefined || entry._tag !== "Live") return yield* unknownSession(key);
          return entry;
        }),
      );

    const requireUi = (key: UiSessionKey): Effect.Effect<LiveEntry, UiGatewayError> =>
      requireLive(key).pipe(
        Effect.flatMap((entry) =>
          entry.kind === "ui"
            ? Effect.succeed(entry)
            : Effect.fail(failure("watch_only", `${key} is watch-only`)),
        ),
      );

    const api: ChatRegistryApi = {
      registerAlias: (key, kind, handle) =>
        Effect.gen(function* () {
          const replacement = yield* makeLiveEntry(key, kind, "channel", handle);
          const previous = yield* statePermit
            .withPermit(
              Effect.gen(function* () {
                const current = entries.get(key);
                if (current?._tag === "Opening" || current?.kind === "ui") {
                  return yield* failure("internal", `cannot replace registry-owned session ${key}`);
                }
                entries.set(key, replacement);
                return current;
              }),
            )
            .pipe(Effect.tapError(() => Effect.sync(() => replacement.unsubscribeHandle())));
          if (previous?._tag === "Live") previous.unsubscribeHandle();
        }),
      unregisterAlias: (key, handle) =>
        statePermit.withPermit(
          Effect.sync(() => {
            const current = entries.get(key);
            if (current?._tag === "Live" && current.handle === handle) {
              entries.delete(key);
              current.unsubscribeHandle();
            }
          }),
        ),
      get: (key) => requireLive(key).pipe(Effect.map(liveView)),
      list: statePermit.withPermit(
        Effect.sync(() =>
          [...entries.values()]
            .flatMap((entry) =>
              entry._tag === "Live"
                ? [{ key: entry.key, kind: entry.kind, idle: liveView(entry).idle }]
                : [],
            )
            .sort((left, right) => left.key.localeCompare(right.key)),
        ),
      ),
      getOrOpenUi: (key, open) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const decision = yield* statePermit.withPermit(
              Effect.gen(function* () {
                const existing = entries.get(key);
                if (existing?._tag === "Live") {
                  if (existing.kind !== "ui")
                    return yield* failure("watch_only", `${key} is watch-only`);
                  return { _tag: "Live" as const, handle: existing.handle };
                }
                if (existing?._tag === "Opening") {
                  return { _tag: "Wait" as const, result: existing.result };
                }
                const uiCount = [...entries.values()].filter(
                  (entry) => entry._tag === "Opening" || entry.kind === "ui",
                ).length;
                if (uiCount >= MAX_UI_SESSIONS) {
                  return yield* failure(
                    "capacity_exceeded",
                    `UI session capacity of ${MAX_UI_SESSIONS} reached`,
                  );
                }
                const result = yield* Deferred.make<ChatHandle, UiGatewayError>();
                const opening: OpeningEntry = {
                  _tag: "Opening",
                  key,
                  token: randomUUID(),
                  result,
                };
                entries.set(key, opening);
                return { _tag: "Open" as const, opening };
              }),
            );
            if (decision._tag === "Live") return decision.handle;
            if (decision._tag === "Wait") return yield* restore(Deferred.await(decision.result));

            const opening = decision.opening;
            const openWork = open.pipe(
              Effect.mapError((cause) =>
                internalFailure(`could not open UI session ${key}`, cause),
              ),
              Effect.flatMap((handle) =>
                makeLiveEntry(key, "ui", "registry", handle).pipe(
                  Effect.flatMap((live) =>
                    statePermit.withPermit(
                      Effect.gen(function* () {
                        const current = entries.get(key);
                        if (current?._tag !== "Opening" || current.token !== opening.token) {
                          live.unsubscribeHandle();
                          yield* handle.dispose.pipe(Effect.catch(() => Effect.void));
                          return yield* failure(
                            "internal",
                            `UI session opening for ${key} became stale`,
                          );
                        }
                        entries.set(key, live);
                        yield* Deferred.succeed(opening.result, handle);
                      }),
                    ),
                  ),
                ),
              ),
              Effect.catch((openFailure) =>
                statePermit.withPermit(
                  Effect.gen(function* () {
                    const current = entries.get(key);
                    if (current?._tag === "Opening" && current.token === opening.token) {
                      entries.delete(key);
                    }
                    yield* Deferred.fail(opening.result, openFailure);
                  }),
                ),
              ),
            );
            yield* FiberMap.run(work, `open:${key}`, openWork, { onlyIfMissing: true });
            return yield* restore(Deferred.await(opening.result));
          }),
        ),
      subscribe: (key, listener) =>
        requireLive(key).pipe(
          Effect.map((entry) => {
            entry.listeners.add(listener);
            return () => entry.listeners.delete(listener);
          }),
        ),
      submit: (key, text) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const reserved = yield* statePermit.withPermit(
              Effect.gen(function* () {
                const entry = entries.get(key);
                if (entry === undefined || entry._tag !== "Live") return yield* unknownSession(key);
                if (entry.kind !== "ui")
                  return yield* failure("watch_only", `${key} is watch-only`);
                if (entry.phase._tag === "Prompting") {
                  return yield* failure("session_busy", `${key} already has an active prompt`);
                }
                const phase: PromptPhase = {
                  _tag: "Prompting",
                  token: randomUUID(),
                  errorSeen: false,
                };
                entry.phase = phase;
                return { entry, phase };
              }),
            );
            const promptWork = reserved.entry.handle.prompt(text).pipe(
              Effect.asVoid,
              Effect.catch((cause) =>
                Effect.sync(() => {
                  if (!reserved.phase.errorSeen) {
                    emit(reserved.entry, { kind: "error", message: "UI session prompt failed" });
                  }
                }).pipe(
                  Effect.andThen(Effect.logWarning("UI session prompt failed", { key, cause })),
                ),
              ),
              Effect.ensuring(
                statePermit.withPermit(
                  Effect.sync(() => {
                    if (
                      reserved.entry.phase._tag === "Prompting" &&
                      reserved.entry.phase.token === reserved.phase.token
                    ) {
                      reserved.entry.phase = { _tag: "Idle" };
                    }
                  }),
                ),
              ),
            );
            yield* FiberMap.run(work, `prompt:${key}`, promptWork, { onlyIfMissing: true });
          }),
        ),
      steer: (key, text) =>
        requireUi(key).pipe(
          Effect.flatMap((entry) =>
            entry.phase._tag === "Idle"
              ? Effect.fail(failure("not_streaming", `${key} is not streaming`))
              : entry.handle
                  .steer(text)
                  .pipe(
                    Effect.mapError((cause) =>
                      cause._tag === "ChatNotStreaming"
                        ? failure("not_streaming", `${key} is not streaming`, cause)
                        : internalFailure(`could not steer UI session ${key}`, cause),
                    ),
                  ),
          ),
        ),
      abort: (key) =>
        requireUi(key).pipe(
          Effect.flatMap((entry) =>
            entry.phase._tag === "Idle"
              ? Effect.void
              : entry.handle.abort.pipe(
                  Effect.mapError((cause) =>
                    internalFailure(`could not abort UI session ${key}`, cause),
                  ),
                  Effect.andThen(FiberMap.remove(work, `prompt:${key}`)),
                ),
          ),
        ),
    };
    return api;
  });
