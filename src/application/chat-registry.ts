import { randomUUID } from "node:crypto";
import { Context, Deferred, Effect, FiberMap, Semaphore, type Scope } from "effect";
import {
  UiGatewayError,
  type UiConversationContext,
  type UiSessionKey,
} from "../domain/ui-gateway";
import type { ChatEvent, ChatHandle, ChatPromptOptions } from "./agent";
import {
  AutomationConversationDeliveryFailed,
  type AutomationConversationResult,
} from "../domain/automation";
import type { ProfileTarget } from "../domain/profile";
import type { ZiggyAgentError } from "../domain/agent";
import {
  appendStoredAutomationResult,
  automationResultContent,
} from "../adapters/pi/automation-result";

export const MAX_UI_SESSIONS = 32;

export type ChatRegistryKind = "telegram" | "discord" | "slack" | "ui";

export type ChatRegistryListener = (event: ChatEvent) => void;

export interface ChatRegistryEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly event: ChatEvent;
}

export interface ChatRegistryReplay {
  readonly events: ReadonlyArray<ChatRegistryEvent>;
  readonly oldestSeq: number;
  readonly latestSeq: number;
}

export const CHAT_REPLAY_LIMIT = 256;

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
  readonly sequencedListeners: Set<(event: ChatRegistryEvent) => void>;
  readonly replay: Array<ChatRegistryEvent>;
  readonly context: UiConversationContext | undefined;
  readonly agentId: string | undefined;
  nextSeq: number;
  phase: PromptPhase;
}

interface OpeningEntry {
  readonly _tag: "Opening";
  readonly key: UiSessionKey;
  readonly token: string;
  readonly result: Deferred.Deferred<ChatHandle, UiGatewayError>;
}

interface ClosingEntry {
  readonly _tag: "Closing";
  readonly key: UiSessionKey;
  readonly token: string;
}

type MutableLiveView = {
  key: UiSessionKey;
  kind: ChatRegistryKind;
  handle: ChatHandle;
  idle: boolean;
  context?: UiConversationContext;
  agentId?: string;
};

type MutableListView = {
  key: UiSessionKey;
  kind: ChatRegistryKind;
  idle: boolean;
  context?: UiConversationContext;
  agentId?: string;
};

type RegistryEntry = LiveEntry | OpeningEntry | ClosingEntry;

export interface ChatRegistryLiveEntry {
  readonly key: UiSessionKey;
  readonly kind: ChatRegistryKind;
  readonly handle: ChatHandle;
  readonly idle: boolean;
  readonly context?: UiConversationContext;
  readonly agentId?: string;
}

export interface ChatRegistryListEntry {
  readonly key: UiSessionKey;
  readonly kind: ChatRegistryKind;
  readonly idle: boolean;
  readonly context?: UiConversationContext;
  readonly agentId?: string;
}

export interface ChatRegistryApi {
  readonly registerAlias: (
    key: UiSessionKey,
    kind: Exclude<ChatRegistryKind, "ui">,
    handle: ChatHandle,
  ) => Effect.Effect<void, UiGatewayError>;
  readonly openAlias: (
    key: UiSessionKey,
    kind: Exclude<ChatRegistryKind, "ui">,
    open: Effect.Effect<ChatHandle, unknown>,
  ) => Effect.Effect<ChatHandle, UiGatewayError>;
  readonly unregisterAlias: (key: UiSessionKey, handle: ChatHandle) => Effect.Effect<void>;
  readonly closeAlias: (
    key: UiSessionKey,
    handle: ChatHandle,
  ) => Effect.Effect<void, ZiggyAgentError>;
  readonly get: (key: UiSessionKey) => Effect.Effect<ChatRegistryLiveEntry, UiGatewayError>;
  readonly list: Effect.Effect<ReadonlyArray<ChatRegistryListEntry>>;
  readonly getOrOpenUi: (
    key: UiSessionKey,
    open: Effect.Effect<ChatHandle, unknown>,
    metadata?: { readonly context?: UiConversationContext; readonly agentId?: string },
  ) => Effect.Effect<ChatHandle, UiGatewayError>;
  readonly subscribe: (
    key: UiSessionKey,
    listener: ChatRegistryListener,
  ) => Effect.Effect<() => void, UiGatewayError>;
  readonly subscribeSequenced: (
    key: UiSessionKey,
    listener: (event: ChatRegistryEvent) => void,
    afterSeq?: number,
  ) => Effect.Effect<() => void, UiGatewayError>;
  readonly replay: (
    key: UiSessionKey,
    afterSeq?: number,
  ) => Effect.Effect<ChatRegistryReplay, UiGatewayError>;
  readonly publish: (key: UiSessionKey, event: ChatEvent) => Effect.Effect<void, UiGatewayError>;
  readonly submit: (
    key: UiSessionKey,
    text: string,
    options?: ChatPromptOptions,
  ) => Effect.Effect<void, UiGatewayError>;
  readonly steer: (key: UiSessionKey, text: string) => Effect.Effect<void, UiGatewayError>;
  readonly abort: (key: UiSessionKey) => Effect.Effect<void, UiGatewayError>;
  readonly followUp: (key: UiSessionKey, text: string) => Effect.Effect<void, UiGatewayError>;
  readonly closeUi: (key: UiSessionKey) => Effect.Effect<void, UiGatewayError>;
  readonly deliverAutomationResult: (
    target: ProfileTarget,
    result: AutomationConversationResult,
  ) => Effect.Effect<void, AutomationConversationDeliveryFailed>;
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

  const sequenced = {
    seq: entry.nextSeq++,
    eventId: randomUUID(),
    event,
  } satisfies ChatRegistryEvent;

  entry.replay.push(sequenced);

  if (entry.replay.length > CHAT_REPLAY_LIMIT) entry.replay.shift();

  for (const listener of Array.from(entry.listeners)) listener(event);

  for (const listener of Array.from(entry.sequencedListeners)) listener(sequenced);
};

const makeLiveEntry = (
  key: UiSessionKey,
  kind: ChatRegistryKind,
  ownership: LiveEntry["ownership"],
  handle: ChatHandle,
  metadata: { readonly context?: UiConversationContext; readonly agentId?: string } = {},
): Effect.Effect<LiveEntry, UiGatewayError> =>
  Effect.try({
    try: () => {
      const listeners = new Set<ChatRegistryListener>();
      const sequencedListeners = new Set<(event: ChatRegistryEvent) => void>();
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
        sequencedListeners,
        replay: [],
        context: metadata.context,
        agentId: metadata.agentId,
        nextSeq: 1,
      };

      unsubscribe = handle.subscribe((event) => emit(entry, event));

      return entry;
    },
    catch: (cause) => internalFailure(`could not subscribe to live session ${key}`, cause),
  });

const liveView = (entry: LiveEntry): ChatRegistryLiveEntry => {
  const view: MutableLiveView = {
    key: entry.key,
    kind: entry.kind,
    handle: entry.handle,
    idle: entry.phase._tag === "Idle" && entry.handle.isIdle,
  };

  if (entry.context !== undefined) view.context = entry.context;

  if (entry.agentId !== undefined) view.agentId = entry.agentId;

  return view;
};

const listView = (entry: LiveEntry): ChatRegistryListEntry => {
  const view: MutableListView = {
    key: entry.key,
    kind: entry.kind,
    idle: entry.phase._tag === "Idle" && entry.handle.isIdle,
  };

  if (entry.context !== undefined) view.context = entry.context;

  if (entry.agentId !== undefined) view.agentId = entry.agentId;

  return view;
};

export const makeChatRegistry = (
  profilePath?: string,
): Effect.Effect<ChatRegistryApi, never, Scope.Scope> =>
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

                if (entry._tag === "Closing") return Effect.void;

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

                if (
                  current?._tag === "Opening" ||
                  current?._tag === "Closing" ||
                  (current?._tag === "Live" && current.kind === "ui")
                ) {
                  return yield* failure("internal", `cannot replace registry-owned session ${key}`);
                }

                entries.set(key, replacement);

                return current;
              }),
            )
            .pipe(Effect.tapError(() => Effect.sync(() => replacement.unsubscribeHandle())));

          if (previous?._tag === "Live") previous.unsubscribeHandle();
        }),
      openAlias: (key, kind, open) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const opening = yield* statePermit.withPermit(
              Effect.gen(function* () {
                if (entries.has(key)) {
                  return yield* failure("conflict", `live session ${key} already has an owner`);
                }

                const result = yield* Deferred.make<ChatHandle, UiGatewayError>();

                const marker: OpeningEntry = {
                  _tag: "Opening",
                  key,
                  token: randomUUID(),
                  result,
                };

                entries.set(key, marker);

                return marker;
              }),
            );

            const opened = yield* restore(open).pipe(
              Effect.mapError((cause) =>
                internalFailure(`could not open ${kind} session ${key}`, cause),
              ),
              Effect.onInterrupt(() =>
                statePermit.withPermit(
                  Effect.sync(() => {
                    if (entries.get(key) === opening) entries.delete(key);
                  }),
                ),
              ),
              Effect.result,
            );

            if (opened._tag === "Failure") {
              yield* statePermit.withPermit(
                Effect.sync(() => {
                  if (entries.get(key) === opening) entries.delete(key);
                }),
              );

              return yield* opened.failure;
            }

            const liveResult = yield* makeLiveEntry(key, kind, "channel", opened.success).pipe(
              Effect.result,
            );

            if (liveResult._tag === "Failure") {
              const disposed = yield* opened.success.dispose.pipe(Effect.result);

              if (disposed._tag === "Success") {
                yield* statePermit.withPermit(
                  Effect.sync(() => {
                    if (entries.get(key) === opening) entries.delete(key);
                  }),
                );
              } else {
                yield* Effect.logWarning("channel session cleanup failed after registration", {
                  key,
                  cause: disposed.failure,
                });
              }

              return yield* liveResult.failure;
            }

            const live = liveResult.success;

            yield* statePermit.withPermit(
              Effect.gen(function* () {
                if (entries.get(key) !== opening) {
                  live.unsubscribeHandle();
                  const disposed = yield* opened.success.dispose.pipe(Effect.result);

                  if (disposed._tag === "Failure") {
                    yield* Effect.logWarning("stale channel session cleanup failed", {
                      key,
                      cause: disposed.failure,
                    });
                  }

                  return yield* failure(
                    "internal",
                    `${kind} session opening for ${key} became stale`,
                  );
                }

                entries.set(key, live);
              }),
            );

            return opened.success;
          }),
        ),
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
      closeAlias: (key, handle) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const closing = yield* statePermit.withPermit(
              Effect.sync(() => {
                const current = entries.get(key);

                if (current?._tag !== "Live" || current.handle !== handle) return undefined;

                current.unsubscribeHandle();
                const marker: ClosingEntry = { _tag: "Closing", key, token: randomUUID() };
                entries.set(key, marker);

                return marker;
              }),
            );

            if (closing === undefined) return;

            yield* restore(handle.dispose);
            yield* statePermit.withPermit(
              Effect.sync(() => {
                if (entries.get(key) === closing) entries.delete(key);
              }),
            );
          }),
        ),
      get: (key) => requireLive(key).pipe(Effect.map(liveView)),
      list: statePermit.withPermit(
        Effect.sync(() =>
          [...entries.values()]
            .flatMap((entry) => (entry._tag === "Live" ? [listView(entry)] : []))
            .sort((left, right) => left.key.localeCompare(right.key)),
        ),
      ),
      getOrOpenUi: (key, open, metadata = {}) =>
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

                if (existing?._tag === "Closing") {
                  return yield* failure("session_busy", `${key} is closing`);
                }

                const uiCount = [...entries.values()].filter(
                  (entry) =>
                    entry._tag === "Opening" || (entry._tag === "Live" && entry.kind === "ui"),
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
                makeLiveEntry(key, "ui", "registry", handle, metadata).pipe(
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
      subscribeSequenced: (key, listener, afterSeq) =>
        statePermit.withPermit(
          Effect.gen(function* () {
            const candidate = entries.get(key);

            if (candidate === undefined || candidate._tag !== "Live")
              return yield* unknownSession(key);
            const entry = candidate;
            const oldestSeq = entry.replay[0]?.seq ?? entry.nextSeq;
            const latestSeq = entry.nextSeq - 1;
            // Fresh subscriptions bootstrap from retained activity; only a supplied cursor
            // promises continuity. Durable conversation history belongs to the session store.
            const replayAfter = afterSeq ?? oldestSeq - 1;

            if (replayAfter > latestSeq || replayAfter < oldestSeq - 1) {
              return yield* failure(
                "replay_gap",
                `replay window for ${key} does not contain sequence ${afterSeq}`,
              );
            }

            for (const event of entry.replay) {
              if (event.seq > replayAfter) listener(event);
            }

            entry.sequencedListeners.add(listener);

            return () => entry.sequencedListeners.delete(listener);
          }),
        ),
      replay: (key, afterSeq = 0) =>
        requireLive(key).pipe(
          Effect.flatMap((entry) => {
            const oldestSeq = entry.replay[0]?.seq ?? entry.nextSeq;
            const latestSeq = entry.nextSeq - 1;

            if (afterSeq > latestSeq || afterSeq < oldestSeq - 1) {
              return Effect.fail(
                failure(
                  "replay_gap",
                  `replay window for ${key} does not contain sequence ${afterSeq}`,
                ),
              );
            }

            return Effect.succeed({
              events: entry.replay.filter((event) => event.seq > afterSeq),
              oldestSeq,
              latestSeq,
            });
          }),
        ),
      publish: (key, event) =>
        requireLive(key).pipe(
          Effect.tap((entry) => Effect.sync(() => emit(entry, event))),
          Effect.asVoid,
        ),
      submit: (key, text, options) =>
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

            const promptWork = reserved.entry.handle.prompt(text, options).pipe(
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
      followUp: (key, text) =>
        requireUi(key).pipe(
          Effect.flatMap((entry) =>
            entry.handle
              .followUp(text)
              .pipe(
                Effect.mapError((cause) =>
                  cause._tag === "ChatNotStreaming"
                    ? failure("not_streaming", `${key} is not streaming`, cause)
                    : internalFailure(`could not send follow-up to UI session ${key}`, cause),
                ),
              ),
          ),
        ),
      closeUi: (key) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const entry = yield* requireUi(key);

            const closing = yield* statePermit.withPermit(
              Effect.gen(function* () {
                if (entries.get(key) !== entry) return yield* unknownSession(key);
                const marker: ClosingEntry = { _tag: "Closing", key, token: randomUUID() };
                entries.set(key, marker);
                entry.unsubscribeHandle();

                return marker;
              }),
            );

            yield* FiberMap.remove(work, `prompt:${key}`);
            yield* restore(entry.handle.dispose).pipe(
              Effect.mapError((cause) =>
                internalFailure(`could not close UI session ${key}`, cause),
              ),
            );
            yield* statePermit.withPermit(
              Effect.sync(() => {
                if (entries.get(key) === closing) entries.delete(key);
              }),
            );
          }),
        ),
      deliverAutomationResult: (target, result) =>
        statePermit.withPermit(
          Effect.gen(function* () {
            if (profilePath === undefined || target.path !== profilePath) {
              return yield* new AutomationConversationDeliveryFailed({
                category: "destination-invalid",
                retriable: false,
                message: "conversation registry does not belong to the requested Profile",
              });
            }

            if ([...entries.values()].some((entry) => entry._tag !== "Live")) {
              return yield* new AutomationConversationDeliveryFailed({
                category: "owner-unavailable",
                retriable: true,
                message: "a conversation owner is opening or closing; retry delivery",
              });
            }

            let matching: LiveEntry | undefined;

            for (const candidate of entries.values()) {
              if (candidate._tag !== "Live" || candidate.handle.currentSession === undefined) {
                continue;
              }

              const current = yield* candidate.handle.currentSession.pipe(
                Effect.mapError(
                  (cause) =>
                    new AutomationConversationDeliveryFailed({
                      category: "owner-unavailable",
                      retriable: true,
                      message: "could not resolve a live conversation owner",
                      cause,
                    }),
                ),
              );

              if (current?.id === result.targetSessionId) matching = candidate;
            }

            if (matching === undefined) {
              return yield* appendStoredAutomationResult(target.path, result);
            }

            if (matching.handle.appendAutomationResult === undefined) {
              return yield* new AutomationConversationDeliveryFailed({
                category: "owner-unavailable",
                retriable: true,
                message: "live conversation owner cannot accept automation results",
              });
            }

            if (matching.phase._tag !== "Idle") {
              return yield* new AutomationConversationDeliveryFailed({
                category: "session-busy",
                retriable: true,
                message: "conversation has an admitted active turn",
              });
            }

            const appended = yield* matching.handle.appendAutomationResult(result);

            if (!appended) return;
            emit(matching, {
              kind: "automation-result",
              automationId: result.automationId,
              runId: result.runId,
              text: [...automationResultContent(result)].slice(0, 1_024).join(""),
              timestamp: new Date().toISOString(),
            });
          }),
        ),
    };

    return api;
  });
