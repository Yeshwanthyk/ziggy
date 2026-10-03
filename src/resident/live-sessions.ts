import { randomUUID } from "node:crypto";
import { Deferred, Effect, FiberMap, Schema, type Scope } from "effect";
import type { UiConversationContext, UiSessionKey } from "../domain/ui-gateway";
import type { ZiggyAgentError } from "../domain/agent";
import type { ChatEvent, ChatHandle } from "../session";

export const MAX_UI_SESSIONS = 32;

export const LIVE_REPLAY_LIMIT = 256;

export type LiveSessionKind = "telegram" | "discord" | "slack" | "device" | "ui";

export interface LiveSessionEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly event: ChatEvent;
}

export interface LiveSessionMetadata {
  readonly context?: UiConversationContext;
  readonly agentId?: string;
}

export interface LiveSessionView extends LiveSessionMetadata {
  readonly key: UiSessionKey;
  readonly kind: LiveSessionKind;
  readonly handle: ChatHandle;
  /** No turn is running here and Pi is idle. */
  readonly idle: boolean;
}

export class LiveSessionRefused extends Schema.TaggedErrorClass<LiveSessionRefused>()(
  "LiveSessionRefused",
  {
    key: Schema.String,
    reason: Schema.Literals([
      "not-found",
      "watch-only",
      "capacity",
      "busy",
      "replay-gap",
      "open-failed",
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface LiveSessionsApi {
  /**
   * The one handle for `key`, opening it once however many callers ask. A failed open leaves
   * nothing behind; `ui` sessions count against {@link MAX_UI_SESSIONS}.
   */
  readonly acquire: (
    key: UiSessionKey,
    kind: LiveSessionKind,
    open: Effect.Effect<ChatHandle, unknown>,
    metadata?: LiveSessionMetadata,
  ) => Effect.Effect<ChatHandle, LiveSessionRefused>;
  /**
   * Forget `key` (only while it still holds `handle`, when given), stop its turn and dispose it.
   * A key that is still opening is left alone. The key is free again before disposal finishes.
   */
  readonly release: (
    key: UiSessionKey,
    handle?: ChatHandle,
  ) => Effect.Effect<void, ZiggyAgentError>;
  readonly get: (key: UiSessionKey) => Effect.Effect<LiveSessionView, LiveSessionRefused>;
  readonly list: Effect.Effect<ReadonlyArray<LiveSessionView>>;
  /** The live session whose current transcript is `sessionId`, if one is open. */
  readonly findBySessionId: (
    sessionId: string,
  ) => Effect.Effect<LiveSessionView | undefined, LiveSessionRefused>;
  /**
   * Replay retained events after `afterSeq`, then follow. Without a cursor the watcher starts from
   * the oldest retained event; a cursor outside the ring is a gap.
   */
  readonly watch: (
    key: UiSessionKey,
    listener: (event: LiveSessionEvent) => void,
    afterSeq?: number,
  ) => Effect.Effect<() => void, LiveSessionRefused>;
  readonly publish: (
    key: UiSessionKey,
    event: ChatEvent,
  ) => Effect.Effect<void, LiveSessionRefused>;
  /** Run one turn in the background, owned here so a disconnecting client does not cancel it. */
  readonly runExclusive: (
    key: UiSessionKey,
    turn: (handle: ChatHandle) => Effect.Effect<void>,
  ) => Effect.Effect<void, LiveSessionRefused>;
  readonly interrupt: (key: UiSessionKey) => Effect.Effect<void>;
}

interface Live {
  readonly _tag: "Live";
  readonly kind: LiveSessionKind;
  readonly handle: ChatHandle;
  readonly metadata: LiveSessionMetadata;
  readonly watchers: Set<(event: LiveSessionEvent) => void>;
  readonly replay: Array<LiveSessionEvent>;
  unsubscribe: () => void;
  nextSeq: number;
}

interface Opening {
  readonly _tag: "Opening";
  readonly kind: LiveSessionKind;
  readonly result: Deferred.Deferred<ChatHandle, LiveSessionRefused>;
}

const refused = (
  key: UiSessionKey,
  reason: LiveSessionRefused["reason"],
  message: string,
  cause?: unknown,
) =>
  cause === undefined
    ? new LiveSessionRefused({ key, reason, message })
    : new LiveSessionRefused({ key, reason, message, cause });

const emit = (live: Live, event: ChatEvent): void => {
  // A transcript reset invalidates everything before it, so replay starts over from here.
  if (event.kind === "session-state" && event.scope === "transcript") live.replay.length = 0;

  const sequenced = { seq: live.nextSeq++, eventId: randomUUID(), event };
  live.replay.push(sequenced);

  if (live.replay.length > LIVE_REPLAY_LIMIT) live.replay.shift();

  for (const watcher of Array.from(live.watchers)) watcher(sequenced);
};

const disposeQuietly = (key: UiSessionKey, handle: ChatHandle) =>
  handle.dispose.pipe(
    Effect.catch((cause) => Effect.logWarning("live session disposal failed", { key, cause })),
  );

/** The resident's open sessions for one Profile: one handle per key, shared by every client. */
export const makeLiveSessions = (): Effect.Effect<LiveSessionsApi, never, Scope.Scope> =>
  Effect.gen(function* () {
    const entries = new Map<UiSessionKey, Live | Opening>();
    const running = new Set<UiSessionKey>();

    // Registered before the FiberMap, so scope close interrupts opens and turns first.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const current = [...entries.entries()];
        entries.clear();

        return Effect.forEach(
          current,
          ([key, entry]) => {
            if (entry._tag === "Opening")
              return Deferred.fail(
                entry.result,
                refused(key, "open-failed", "the resident stopped while opening a session"),
              );

            entry.unsubscribe();

            return disposeQuietly(key, entry.handle);
          },
          { concurrency: "unbounded", discard: true },
        );
      }),
    );

    const work = yield* FiberMap.make<string, void, never>();

    const view = (key: UiSessionKey, live: Live): LiveSessionView => ({
      ...live.metadata,
      key,
      kind: live.kind,
      handle: live.handle,
      idle: !running.has(key) && live.handle.isIdle,
    });

    const requireLive = (key: UiSessionKey) =>
      Effect.suspend(() => {
        const entry = entries.get(key);

        return entry?._tag === "Live"
          ? Effect.succeed(entry)
          : Effect.fail(refused(key, "not-found", `live session ${key} was not found`));
      });

    /** Open in the background so every waiter, not just the first caller, sees the result. */
    const openInBackground = (
      key: UiSessionKey,
      opening: Opening,
      open: Effect.Effect<ChatHandle, unknown>,
      metadata: LiveSessionMetadata,
    ) =>
      open.pipe(
        Effect.mapError((cause) =>
          refused(key, "open-failed", `could not open ${opening.kind} session ${key}`, cause),
        ),
        Effect.flatMap((handle) =>
          Effect.suspend(() => {
            if (entries.get(key) !== opening) {
              return disposeQuietly(key, handle).pipe(
                Effect.andThen(
                  Effect.fail(refused(key, "open-failed", `opening ${key} was abandoned`)),
                ),
              );
            }

            const live: Live = {
              _tag: "Live",
              kind: opening.kind,
              handle,
              metadata,
              watchers: new Set(),
              replay: [],
              unsubscribe: () => undefined,
              nextSeq: 1,
            };

            live.unsubscribe = handle.subscribe((event) => emit(live, event));
            entries.set(key, live);

            return Deferred.succeed(opening.result, handle);
          }),
        ),
        Effect.catch((failure) =>
          Effect.suspend(() => {
            if (entries.get(key) === opening) entries.delete(key);

            return Deferred.fail(opening.result, failure);
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.suspend(() => {
            if (entries.get(key) === opening) entries.delete(key);

            return Deferred.fail(
              opening.result,
              refused(key, "open-failed", `opening ${key} was interrupted`),
            );
          }),
        ),
        Effect.asVoid,
      );

    return {
      acquire: (key, kind, open, metadata = {}) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const existing = entries.get(key);

            if (existing !== undefined && existing.kind !== kind)
              return yield* refused(key, "watch-only", `${key} is watch-only`);

            if (existing?._tag === "Live") return existing.handle;

            if (existing?._tag === "Opening")
              return yield* restore(Deferred.await(existing.result));

            if (
              kind === "ui" &&
              [...entries.values()].filter((entry) => entry.kind === "ui").length >= MAX_UI_SESSIONS
            ) {
              return yield* refused(
                key,
                "capacity",
                `UI session capacity of ${MAX_UI_SESSIONS} reached`,
              );
            }

            const opening: Opening = {
              _tag: "Opening",
              kind,
              result: yield* Deferred.make<ChatHandle, LiveSessionRefused>(),
            };

            entries.set(key, opening);
            yield* FiberMap.run(
              work,
              `open:${key}`,
              openInBackground(key, opening, open, metadata),
            );

            return yield* restore(Deferred.await(opening.result));
          }),
        ),
      release: (key, handle) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const entry = entries.get(key);

            if (entry?._tag !== "Live" || (handle !== undefined && entry.handle !== handle)) return;

            entries.delete(key);
            entry.unsubscribe();
            yield* FiberMap.remove(work, `turn:${key}`);
            yield* entry.handle.dispose;
          }),
        ),
      get: (key) => requireLive(key).pipe(Effect.map((live) => view(key, live))),
      list: Effect.sync(() =>
        [...entries.entries()]
          .flatMap(([key, entry]) => (entry._tag === "Live" ? [view(key, entry)] : []))
          .sort((left, right) => left.key.localeCompare(right.key)),
      ),
      findBySessionId: (sessionId) =>
        Effect.gen(function* () {
          // Snapshot: entries may change while each transcript is read.
          for (const [key, entry] of Array.from(entries)) {
            if (entry._tag !== "Live") continue;

            const current = yield* entry.handle.currentSession.pipe(
              Effect.mapError((cause) =>
                refused(key, "open-failed", `could not read the transcript of ${key}`, cause),
              ),
            );

            if (current?.id === sessionId) return view(key, entry);
          }

          return undefined;
        }),
      watch: (key, listener, afterSeq) =>
        requireLive(key).pipe(
          Effect.flatMap((live) => {
            const oldestSeq = live.replay[0]?.seq ?? live.nextSeq;
            const replayAfter = afterSeq ?? oldestSeq - 1;

            if (replayAfter > live.nextSeq - 1 || replayAfter < oldestSeq - 1)
              return Effect.fail(
                refused(key, "replay-gap", `replay for ${key} does not contain ${afterSeq}`),
              );

            // Replay and attach in the same step as the gap check, so no event falls between them.
            for (const event of live.replay) if (event.seq > replayAfter) listener(event);

            live.watchers.add(listener);

            return Effect.succeed(() => {
              live.watchers.delete(listener);
            });
          }),
        ),
      publish: (key, event) =>
        requireLive(key).pipe(Effect.flatMap((live) => Effect.sync(() => emit(live, event)))),
      runExclusive: (key, turn) =>
        Effect.uninterruptible(
          requireLive(key).pipe(
            Effect.flatMap((live) => {
              if (running.has(key))
                return Effect.fail(refused(key, "busy", `${key} already has an active turn`));

              running.add(key);

              return FiberMap.run(
                work,
                `turn:${key}`,
                turn(live.handle).pipe(Effect.ensuring(Effect.sync(() => running.delete(key)))),
              );
            }),
            Effect.asVoid,
          ),
        ),
      interrupt: (key) => FiberMap.remove(work, `turn:${key}`),
    } satisfies LiveSessionsApi;
  });
