import { join } from "node:path";
import { Effect, Option, Predicate, Schema, Semaphore } from "effect";
import {
  UiSessionHistoryParams,
  UiSessionOpenParams,
  UiSessionModelSetParams,
  UiSessionThinkingSetParams,
  UiSessionResumeParams,
  UiSessionRefParams,
  UiSessionTextParams,
  UiSessionKey,
  UiSessionSummary,
  UiGatewayError,
  UiEventFrame,
  UiProfileScopedParams,
  UI_METHODS,
  type UiRequestEnvelope,
  type UiGatewayResult,
  type UiCommandId,
  type UiSessionRef,
  type UiConversationContext,
} from "../../domain/ui-gateway";
import { ProfileId as ProfileIdSchema, type ProfileId } from "../../domain/profile-directory";
import type { UiGatewayBranch, UiGatewayDependencies } from "./types";
import type { ChatHandle, ChatPromptOptions } from "../agent";
import type { ChatRegistryEvent, ChatRegistryListEntry } from "../chat-registry";
import {
  badParams,
  boundedText,
  noService,
  protocolFailure,
  safeFailureMessage,
  toGatewayError,
} from "./errors";
import { eventFrame } from "./event-projection";
import {
  GROUP_DISCUSSION_MAX_AGENTS,
  GROUP_DISCUSSION_ANSWER_MAX_CODE_POINTS,
  GROUP_DISCUSSION_CONTEXT_MAX_CODE_POINTS,
  groupConversationId,
  makeEnsureGroup,
} from "./groups";

const decodeSessionKey = Schema.decodeUnknownEffect(UiSessionKey);

const decodeScoped = Schema.decodeUnknownEffect(UiProfileScopedParams, {
  onExcessProperty: "error",
});

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(UiEventFrame));

const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));

const decodeOpen = Schema.decodeUnknownEffect(UiSessionOpenParams, { onExcessProperty: "error" });

const decodeRef = Schema.decodeUnknownEffect(UiSessionRefParams, { onExcessProperty: "error" });

const decodeModelSet = Schema.decodeUnknownEffect(UiSessionModelSetParams, {
  onExcessProperty: "error",
});

const decodeThinkingSet = Schema.decodeUnknownEffect(UiSessionThinkingSetParams, {
  onExcessProperty: "error",
});

const decodeResume = Schema.decodeUnknownEffect(UiSessionResumeParams, {
  onExcessProperty: "error",
});

const decodeText = Schema.decodeUnknownEffect(UiSessionTextParams, { onExcessProperty: "error" });

const decodeHistory = Schema.decodeUnknownEffect(UiSessionHistoryParams, {
  onExcessProperty: "error",
});

const CrossProfileGroupMember = Schema.Union([
  Schema.String.check(Schema.isPattern(/^prf_[a-f0-9]{24}(?::|\/)/u)),
  Schema.Struct({ profileId: ProfileIdSchema, agentId: Schema.String }),
]);

const CrossProfileGroupProbe = Schema.Struct({
  context: Schema.Struct({
    kind: Schema.Literal("group"),
    memberAgentIds: Schema.Array(CrossProfileGroupMember).check(Schema.isMinLength(1)),
  }),
});

const decodeCrossProfileGroupProbe = Schema.decodeUnknownOption(CrossProfileGroupProbe);

const sessionRef = (
  profileId: ProfileId,
  key: UiSessionKey,
): Extract<UiSessionRef, { readonly kind: "live" }> => ({
  profileId,
  kind: "live",
  key,
});

const liveSessionProjection = (profileId: ProfileId, entry: ChatRegistryListEntry) => {
  const base = {
    ref: sessionRef(profileId, entry.key),
    kind: entry.kind,
    idle: entry.idle,
  };

  if (entry.context !== undefined && entry.agentId !== undefined)
    return { ...base, context: entry.context, agentId: entry.agentId };

  if (entry.context !== undefined) return { ...base, context: entry.context };

  if (entry.agentId !== undefined) return { ...base, agentId: entry.agentId };

  return base;
};

const validSessionKey = (key: string): Effect.Effect<UiSessionKey, UiGatewayError> =>
  decodeSessionKey(key).pipe(Effect.mapError((cause) => badParams("session", cause)));

const isSessionSummary = Schema.is(UiSessionSummary);

const resumableTranscript = (path: string): boolean => {
  const parts = path.split("/");

  return (
    parts.length === 3 &&
    parts[2]?.endsWith(".jsonl") === true &&
    ((parts[0] === "local" && parts[1] === "main") ||
      (parts[0] === "ui" &&
        parts[1] !== undefined &&
        !parts[1].startsWith("group-") &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(parts[1])))
  );
};

const resumableEntry = (entry: ChatRegistryListEntry): boolean =>
  entry.kind === "ui" &&
  entry.context?.kind === "local" &&
  entry.agentId === undefined &&
  (entry.key === "local/main" ||
    (entry.key.startsWith("ui/") &&
      !entry.key.startsWith("ui/group-") &&
      entry.key.split("/").length === 2));

export const makeSessionDispatcher = (
  config: UiGatewayDependencies,
  route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
  serverEpoch: string,
  ensureGroup: ReturnType<typeof makeEnsureGroup>,
) => {
  // A switch must publish its transcript reset before another switch can start. The Pi control
  // lock covers the switch itself, but not this gateway-owned replay publication.
  const sessionControls = new WeakMap<ChatHandle, ReturnType<typeof Semaphore.makeUnsafe>>();

  const withSessionControl = <A, E>(handle: ChatHandle, effect: Effect.Effect<A, E>) => {
    let permit = sessionControls.get(handle);

    if (permit === undefined) {
      permit = Semaphore.makeUnsafe(1);
      sessionControls.set(handle, permit);
    }

    return permit.withPermit(effect);
  };

  const subscribe = (
    send: (frame: string) => void,
    branch: UiGatewayBranch,
    ref: UiSessionRef,
    afterSeq: number | undefined,
    epoch: string | undefined,
    correlationId: UiCommandId | undefined,
    isOpen: () => boolean,
  ): Effect.Effect<() => void, UiGatewayError> => {
    if (!isOpen()) return Effect.succeed(() => {});

    if (ref.kind !== "live")
      return Effect.fail(protocolFailure("watch_only", "stored sessions cannot be watched"));

    if (epoch !== undefined && epoch !== serverEpoch)
      return Effect.fail(
        protocolFailure("replay_gap", "server epoch changed; reload session history"),
      );

    const onEvent = (event: ChatRegistryEvent) => {
      send(encodeEvent(eventFrame(branch.profileId, ref, event, serverEpoch, correlationId)));
    };

    return branch.registry.subscribeSequenced(ref.key, onEvent, afterSeq);
  };

  return (
    request: UiRequestEnvelope,
    send: (frame: string) => void,
    subscriptions: Map<string, () => void>,
    isOpen: () => boolean,
  ): Effect.Effect<UiGatewayResult, UiGatewayError> => {
    switch (isKnownMethod(request.method) ? request.method : undefined) {
      case "session.list":
        return Effect.gen(function* () {
          const params = yield* decodeScoped(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          const branch = yield* route(params.profileId);
          const live = yield* branch.registry.list;

          const stored = yield* config.sessions
            .list(branch.target)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

          return {
            profileId: branch.profileId,
            live: live.slice(0, 16).map((entry) => liveSessionProjection(branch.profileId, entry)),
            stored: stored.slice(0, 12).map((session) => ({
              ref: { profileId: branch.profileId, kind: "stored" as const, id: session.id },
              createdAt: session.createdAt,
              entryCount: session.entryCount,
              terminalState: session.terminalState,
            })),
          };
        });
      case "session.show":
        return Effect.gen(function* () {
          const params = yield* decodeRef(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          const branch = yield* route(params.ref.profileId);

          if (params.ref.kind === "live") {
            const entry = yield* branch.registry
              .get(params.ref.key)
              .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

            const current =
              entry.handle.currentSession === undefined
                ? undefined
                : yield* entry.handle.currentSession.pipe(
                    Effect.mapError((cause) => toGatewayError(request.method, cause)),
                  );

            const shown = {
              profileId: branch.profileId,
              ref: params.ref,
              kind: "live" as const,
              live: liveSessionProjection(branch.profileId, entry),
            };

            return current === undefined ? shown : { ...shown, storedSessionId: current.id };
          }

          const session = yield* config.sessions
            .show(branch.target, params.ref.id)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

          return {
            profileId: branch.profileId,
            ref: params.ref,
            kind: "stored" as const,
            createdAt: session.createdAt,
            entryCount: session.entryCount,
            terminalState: session.terminalState,
            storedSessionId: session.id,
          };
        });
      case "session.history":
        return Effect.gen(function* () {
          const params = yield* decodeHistory(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          const branch = yield* route(params.ref.profileId);

          if (config.sessions.history === undefined) return yield* noService(request.method);
          let reference: string;

          if (params.ref.kind === "stored") {
            reference = params.ref.id;
          } else {
            const entry = yield* branch.registry
              .get(params.ref.key)
              .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

            if (entry.handle.currentSession === undefined) {
              return yield* protocolFailure(
                "unknown_session",
                "live session history is unavailable",
              );
            }

            const current = yield* entry.handle.currentSession.pipe(
              Effect.mapError((cause) => toGatewayError(request.method, cause)),
            );

            if (current === undefined) {
              if (params.before !== undefined) {
                return yield* protocolFailure("stale_cursor", "session history cursor is stale");
              }

              return {
                profileId: branch.profileId,
                ref: params.ref,
                entries: [],
                terminalState: "incomplete" as const,
                truncated: false,
                hasMore: false,
              };
            }

            reference = current.id;
          }

          const page = yield* config.sessions
            .history(branch.target, reference, params.before)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

          return { profileId: branch.profileId, ref: params.ref, ...page };
        });
      case "session.open":
        return Effect.gen(function* () {
          if (Option.isSome(decodeCrossProfileGroupProbe(request.params))) {
            return yield* protocolFailure(
              "cross_profile_group",
              "group members must belong to the host Profile",
            );
          }

          const params = yield* decodeOpen(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          if (params.agentId !== undefined && params.context.kind !== "local") {
            return yield* protocolFailure(
              "bad_params",
              "specialist conversations require local context",
            );
          }

          const branch = yield* route(params.profileId);

          const group =
            params.context.kind === "group"
              ? yield* ensureGroup(branch, params.context, params.commandId)
              : undefined;

          const context: UiConversationContext = group?.context ?? params.context;

          const key = yield* validSessionKey(
            group !== undefined
              ? group.record.conversationId
              : params.name !== undefined
                ? `ui/${params.name}`
                : params.agentId !== undefined
                  ? `local/agents/${params.agentId}`
                  : "local/main",
          );

          const sessionDirectory =
            group === undefined
              ? params.name === undefined
                ? join(branch.target.path, "sessions", "local", "main")
                : join(branch.target.path, "sessions", "ui", params.name)
              : join(
                  branch.target.path,
                  "sessions",
                  "groups",
                  group.record.conversationId.slice("ui/group-".length),
                );

          const open =
            params.agentId === undefined
              ? config.agent.openChat(
                  branch.target,
                  context,
                  sessionDirectory,
                  "continue",
                  undefined,
                  params.name === undefined && context.kind === "local"
                    ? "Local · Main"
                    : undefined,
                )
              : config.agent.openSpecialistChat(branch.target, params.agentId);

          const metadata =
            params.agentId === undefined ? { context } : { context, agentId: params.agentId };

          yield* branch.registry
            .getOrOpenUi(key, open, metadata)
            .pipe(
              Effect.mapError((cause) =>
                Predicate.isTagged(cause.cause, "SessionHeld")
                  ? protocolFailure(
                      "session_busy",
                      "This session is held by another process; close it there or start a new session",
                      cause.cause,
                    )
                  : cause,
              ),
            );
          const ref = sessionRef(branch.profileId, key);
          const subscriptionKey = `${branch.profileId}:${key}`;

          const unsubscribe = yield* subscribe(
            send,
            branch,
            ref,
            undefined,
            undefined,
            params.commandId,
            isOpen,
          );

          if (isOpen()) {
            subscriptions.get(subscriptionKey)?.();
            subscriptions.set(subscriptionKey, unsubscribe);
          } else unsubscribe();

          return { ref };
        });
      case "session.summaries":
        return Effect.gen(function* () {
          const params = yield* decodeRef(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          const branch = yield* route(params.ref.profileId);

          const entry =
            params.ref.kind === "live" ? yield* branch.registry.get(params.ref.key) : undefined;

          const canResume = entry !== undefined && resumableEntry(entry);

          const current =
            canResume && entry.handle.currentSession !== undefined
              ? yield* entry.handle.currentSession.pipe(
                  Effect.mapError((cause) => toGatewayError(request.method, cause)),
                )
              : undefined;

          const summaries = yield* config.sessions
            .summaries(branch.target)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

          const valid = summaries
            .filter((session) => resumableTranscript(session.path))
            .map((session) => ({
              id: session.id,
              title: boundedText(session.title ?? "Untitled session", 160, "Untitled session"),
              updatedAt: session.updatedAt,
              held: session.held,
            }))
            .filter(isSessionSummary);

          return {
            profileId: branch.profileId,
            canResume,
            currentSessionId: current?.id ?? null,
            sessions: valid.slice(0, 32),
            truncated: valid.length > 32,
          };
        });
      case "session.resume":
        return Effect.gen(function* () {
          const params = yield* decodeResume(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          if (params.ref.kind !== "live")
            return yield* protocolFailure("watch_only", "stored sessions cannot resume here");

          const ref = params.ref;
          const branch = yield* route(ref.profileId);
          const entry = yield* branch.registry.get(ref.key);

          if (!resumableEntry(entry))
            return yield* protocolFailure(
              "watch_only",
              "Only plain local web sessions can resume here",
            );

          const target = yield* config.sessions
            .show(branch.target, params.sessionId)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

          if (!resumableTranscript(target.path))
            return yield* protocolFailure("watch_only", "Only web transcripts can be resumed here");

          const result = yield* withSessionControl(
            entry.handle,
            Effect.uninterruptible(
              entry.handle.resume(target.path).pipe(
                Effect.mapError((cause) => toGatewayError(request.method, cause)),
                Effect.tap((result) =>
                  result.cancelled ? Effect.void : branch.registry.resetTranscript(ref.key),
                ),
              ),
            ),
          );

          return {
            profileId: branch.profileId,
            ref: params.ref,
            sessionId: params.sessionId,
            cancelled: result.cancelled,
          };
        });

      case "session.model.status":
      case "session.model.set":
      case "session.thinking.set":
        return Effect.gen(function* () {
          const params =
            request.method === "session.model.status"
              ? {
                  ...(yield* decodeRef(request.params).pipe(
                    Effect.mapError((cause) => badParams(request.method, cause)),
                  )),
                  operation: "status" as const,
                }
              : request.method === "session.model.set"
                ? {
                    ...(yield* decodeModelSet(request.params).pipe(
                      Effect.mapError((cause) => badParams(request.method, cause)),
                    )),
                    operation: "model" as const,
                  }
                : {
                    ...(yield* decodeThinkingSet(request.params).pipe(
                      Effect.mapError((cause) => badParams(request.method, cause)),
                    )),
                    operation: "thinking" as const,
                  };

          if (params.ref.kind !== "live")
            return yield* protocolFailure("watch_only", "stored sessions cannot be switched");

          const ref = params.ref;
          const branch = yield* route(ref.profileId);
          const entry = yield* branch.registry.get(ref.key);

          if (entry.kind !== "ui")
            return yield* protocolFailure("watch_only", "channel sessions cannot be switched here");

          const change = (
            params.operation === "model"
              ? entry.handle.setModel(params.providerId, params.modelId)
              : params.operation === "thinking"
                ? entry.handle.setThinkingLevel(params.thinking)
                : entry.handle.modelState
          ).pipe(
            Effect.mapError((cause) => toGatewayError(request.method, cause)),
            Effect.tap(() =>
              params.operation === "status"
                ? Effect.void
                : branch.registry.publish(ref.key, {
                    kind: "session-state",
                    scope: "model",
                  }),
            ),
          );

          const state = yield* params.operation === "status"
            ? change
            : withSessionControl(entry.handle, change);

          return {
            profileId: branch.profileId,
            ref: params.ref,
            providerId: state.providerId ?? null,
            modelId: state.modelId ?? null,
            thinking: state.thinking,
          };
        });
      case "session.watch":
        return Effect.gen(function* () {
          const params = yield* decodeRef(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          if (params.ref.kind === "stored") {
            return yield* protocolFailure("watch_only", "stored sessions cannot be watched");
          }

          const branch = yield* route(params.ref.profileId);
          const subscriptionKey = `${params.ref.profileId}:${params.ref.key}`;

          const unsubscribe = yield* subscribe(
            send,
            branch,
            params.ref,
            params.afterSeq,
            params.epoch,
            params.commandId,
            isOpen,
          );

          if (isOpen()) {
            subscriptions.get(subscriptionKey)?.();
            subscriptions.set(subscriptionKey, unsubscribe);
          } else unsubscribe();

          return { acknowledged: true as const };
        });
      case "session.unwatch":
        return Effect.gen(function* () {
          const params = yield* decodeRef(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          if (params.ref.kind === "live") {
            subscriptions.get(`${params.ref.profileId}:${params.ref.key}`)?.();
            subscriptions.delete(`${params.ref.profileId}:${params.ref.key}`);
          }

          return { acknowledged: true as const };
        });
      case "session.close":
        return Effect.gen(function* () {
          const params = yield* decodeRef(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          if (params.ref.kind === "stored") {
            return yield* protocolFailure("bad_params", "stored sessions cannot be closed");
          }

          const branch = yield* route(params.ref.profileId);
          subscriptions.get(`${params.ref.profileId}:${params.ref.key}`)?.();
          subscriptions.delete(`${params.ref.profileId}:${params.ref.key}`);
          yield* branch.registry.closeUi(params.ref.key);

          return { acknowledged: true as const };
        });
      case "prompt.submit":
      case "session.steer":
      case "session.follow-up":
        return Effect.gen(function* () {
          const params = yield* decodeText(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          if (params.ref.kind === "stored") {
            return yield* protocolFailure("watch_only", "stored sessions are read-only");
          }

          const branch = yield* route(params.ref.profileId);

          if (request.method === "prompt.submit") {
            const live = yield* branch.registry
              .get(params.ref.key)
              .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

            const group = live.context?.kind === "group" ? live.context : undefined;

            if (params.recipient !== undefined && group === undefined) {
              return yield* protocolFailure(
                "bad_params",
                "an addressed turn requires a group conversation",
              );
            }

            const effectiveRecipient = params.recipient ?? group?.defaultRecipient;

            if (
              effectiveRecipient?.kind === "agent" &&
              !group?.memberAgentIds?.includes(effectiveRecipient.agentId)
            ) {
              return yield* protocolFailure(
                "ownership",
                "the addressed specialist is not a member of this group",
              );
            }

            if (
              group !== undefined &&
              group.memberAgentIds !== undefined &&
              effectiveRecipient?.kind !== "host"
            ) {
              const requestedMembers =
                effectiveRecipient?.kind === "agent"
                  ? [effectiveRecipient.agentId]
                  : group.memberAgentIds;

              const memberAgentIds = [...new Set(requestedMembers)].slice(
                0,
                GROUP_DISCUSSION_MAX_AGENTS,
              );

              const answers: Array<{ readonly agentId: string; readonly answer: string }> = [];
              const conversation = groupConversationId(group.groupId);

              for (const agentId of memberAgentIds) {
                const childDirectory = join(
                  branch.target.path,
                  "sessions",
                  "groups",
                  conversation.slice("ui/group-".length),
                  "agents",
                  agentId,
                );

                const child = yield* config.agent
                  .runSpecialist(branch.target, agentId, params.text, {
                    sessionDirectory: childDirectory,
                  })
                  .pipe(
                    Effect.map((result) => ({
                      agentId,
                      answer: boundedText(
                        result.answer,
                        GROUP_DISCUSSION_ANSWER_MAX_CODE_POINTS,
                        "",
                      ),
                    })),
                    Effect.catch((cause) =>
                      Effect.succeed({
                        agentId,
                        answer: safeFailureMessage(cause, "specialist unavailable"),
                      }),
                    ),
                  );

                answers.push(child);
                yield* branch.registry.publish(params.ref.key, {
                  kind: "voice",
                  agentId: child.agentId,
                  text: child.answer,
                });
              }

              const synthesisContext = boundedText(
                [
                  "Bounded Profile specialist discussion. Synthesize the member answers below; do not claim to have contacted external channels.",
                  ...answers.map(({ agentId, answer }) => `[${agentId}]\n${answer}`),
                ].join("\n\n"),
                GROUP_DISCUSSION_CONTEXT_MAX_CODE_POINTS,
                "",
              );

              const options: ChatPromptOptions =
                synthesisContext.length === 0 ? {} : { ephemeralContext: synthesisContext };

              yield* withSessionControl(
                live.handle,
                branch.registry.submit(params.ref.key, params.text, options),
              );
            } else {
              yield* withSessionControl(
                live.handle,
                branch.registry.submit(params.ref.key, params.text),
              );
            }
          } else if (request.method === "session.steer")
            yield* branch.registry.steer(params.ref.key, params.text);
          else yield* branch.registry.followUp(params.ref.key, params.text);

          return { acknowledged: true as const };
        });
      case "session.abort":
        return Effect.gen(function* () {
          const params = yield* decodeRef(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );

          if (params.ref.kind === "stored") {
            return yield* protocolFailure("watch_only", "stored sessions are read-only");
          }

          const branch = yield* route(params.ref.profileId);
          yield* branch.registry.abort(params.ref.key);

          return { acknowledged: true as const };
        });
      default:
        return Effect.fail(
          protocolFailure("unknown_method", `unknown session method ${request.method}`),
        );
    }
  };
};
