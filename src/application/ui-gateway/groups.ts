import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import type { UiGroupStore, UiPinStore } from "../../adapters/fs/ui-state";
import {
  UiGatewayError,
  UiProfileScopedParams,
  UiDestinationListParams,
  UI_METHODS,
  type UiSessionKey,
  type UiCommandId,
  type UiConversationContext,
  type UiGatewayResult,
  type UiGroupRecord,
  type UiRequestEnvelope,
} from "../../domain/ui-gateway";
import type { ProfileId } from "../../domain/profile-directory";
import { badParams, boundedText, protocolFailure, toGatewayError } from "./errors";
import type { UiGatewayBranch, UiGatewayDependencies } from "./types";

const decodeScoped = Schema.decodeUnknownEffect(UiProfileScopedParams, {
  onExcessProperty: "error",
});

const decodeDestinationList = Schema.decodeUnknownEffect(UiDestinationListParams, {
  onExcessProperty: "error",
});

const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));

export const groupConversationId = (groupId: string): UiSessionKey =>
  `ui/group-${createHash("sha256").update(groupId).digest("hex").slice(0, 32)}`;

export const GROUP_DISCUSSION_MAX_AGENTS = 4;

export const GROUP_DISCUSSION_ANSWER_MAX_CODE_POINTS = 2_000;

export const GROUP_DISCUSSION_CONTEXT_MAX_CODE_POINTS = 8_000;

const normalizedGroupContext = (
  context: Extract<UiConversationContext, { kind: "group" }>,
): Extract<UiConversationContext, { kind: "group" }> => {
  const normalized = {
    kind: "group" as const,
    groupId: context.groupId,
    defaultRecipient: context.defaultRecipient ?? { kind: "host" as const },
  };

  if (context.memberAgentIds === undefined) return normalized;

  return { ...normalized, memberAgentIds: [...new Set(context.memberAgentIds)] };
};

const sameGroupConfiguration = (left: UiGroupRecord, right: UiGroupRecord): boolean =>
  left.groupId === right.groupId &&
  left.conversationId === right.conversationId &&
  left.hostProfileId === right.hostProfileId &&
  left.defaultRecipient.kind === right.defaultRecipient.kind &&
  (left.defaultRecipient.kind !== "agent" || right.defaultRecipient.kind !== "agent"
    ? left.defaultRecipient.kind === right.defaultRecipient.kind
    : left.defaultRecipient.agentId === right.defaultRecipient.agentId) &&
  left.memberAgentIds.length === right.memberAgentIds.length &&
  left.memberAgentIds.every((member, index) => member === right.memberAgentIds[index]);

export const makeEnsureGroup =
  (groups: UiGroupStore) =>
  (
    branch: UiGatewayBranch,
    context: Extract<UiConversationContext, { kind: "group" }>,
    commandId: UiCommandId | undefined,
  ): Effect.Effect<
    {
      readonly context: Extract<UiConversationContext, { kind: "group" }>;
      readonly record: UiGroupRecord;
    },
    UiGatewayError
  > =>
    Effect.gen(function* () {
      if (
        context.memberAgentIds !== undefined &&
        new Set(context.memberAgentIds).size !== context.memberAgentIds.length
      ) {
        return yield* protocolFailure("bad_params", "group memberAgentIds must be unique");
      }

      const normalized = normalizedGroupContext(context);

      if (
        normalized.defaultRecipient !== undefined &&
        normalized.defaultRecipient.kind === "agent" &&
        !normalized.memberAgentIds?.includes(normalized.defaultRecipient.agentId)
      ) {
        return yield* protocolFailure(
          "bad_params",
          "group defaultRecipient must name a member agent",
        );
      }

      const state = yield* groups
        .read(branch.target.path)
        .pipe(Effect.mapError((cause) => toGatewayError("session.open", cause)));

      const existing = state.groups.find((candidate) => candidate.groupId === normalized.groupId);

      if (existing !== undefined && existing.hostProfileId !== branch.profileId) {
        return yield* protocolFailure("cross_profile_group", "group is owned by another Profile");
      }

      const conversationId = existing?.conversationId ?? groupConversationId(normalized.groupId);

      const requested: UiGroupRecord = {
        groupId: normalized.groupId,
        conversationId,
        hostProfileId: branch.profileId,
        memberAgentIds: normalized.memberAgentIds ?? [],
        defaultRecipient: normalized.defaultRecipient ?? { kind: "host" },
        revision: existing?.revision ?? 0,
      };

      if (existing !== undefined && sameGroupConfiguration(existing, requested)) {
        return {
          context: {
            ...normalized,
            memberAgentIds: existing.memberAgentIds,
            defaultRecipient: existing.defaultRecipient,
          },
          record: existing,
        };
      }

      if (existing !== undefined && context.expectedRevision === undefined) {
        return yield* protocolFailure(
          "conflict",
          "group exists; expectedRevision is required to change it",
        );
      }

      const expectedRevision = context.expectedRevision ?? existing?.revision ?? 0;
      const effectiveCommandId = commandId ?? `group:${normalized.groupId}:${expectedRevision}`;

      const saved = yield* groups
        .upsert(branch.target.path, requested, expectedRevision, effectiveCommandId)
        .pipe(Effect.mapError((cause) => toGatewayError("session.open", cause)));

      const record = saved.groups.find((candidate) => candidate.groupId === normalized.groupId);

      if (record === undefined)
        return yield* protocolFailure("internal", "group record was not persisted");

      return {
        context: {
          ...normalized,
          memberAgentIds: record.memberAgentIds,
          defaultRecipient: record.defaultRecipient,
        },
        record,
      };
    });

export const dispatchGroups = (
  request: UiRequestEnvelope,
  route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
  config: UiGatewayDependencies,
  groups: UiGroupStore,
  pins: UiPinStore,
): Effect.Effect<UiGatewayResult, UiGatewayError> => {
  switch (isKnownMethod(request.method) ? request.method : undefined) {
    case "group.list":
      return Effect.gen(function* () {
        const params = yield* decodeScoped(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        const state = yield* groups
          .read(branch.target.path)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        return {
          profileId: branch.profileId,
          groups: state.groups
            .filter((group) => group.hostProfileId === branch.profileId)
            .sort((left, right) => left.groupId.localeCompare(right.groupId))
            .slice(0, 16),
        };
      });
    case "destination.list":
      return Effect.gen(function* () {
        const params = yield* decodeDestinationList(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        const [stored, external, pinState] = yield* Effect.all([
          config.sessions
            .list(branch.target)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause))),
          branch.destinations.list,
          pins
            .read(branch.target.path)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause))),
        ]);

        const destinations = new Map<
          string,
          {
            readonly target: string;
            readonly kind: "conversation" | "telegram" | "discord" | "slack";
            readonly label?: string;
            readonly category: "agent" | "session" | "telegram" | "discord" | "slack";
            readonly pinned: boolean;
            readonly activityAt?: string;
            readonly agentId?: string;
          }
        >();

        for (const session of stored) {
          const target = `conversation:${session.id}`;

          const agentConversation = /(?:^|\/)agents\/[^/]+(?:\/|$)/u.test(session.path);

          const agentId = session.path.match(
            /^local\/agents\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/u,
          )?.[1];

          const destination = {
            target,
            kind: "conversation",
            label: boundedText(session.name ?? session.id, 160, "Conversation"),
            category: agentConversation ? "agent" : "session",
            pinned: false,
            activityAt: session.activityAt ?? session.createdAt,
          } as const;

          destinations.set(
            target,
            agentId === undefined ? destination : { ...destination, agentId },
          );
        }

        for (const destination of external) {
          const target = destination.target.target;
          const kind = destination.target._tag;
          const category = kind === "conversation" ? "session" : kind;
          destinations.set(
            target,
            destination.label === undefined
              ? { target, kind, category, pinned: false }
              : {
                  target,
                  kind,
                  label: boundedText(destination.label, 160, kind),
                  category,
                  pinned: false,
                },
          );
        }

        for (const pin of pinState.pins) {
          if (pin.ref.profileId !== branch.profileId) continue;

          let sessionId: string | undefined;

          if (pin.ref.kind === "stored") {
            sessionId = pin.ref.id;
          } else {
            const liveKey = pin.ref.key;

            const entry = yield* branch.registry
              .get(liveKey)
              .pipe(
                Effect.catch((cause) =>
                  cause.code === "unknown_session" ? Effect.succeed(undefined) : Effect.fail(cause),
                ),
              );

            if (entry !== undefined) {
              const session = yield* entry.handle.currentSession.pipe(
                Effect.mapError((cause) => toGatewayError(request.method, cause)),
              );

              sessionId = session?.id;
            } else if (liveKey.startsWith("ui/chat-")) {
              const matches = stored.filter((session) => dirname(session.path) === liveKey);

              if (matches.length === 1) sessionId = matches[0]?.id;
            }
          }

          if (sessionId === undefined) continue;

          const destination = destinations.get(`conversation:${sessionId}`);

          if (destination !== undefined) {
            const pinnedDestination = { ...destination, pinned: true } as const;

            destinations.set(
              destination.target,
              pin.label === undefined
                ? pinnedDestination
                : {
                    ...pinnedDestination,
                    label: boundedText(pin.label, 160, "Conversation"),
                  },
            );
          }
        }

        const ordered = [...destinations.values()]
          .filter((entry) => params.after === undefined || entry.target > params.after)
          .sort((left, right) =>
            left.target < right.target ? -1 : left.target > right.target ? 1 : 0,
          );

        const entries = ordered.slice(0, 32);
        const lastEntry = entries.at(-1);

        const result = {
          profileId: branch.profileId,
          entries,
        };

        return ordered.length > entries.length && lastEntry !== undefined
          ? { ...result, nextCursor: lastEntry.target }
          : result;
      });
    default:
      return Effect.fail(
        protocolFailure("unknown_method", `unknown group method ${request.method}`),
      );
  }
};
