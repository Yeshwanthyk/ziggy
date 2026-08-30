import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Context, Deferred, Effect, Option, Schema } from "effect";
import { makeUiGroupStore, makeUiPinStore } from "../adapters/fs/ui-state";
import {
  UiAgentCreateParams,
  UiAgentListParams,
  UiAgentRunParams,
  UiAgentShowParams,
  UiAgentValidateParams,
  UiEmptyParams,
  UiEventFrame,
  UiGatewayError,
  UiProfileScopedParams,
  UiResponseFrame,
  UiSessionHistoryParams,
  UiSessionOpenParams,
  UiSessionRefParams,
  UiSessionTextParams,
  UiSessionKey,
  UiSystemCapabilitiesResult,
  UI_EVENTS,
  UI_METHODS,
  UiCommandId,
  type UiEventFrame as UiEventFrameValue,
  type UiGatewayResult,
  type UiRequestEnvelope,
  type UiRequestId,
  type UiSessionRef,
} from "../domain/ui-gateway";
import type { UiGroupRecord as UiGroupRecordValue } from "../domain/ui-gateway";
import type { ChatPromptOptions } from "./agent";
import type { ChatRegistryEvent, ChatRegistryListEntry } from "./chat-registry";
import {
  ProfileAgentThinking,
  type ProfileAgentThinking as ProfileAgentThinkingValue,
} from "../domain/profile";
import { ProfileId as ProfileIdSchema, type ProfileId } from "../domain/profile-directory";
import type { UiConversationContext } from "../domain/ui-gateway";
import { makeProfileRuntimeDirectory } from "./profile-runtime-directory";
import type { ProfileDirectoryApi } from "./profile-directory";
import {
  dispatchAutomation,
  dispatchExtensions,
  dispatchMemory,
  dispatchPins,
  dispatchSettings,
} from "./ui-gateway/management";
import type { UiGatewayBranch, UiGatewayDependencies } from "./ui-gateway/types";
export type { UiGatewayDependencies } from "./ui-gateway/types";
import {
  badParams,
  boundedText,
  noService,
  protocolFailure,
  safeFailureMessage,
  toGatewayError,
} from "./ui-gateway/errors";

const decodeEmpty = Schema.decodeUnknownEffect(UiEmptyParams, { onExcessProperty: "error" });
const decodeScoped = Schema.decodeUnknownEffect(UiProfileScopedParams, {
  onExcessProperty: "error",
});
const decodeOpen = Schema.decodeUnknownEffect(UiSessionOpenParams, { onExcessProperty: "error" });
const decodeRef = Schema.decodeUnknownEffect(UiSessionRefParams, { onExcessProperty: "error" });
const decodeText = Schema.decodeUnknownEffect(UiSessionTextParams, { onExcessProperty: "error" });
const decodeHistory = Schema.decodeUnknownEffect(UiSessionHistoryParams, {
  onExcessProperty: "error",
});
const decodeAgentList = Schema.decodeUnknownEffect(UiAgentListParams, {
  onExcessProperty: "error",
});
const decodeAgentShow = Schema.decodeUnknownEffect(UiAgentShowParams, {
  onExcessProperty: "error",
});
const decodeAgentValidate = Schema.decodeUnknownEffect(UiAgentValidateParams, {
  onExcessProperty: "error",
});
const decodeAgentCreate = Schema.decodeUnknownEffect(UiAgentCreateParams, {
  onExcessProperty: "error",
});
const decodeAgentRun = Schema.decodeUnknownEffect(UiAgentRunParams, { onExcessProperty: "error" });
const UiCommandProbe = Schema.Struct({
  profileId: Schema.optionalKey(ProfileIdSchema),
  commandId: Schema.optionalKey(UiCommandId),
});
const decodeCommandProbe = Schema.decodeUnknownOption(UiCommandProbe, {
  onExcessProperty: "ignore",
});
const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));
const decodeSessionKey = Schema.decodeUnknownEffect(UiSessionKey);
const decodeEventFrame = Schema.decodeUnknownSync(UiEventFrame);
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
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(UiResponseFrame));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(UiEventFrame));

export interface UiGatewayConnection {
  readonly request: (request: UiRequestEnvelope) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface UiGatewayApi {
  readonly connect: (send: (frame: string) => void) => UiGatewayConnection;
}

/**
 * Composition input for a gateway shared by multiple resident Profile branches.
 *
 * Branches are deliberately supplied as a complete set at construction time. Each branch owns
 * its ChatRegistry, while the directory remains the source of Profile identity and availability.
 * The runtime directory then makes branch lookup explicit for every routed operation.
 */
export interface SharedUiGatewayDependencies extends Omit<
  UiGatewayDependencies,
  "defaultProfile" | "profileDirectory" | "runtimeDirectory"
> {
  readonly profileDirectory: ProfileDirectoryApi;
  readonly defaultProfile: UiGatewayBranch;
  readonly branches: ReadonlyArray<UiGatewayBranch>;
}

export class UiGateway extends Context.Service<UiGateway, UiGatewayApi>()("ziggy/UiGateway") {}

const MAX_CACHE = 512;
interface CachedCommand {
  readonly fingerprint: string;
  readonly pending?: Deferred.Deferred<UiResponseFrame, never>;
  readonly result?: UiResponseFrame;
}

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
const isProfileAgentThinking = Schema.is(ProfileAgentThinking);
interface ProfileAgentWireProjection {
  id: string;
  description: string;
  provider?: string;
  model?: string;
  thinking?: ProfileAgentThinkingValue;
  tools: ReadonlyArray<string>;
}
interface ProfileAgentValidationWireProjection {
  id: string;
  valid: boolean;
  message?: string;
}
const profileAgentProjection = <
  Agent extends {
    readonly id: string;
    readonly description: string;
    readonly provider?: string;
    readonly model?: string;
    readonly thinking?: string;
    readonly tools: ReadonlyArray<string>;
  },
>(
  agent: Agent,
) => {
  const projection: ProfileAgentWireProjection = {
    id: agent.id,
    description: boundedText(agent.description, 512, "Specialist agent"),
    tools: agent.tools.slice(0, 8).map((tool) => boundedText(tool, 128, "tool")),
  };
  if (agent.provider !== undefined)
    projection.provider = boundedText(agent.provider, 128, "provider");
  if (agent.model !== undefined) projection.model = boundedText(agent.model, 256, "model");
  if (agent.thinking !== undefined && isProfileAgentThinking(agent.thinking))
    projection.thinking = agent.thinking;
  return projection;
};
const profileAgentValidationProjection = (validation: {
  readonly id: string;
  readonly valid: boolean;
  readonly message?: string;
}) => {
  const projection: ProfileAgentValidationWireProjection = {
    id: validation.id,
    valid: validation.valid,
  };
  if (validation.message !== undefined) projection.message = boundedText(validation.message);
  return projection;
};
const validSessionKey = (key: string): Effect.Effect<UiSessionKey, UiGatewayError> =>
  decodeSessionKey(key).pipe(Effect.mapError((cause) => badParams("session", cause)));

const groupConversationId = (groupId: string): UiSessionKey =>
  `ui/group-${createHash("sha256").update(groupId).digest("hex").slice(0, 32)}`;

const GROUP_DISCUSSION_MAX_AGENTS = 4;
const GROUP_DISCUSSION_ANSWER_MAX_CODE_POINTS = 2_000;
const GROUP_DISCUSSION_CONTEXT_MAX_CODE_POINTS = 8_000;
const ASSISTANT_DELTA_MAX_BYTES = 2_000;
const ASSISTANT_SNAPSHOT_MAX_BYTES = 8_000;
const THINKING_DELTA_MAX_BYTES = 8_000;
const TOOL_DETAIL_MAX_CODE_POINTS = 4_096;
const wireText = (value: string, maximum: number): string => [...value].slice(0, maximum).join("");
const wireTextBytes = (value: string, maximum: number): string => {
  const encoder = new TextEncoder();
  const result: string[] = [];
  let size = 0;
  for (const point of value) {
    const nextSize = size + encoder.encode(point).byteLength;
    if (nextSize > maximum) break;
    result.push(point);
    size = nextSize;
  }
  return result.join("");
};

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

const sameGroupConfiguration = (left: UiGroupRecordValue, right: UiGroupRecordValue): boolean =>
  left.groupId === right.groupId &&
  left.conversationId === right.conversationId &&
  left.hostProfileId === right.hostProfileId &&
  left.defaultRecipient.kind === right.defaultRecipient.kind &&
  (left.defaultRecipient.kind !== "agent" || right.defaultRecipient.kind !== "agent"
    ? left.defaultRecipient.kind === right.defaultRecipient.kind
    : left.defaultRecipient.agentId === right.defaultRecipient.agentId) &&
  left.memberAgentIds.length === right.memberAgentIds.length &&
  left.memberAgentIds.every((member, index) => member === right.memberAgentIds[index]);

const eventFrame = (
  profileId: ProfileId,
  ref: UiSessionRef,
  event: ChatRegistryEvent,
  epoch: string,
  correlationId?: UiCommandId,
): UiEventFrameValue => {
  const base = {
    profileId,
    session: ref,
    epoch,
    seq: event.seq,
    eventId: event.eventId,
  };
  const withCorrelation = <A extends object>(value: A): A => {
    if (correlationId === undefined) return value;
    return { ...value, correlationId };
  };
  switch (event.event.kind) {
    case "assistant-text":
      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "assistant-text",
          payload: {
            delta: wireTextBytes(event.event.delta, ASSISTANT_DELTA_MAX_BYTES),
            snapshot: wireTextBytes(event.event.snapshot, ASSISTANT_SNAPSHOT_MAX_BYTES),
          },
        }),
      );
    case "thinking":
      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "thinking",
          payload: {
            delta: wireTextBytes(event.event.delta, THINKING_DELTA_MAX_BYTES),
          },
        }),
      );
    case "tool":
      if (event.event.detail === undefined) {
        return decodeEventFrame(
          withCorrelation({
            ...base,
            event: "tool",
            payload: {
              phase: event.event.phase,
              toolCallId: boundedText(event.event.toolCallId, 256, "tool"),
              toolName: boundedText(event.event.toolName, 256, "tool"),
              failed: event.event.failed,
            },
          }),
        );
      }
      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "tool",
          payload: {
            phase: event.event.phase,
            toolCallId: boundedText(event.event.toolCallId, 256, "tool"),
            toolName: boundedText(event.event.toolName, 256, "tool"),
            failed: event.event.failed,
            detail: wireText(event.event.detail, TOOL_DETAIL_MAX_CODE_POINTS),
          },
        }),
      );
    case "voice":
      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "voice",
          payload: {
            agentId: event.event.agentId,
            text: wireText(event.event.text, 4_096),
          },
        }),
      );
    case "settled":
      return decodeEventFrame(withCorrelation({ ...base, event: "settled", payload: {} }));
    case "error":
      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "error",
          payload: { message: boundedText(event.event.message) },
        }),
      );
  }
};

const mapHealthMessage = (message: string): string => {
  if (message.includes("/") || message.includes("\\") || message.includes(" at "))
    return "check completed";
  return boundedText(message);
};

const resultFrame = (id: UiRequestId, result: UiGatewayResult): UiResponseFrame => ({
  id,
  ok: true,
  result,
});
const failureFrame = (id: UiRequestId, error: UiGatewayError): UiResponseFrame => ({
  id,
  ok: false,
  error:
    error.details === undefined
      ? { code: error.code, message: boundedText(error.message) }
      : { code: error.code, message: boundedText(error.message), details: error.details },
});

const encodeResponseForTransport = (frame: UiResponseFrame): Effect.Effect<string> =>
  Effect.try({
    try: () => encodeResponse(frame),
    catch: (cause) =>
      new UiGatewayError({
        code: "internal",
        message: "response could not be encoded",
        cause,
      }),
  }).pipe(Effect.catch((error) => Effect.succeed(JSON.stringify(failureFrame(frame.id, error)))));

const sendResponse = (send: (frame: string) => void, frame: UiResponseFrame): Effect.Effect<void> =>
  encodeResponseForTransport(frame).pipe(
    Effect.tap((encoded) => Effect.sync(() => send(encoded))),
    Effect.asVoid,
  );

export const makeUiGateway = (config: UiGatewayDependencies): UiGatewayApi => {
  const serverEpoch = randomUUID();
  const pins = config.pins ?? makeUiPinStore();
  const groups = config.groups ?? makeUiGroupStore();
  const commands = new Map<string, CachedCommand>();
  const profileBranches = new Map<ProfileId, UiGatewayBranch>([
    [config.defaultProfile.profileId, config.defaultProfile],
  ]);

  const branchFor = (profileId: ProfileId): Effect.Effect<UiGatewayBranch, UiGatewayError> => {
    const existing = profileBranches.get(profileId);
    if (existing !== undefined) return Effect.succeed(existing);
    if (config.runtimeDirectory !== undefined) {
      return config.runtimeDirectory
        .branch(profileId)
        .pipe(Effect.mapError((cause) => toGatewayError("profile.resolve", cause)));
    }
    if (config.profileDirectory !== undefined) {
      return config.profileDirectory.resolve(profileId).pipe(
        Effect.flatMap((resolved) =>
          resolved.profileId === config.defaultProfile.profileId
            ? Effect.succeed(config.defaultProfile)
            : Effect.fail(
                protocolFailure(
                  "profile_unavailable",
                  "the requested Profile resident is unavailable",
                ),
              ),
        ),
        Effect.mapError((cause) => toGatewayError("profile.resolve", cause)),
      );
    }
    return Effect.fail(
      protocolFailure("unknown_profile", "the requested Profile is not registered"),
    );
  };

  const defaultProfile = (): Effect.Effect<UiGatewayBranch, UiGatewayError> =>
    Effect.succeed(config.defaultProfile);

  const ensureGroup = (
    branch: UiGatewayBranch,
    context: Extract<UiConversationContext, { kind: "group" }>,
    commandId: UiCommandId | undefined,
  ): Effect.Effect<
    {
      readonly context: Extract<UiConversationContext, { kind: "group" }>;
      readonly record: UiGroupRecordValue;
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
      const requested: UiGroupRecordValue = {
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

  const subscribe = (
    send: (frame: string) => void,
    branch: UiGatewayBranch,
    ref: UiSessionRef,
    afterSeq: number,
    epoch: string | undefined,
    correlationId: UiCommandId | undefined,
  ): Effect.Effect<() => void, UiGatewayError> => {
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

  const dispatch = (
    request: UiRequestEnvelope,
    send: (frame: string) => void,
    subscriptions: Map<string, () => void>,
  ): Effect.Effect<UiGatewayResult, UiGatewayError> => {
    const route = (profileId: ProfileId): Effect.Effect<UiGatewayBranch, UiGatewayError> =>
      branchFor(profileId);
    switch (isKnownMethod(request.method) ? request.method : undefined) {
      case "ping":
        return decodeEmpty(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
          Effect.as({ pong: true }),
        );
      case "system.capabilities":
        return decodeEmpty(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
          Effect.andThen(defaultProfile()),
          Effect.map(
            (branch) =>
              ({
                protocolVersion: 1,
                defaultProfileId: branch.profileId,
                methods: [...UI_METHODS],
                events: [...UI_EVENTS],
                bounds: { maxPromptCodePoints: 60_000, replayWindow: 256, maxHistoryEntries: 32 },
                serverEpoch,
              }) satisfies typeof UiSystemCapabilitiesResult.Type,
          ),
        );
      case "profile.list":
        return decodeEmpty(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
          Effect.andThen(
            config.profileDirectory === undefined
              ? defaultProfile().pipe(
                  Effect.map((branch) => ({
                    profiles: [
                      {
                        profileId: branch.profileId,
                        name: branch.target.name,
                        current: true,
                        available: true,
                      },
                    ],
                  })),
                )
              : config.profileDirectory.list().pipe(
                  Effect.map((profiles) => ({ profiles: profiles.slice(0, 32) })),
                  Effect.mapError((cause) => toGatewayError(request.method, cause)),
                ),
          ),
        );
      case "profile.current":
        return decodeEmpty(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
          Effect.andThen(
            config.profileDirectory === undefined
              ? defaultProfile().pipe(
                  Effect.map((branch) => ({
                    profileId: branch.profileId,
                    name: branch.target.name,
                  })),
                )
              : config.profileDirectory.current().pipe(
                  Effect.map((current) => ({
                    profileId: current.profileId,
                    name: current.target.name,
                  })),
                  Effect.mapError((cause) => toGatewayError(request.method, cause)),
                ),
          ),
        );
      case "profile.health":
        return Effect.gen(function* () {
          const params = yield* decodeScoped(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );
          const branch = yield* route(params.profileId);
          if (config.doctor === undefined) {
            return {
              profileId: branch.profileId,
              checks: [
                {
                  id: "resident",
                  severity: "ok" as const,
                  message: "Profile resident is available",
                },
              ],
              hasErrors: false,
            };
          }
          const report = yield* config.doctor
            .check(branch.target, config.repositoryRoot)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));
          return {
            profileId: branch.profileId,
            checks: report.checks.slice(0, 16).map((check) => ({
              id: boundedText(check.id, 80, "check"),
              severity: check.severity,
              message: mapHealthMessage(check.message),
            })),
            hasErrors: report.hasErrors,
          };
        });
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
            return {
              profileId: branch.profileId,
              ref: params.ref,
              kind: "live" as const,
              live: liveSessionProjection(branch.profileId, entry),
            };
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
          };
        });
      case "session.history":
        return Effect.gen(function* () {
          const params = yield* decodeHistory(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );
          const branch = yield* route(params.ref.profileId);
          if (config.sessions.history === undefined) return yield* noService(request.method);
          const page = yield* config.sessions
            .history(
              branch.target,
              params.ref.kind === "stored" ? params.ref.id : params.ref.key,
              params.before,
            )
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
              ? config.agent.openChat(branch.target, context, sessionDirectory, "continue")
              : config.agent.openSpecialistChat(branch.target, params.agentId);
          const metadata =
            params.agentId === undefined ? { context } : { context, agentId: params.agentId };
          yield* branch.registry.getOrOpenUi(key, open, metadata);
          const ref = sessionRef(branch.profileId, key);
          const subscriptionKey = `${branch.profileId}:${key}`;
          subscriptions.get(subscriptionKey)?.();
          const unsubscribe = yield* subscribe(send, branch, ref, 0, undefined, params.commandId);
          subscriptions.set(subscriptionKey, unsubscribe);
          return { ref };
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
          subscriptions.get(subscriptionKey)?.();
          const unsubscribe = yield* subscribe(
            send,
            branch,
            params.ref,
            params.afterSeq ?? 0,
            params.epoch,
            params.commandId,
          );
          subscriptions.set(subscriptionKey, unsubscribe);
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
              yield* branch.registry.submit(params.ref.key, params.text, options);
            } else {
              yield* branch.registry.submit(params.ref.key, params.text);
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
      case "agent.list":
        return decodeAgentList(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
          Effect.flatMap((params) => route(params.profileId)),
          Effect.flatMap((branch) =>
            config.profileAgents === undefined
              ? Effect.fail(noService(request.method))
              : config.profileAgents.list(branch.target).pipe(
                  Effect.map((agents) => ({
                    profileId: branch.profileId,
                    agents: agents
                      .slice(0, 4)
                      .map(({ path: _path, ...agent }) => profileAgentProjection(agent)),
                  })),
                  Effect.mapError((cause) => toGatewayError(request.method, cause)),
                ),
          ),
        );
      case "agent.show":
        return Effect.gen(function* () {
          const params = yield* decodeAgentShow(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );
          const branch = yield* route(params.profileId);
          if (config.profileAgents === undefined)
            return yield* Effect.fail(noService(request.method));
          const agent = yield* config.profileAgents
            .show(branch.target, params.agentId)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));
          const { path: _path, ...withoutPath } = agent;
          return { profileId: branch.profileId, agent: profileAgentProjection(withoutPath) };
        });
      case "agent.create":
        return Effect.gen(function* () {
          const params = yield* decodeAgentCreate(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );
          const branch = yield* route(params.profileId);
          if (config.profileAgents === undefined)
            return yield* Effect.fail(noService(request.method));
          const agent = yield* config.profileAgents
            .create(branch.target, params.agentId)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));
          const { path: _path, ...withoutPath } = agent;
          return { profileId: branch.profileId, agent: profileAgentProjection(withoutPath) };
        });
      case "agent.validate":
        return Effect.gen(function* () {
          const params = yield* decodeAgentValidate(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );
          const branch = yield* route(params.profileId);
          if (config.profileAgents === undefined)
            return yield* Effect.fail(noService(request.method));
          const validations = yield* config.profileAgents
            .validate(branch.target, params.agentId)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));
          return {
            profileId: branch.profileId,
            validations: validations
              .slice(0, 16)
              .map(({ path: _path, ...validation }) =>
                profileAgentValidationProjection(validation),
              ),
          };
        });
      case "agent.run":
        return Effect.gen(function* () {
          const params = yield* decodeAgentRun(request.params).pipe(
            Effect.mapError((cause) => badParams(request.method, cause)),
          );
          const branch = yield* route(params.profileId);
          if (config.profileAgents === undefined)
            return yield* Effect.fail(noService(request.method));
          const result = yield* config.profileAgents
            .run(branch.target, params.agentId, params.task)
            .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));
          return {
            profileId: branch.profileId,
            agentId: params.agentId,
            answer: [...result.answer].slice(0, 8_000).join(""),
            sessionId: result.session.id,
          };
        });
      case "model.status":
      case "model.list":
      case "model.available":
      case "model.set":
      case "auth.status":
        return dispatchSettings(request, route, config);
      case "automation.list":
      case "automation.show":
      case "automation.create":
      case "automation.save":
      case "automation.validate":
      case "automation.pause":
      case "automation.resume":
      case "automation.run":
      case "automation.status":
      case "automation.runs":
        return dispatchAutomation(request, route, config);
      case "memory.list":
      case "memory.show":
        return dispatchMemory(request, route, config);
      case "extension.list-for-profile":
      case "extension.add":
      case "extension.remove":
      case "extension.validate":
        return dispatchExtensions(request, route, config);
      case "pin.list":
      case "pin.set":
      case "pin.remove":
        return dispatchPins(request, route, pins);
      default:
        return Effect.fail(
          protocolFailure("unknown_method", `unknown UI gateway method ${request.method}`),
        );
    }
  };

  const requestFor =
    (send: (frame: string) => void, subscriptions: Map<string, () => void>) =>
    (request: UiRequestEnvelope): Effect.Effect<void> => {
      const commandProbe = decodeCommandProbe(request.params);
      const commandId = Option.isSome(commandProbe) ? commandProbe.value.commandId : undefined;
      const profileId =
        Option.isSome(commandProbe) && commandProbe.value.profileId !== undefined
          ? commandProbe.value.profileId
          : config.defaultProfile.profileId;
      const run = dispatch(request, send, subscriptions).pipe(
        Effect.map((result) => resultFrame(request.id, result)),
        Effect.catch((cause) =>
          Effect.succeed(failureFrame(request.id, toGatewayError(request.method, cause))),
        ),
      );
      return commandId === undefined
        ? run.pipe(Effect.flatMap((frame) => sendResponse(send, frame)))
        : runCommand(
            `${profileId}:${commandId}`,
            `${request.method}:${safeFingerprint(request.params)}`,
            run,
            commands,
          ).pipe(
            Effect.catch((cause) =>
              Effect.succeed(failureFrame(request.id, toGatewayError(request.method, cause))),
            ),
            Effect.map((frame) => ({ ...frame, id: request.id })),
            Effect.flatMap((frame) => sendResponse(send, frame)),
          );
    };

  return {
    connect: (send) => {
      const subscriptions = new Map<string, () => void>();
      return {
        request: requestFor(send, subscriptions),
        close: Effect.sync(() => {
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
        }),
      };
    },
  };
};

const safeFingerprint = (value: Schema.Json): string => JSON.stringify(value);

const runCommand = (
  key: string,
  fingerprint: string,
  run: Effect.Effect<UiResponseFrame>,
  cache: Map<string, CachedCommand>,
): Effect.Effect<UiResponseFrame, UiGatewayError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const existing = cache.get(key);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint)
          return yield* Effect.fail(
            protocolFailure("conflict", "command id was already used for a different request"),
          );
        if (existing.result !== undefined) return existing.result;
        if (existing.pending !== undefined) return yield* restore(Deferred.await(existing.pending));
      }
      const pending = yield* Deferred.make<UiResponseFrame, never>();
      cache.set(key, { fingerprint, pending });
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value ?? key);
      const result = yield* run;
      cache.set(key, { fingerprint, result });
      yield* Deferred.succeed(pending, result);
      return result;
    }),
  );

/** Build one current-protocol gateway with isolated, explicitly-routable Profile branches. */
export const makeSharedUiGateway = (config: SharedUiGatewayDependencies): UiGatewayApi => {
  const branches = config.branches.some(
    (branch) => branch.profileId === config.defaultProfile.profileId,
  )
    ? config.branches
    : [config.defaultProfile, ...config.branches];
  const runtimeDirectory = makeProfileRuntimeDirectory(config.profileDirectory, branches);
  return makeUiGateway({
    ...config,
    runtimeDirectory,
  });
};
