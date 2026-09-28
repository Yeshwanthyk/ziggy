import { Effect, Schema } from "effect";
import {
  UiAgentListParams,
  UiAgentShowParams,
  UiAgentDocumentParams,
  UiAgentSaveParams,
  UiAgentCreateParams,
  UiAgentValidateParams,
  UiAgentRunParams,
  UiGatewayError,
  UI_METHODS,
  type UiGatewayResult,
  type UiRequestEnvelope,
} from "../../domain/ui-gateway";
import type { ProfileId } from "../../domain/profile-directory";
import { badParams, noService, protocolFailure, toGatewayError } from "./errors";
import { profileAgentProjection, profileAgentValidationProjection } from "./agent-projection";
import type { UiGatewayBranch, UiGatewayDependencies } from "./types";

const decodeAgentList = Schema.decodeUnknownEffect(UiAgentListParams, {
  onExcessProperty: "error",
});

const decodeAgentShow = Schema.decodeUnknownEffect(UiAgentShowParams, {
  onExcessProperty: "error",
});

const decodeAgentDocument = Schema.decodeUnknownEffect(UiAgentDocumentParams, {
  onExcessProperty: "error",
});

const decodeAgentSave = Schema.decodeUnknownEffect(UiAgentSaveParams, {
  onExcessProperty: "error",
});

const decodeAgentValidate = Schema.decodeUnknownEffect(UiAgentValidateParams, {
  onExcessProperty: "error",
});

const decodeAgentCreate = Schema.decodeUnknownEffect(UiAgentCreateParams, {
  onExcessProperty: "error",
});

const decodeAgentRun = Schema.decodeUnknownEffect(UiAgentRunParams, { onExcessProperty: "error" });

const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));

export const dispatchAgents = (
  request: UiRequestEnvelope,
  route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
  config: UiGatewayDependencies,
): Effect.Effect<UiGatewayResult, UiGatewayError> => {
  switch (isKnownMethod(request.method) ? request.method : undefined) {
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
    case "agent.document":
      return Effect.gen(function* () {
        const params = yield* decodeAgentDocument(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.profileAgents === undefined)
          return yield* Effect.fail(noService(request.method));

        const document = yield* config.profileAgents
          .document(branch.target, params.agentId)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        return { profileId: branch.profileId, ...document };
      });
    case "agent.save":
      return Effect.gen(function* () {
        const params = yield* decodeAgentSave(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const branch = yield* route(params.profileId);

        if (config.profileAgents === undefined)
          return yield* Effect.fail(noService(request.method));

        const document = yield* config.profileAgents
          .save(branch.target, params.agentId, params.expectedSource, params.source)
          .pipe(Effect.mapError((cause) => toGatewayError(request.method, cause)));

        return { profileId: branch.profileId, ...document };
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
            .map(({ path: _path, ...validation }) => profileAgentValidationProjection(validation)),
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
    default:
      return Effect.fail(
        protocolFailure("unknown_method", `unknown agent method ${request.method}`),
      );
  }
};
