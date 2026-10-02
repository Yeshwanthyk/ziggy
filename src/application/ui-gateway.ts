import { randomUUID } from "node:crypto";
import { Context, Effect, Option, Schema, Scope } from "effect";
import { makeUiGroupStore, makeUiPinStore } from "../adapters/fs/ui-state";
import {
  UiEmptyParams,
  UiGatewayError,
  UiProfileScopedParams,
  UiSystemCapabilitiesResult,
  UI_EVENTS,
  UI_METHODS,
  UiCommandId,
  type UiGatewayResult,
  type UiRequestEnvelope,
} from "../domain/ui-gateway";
import { ProfileId as ProfileIdSchema, type ProfileId } from "../domain/profile-directory";
import { makeProfileRuntimeDirectory } from "./profile-runtime-directory";
import { makeCommandCache, safeFingerprint } from "./ui-gateway/command-cache";
import { makeUiUploadStore, type UiUploadStore } from "./ui-gateway/uploads";

import { makeSessionDispatcher } from "./ui-gateway/sessions";
import { dispatchGroups, makeEnsureGroup } from "./ui-gateway/groups";
import { dispatchAgents } from "./ui-gateway/management-agents";
import type { ProfileDirectoryApi } from "./profile-directory";
import { dispatchAutomation } from "./ui-gateway/management-automations";
import { dispatchExtensions } from "./ui-gateway/management-extensions";
import { dispatchPluginSecret } from "./ui-gateway/management-plugins";
import { dispatchMemory } from "./ui-gateway/management-memory";
import { dispatchPins } from "./ui-gateway/management-pins";
import { dispatchSettings } from "./ui-gateway/management-settings";
import type { UiGatewayBranch, UiGatewayDependencies } from "./ui-gateway/types";

export { makeUiUploadStore, UI_IMAGE_MAX_BYTES, type UiUploadStore } from "./ui-gateway/uploads";

export type { UiGatewayDependencies } from "./ui-gateway/types";

import { badParams, boundedText, protocolFailure, toGatewayError } from "./ui-gateway/errors";
import { resultFrame, failureFrame, sendResponse } from "./ui-gateway/transport";
import { profileCliTarget } from "../profile";

const decodeEmpty = Schema.decodeUnknownEffect(UiEmptyParams, { onExcessProperty: "error" });

const decodeScoped = Schema.decodeUnknownEffect(UiProfileScopedParams, {
  onExcessProperty: "error",
});

const UiCommandProbe = Schema.Struct({
  profileId: Schema.optionalKey(ProfileIdSchema),
  commandId: Schema.optionalKey(UiCommandId),
});

const decodeCommandProbe = Schema.decodeUnknownOption(UiCommandProbe, {
  onExcessProperty: "ignore",
});

const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));

export interface UiGatewayConnection {
  readonly request: (request: UiRequestEnvelope) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface UiGatewayApi {
  readonly uploads: UiUploadStore;
  readonly connect: (send: (frame: string) => void, uploadOwner?: string) => UiGatewayConnection;
}

/**
 * Composition input for a gateway shared by multiple resident Profile branches.
 *
 * Branches are deliberately supplied as a complete set at construction time. Each branch owns
 * its live sessions, while the directory remains the source of Profile identity and availability.
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

const mapHealthMessage = (message: string): string => {
  if (message.includes("/") || message.includes("\\") || message.includes(" at "))
    return "check completed";

  return boundedText(message);
};

export const makeUiGateway = (
  config: UiGatewayDependencies,
): Effect.Effect<UiGatewayApi, never, Scope.Scope> =>
  Effect.gen(function* () {
    const commandScope = yield* Scope.fork(yield* Effect.scope);
    const serverEpoch = randomUUID();
    const pins = config.pins ?? makeUiPinStore();
    const groups = config.groups ?? makeUiGroupStore();
    const runCommand = makeCommandCache(commandScope);

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

    const cliTarget = (profilePath: string): string =>
      config.profilesDirectory === undefined
        ? profilePath
        : profileCliTarget(profilePath, config.profilesDirectory);

    const defaultProfile = (): Effect.Effect<UiGatewayBranch, UiGatewayError> =>
      Effect.succeed(config.defaultProfile);

    const ensureGroup = makeEnsureGroup(groups);
    const uploads = makeUiUploadStore();

    const dispatchSessions = makeSessionDispatcher(
      config,
      branchFor,
      serverEpoch,
      ensureGroup,
      uploads,
    );

    const dispatch = (
      request: UiRequestEnvelope,
      send: (frame: string) => void,
      subscriptions: Map<string, () => void>,
      isOpen: () => boolean,
      uploadOwner: string,
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
                      cliTarget: cliTarget(branch.target.path),
                    })),
                  )
                : config.profileDirectory.current().pipe(
                    Effect.map((current) => ({
                      profileId: current.profileId,
                      name: current.target.name,
                      cliTarget: cliTarget(current.target.path),
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
              .check(branch.target)
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
        case "group.list":
          return dispatchGroups(request, route, config, groups, pins);
        case "destination.list":
          return dispatchGroups(request, route, config, groups, pins);
        case "session.list":
        case "session.show":
        case "session.history":
        case "session.open":
        case "session.model.status":
        case "session.model.set":
        case "session.thinking.set":
        case "session.summaries":
        case "session.resume":
        case "session.watch":
        case "session.unwatch":
        case "session.close":
        case "session.steer":
        case "session.follow-up":
        case "session.abort":
        case "prompt.submit":
          return dispatchSessions(request, send, subscriptions, isOpen, uploadOwner);
        case "agent.list":
        case "agent.show":
        case "agent.document":
        case "agent.save":
        case "agent.create":
        case "agent.validate":
        case "agent.run":
          return dispatchAgents(request, route, config);
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
        case "plugin.secret.set":
          return dispatchPluginSecret(request, route, config);
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
      (
        send: (frame: string) => void,
        subscriptions: Map<string, () => void>,
        isOpen: () => boolean,
        uploadOwner: string,
      ) =>
      (request: UiRequestEnvelope): Effect.Effect<void> => {
        const commandProbe = decodeCommandProbe(request.params);
        const commandId = Option.isSome(commandProbe) ? commandProbe.value.commandId : undefined;

        const profileId =
          Option.isSome(commandProbe) && commandProbe.value.profileId !== undefined
            ? commandProbe.value.profileId
            : config.defaultProfile.profileId;

        const run = dispatch(request, send, subscriptions, isOpen, uploadOwner).pipe(
          Effect.map((result) => resultFrame(request.id, result)),
          Effect.catch((cause) =>
            Effect.succeed(failureFrame(request.id, toGatewayError(request.method, cause))),
          ),
        );

        return commandId === undefined
          ? run.pipe(Effect.flatMap((frame) => sendResponse(send, frame)))
          : runCommand(
              `${uploadOwner}:${profileId}:${commandId}`,
              `${request.method}:${safeFingerprint(request.params)}`,
              request.id,
              run,
            ).pipe(
              Effect.catch((cause) =>
                Effect.succeed(failureFrame(request.id, toGatewayError(request.method, cause))),
              ),
              Effect.map((frame) => ({ ...frame, id: request.id })),
              Effect.flatMap((frame) => sendResponse(send, frame)),
            );
      };

    return {
      uploads,
      connect: (send, uploadOwner = "local") => {
        const subscriptions = new Map<string, () => void>();
        let open = true;

        return {
          request: requestFor(send, subscriptions, () => open, uploadOwner),
          close: Effect.sync(() => {
            open = false;

            for (const unsubscribe of subscriptions.values()) unsubscribe();
            subscriptions.clear();
          }),
        };
      },
    };
  });

/** Build one current-protocol gateway with isolated, explicitly-routable Profile branches. */
export const makeSharedUiGateway = (
  config: SharedUiGatewayDependencies,
): Effect.Effect<UiGatewayApi, never, Scope.Scope> => {
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
