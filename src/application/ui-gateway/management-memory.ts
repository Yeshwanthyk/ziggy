import { Effect, Schema } from "effect";

import {
  UiGatewayError,
  UiMemoryListParams,
  UiMemoryPath,
  UiMemoryShowParams,
  UI_METHODS,
  type UiGatewayResult,
  type UiRequestEnvelope,
} from "../../domain/ui-gateway";

import { memoryDocumentFromRelativePath } from "../../domain/memory";

import type { ProfileId } from "../../domain/profile-directory";
import type { UiGatewayBranch, UiGatewayDependencies } from "./types";
import { badParams, noService, protocolFailure, toGatewayError } from "./errors";

const decodeMemoryList = Schema.decodeUnknownEffect(UiMemoryListParams, {
  onExcessProperty: "error",
});

const decodeMemoryShow = Schema.decodeUnknownEffect(UiMemoryShowParams, {
  onExcessProperty: "error",
});

const decodeUiMemoryPath = Schema.decodeUnknownEffect(UiMemoryPath);

const isKnownMethod = Schema.is(Schema.Literals(UI_METHODS));

export const dispatchMemory = (
  request: UiRequestEnvelope,
  route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
  config: UiGatewayDependencies,
): Effect.Effect<UiGatewayResult, UiGatewayError> => {
  switch (isKnownMethod(request.method) ? request.method : undefined) {
    case "memory.list":
      return decodeMemoryList(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) => route(params.profileId)),
        Effect.flatMap((branch) =>
          config.memory === undefined
            ? Effect.fail(noService(request.method))
            : config.memory.list(branch.target).pipe(
                Effect.map((documents) => ({
                  profileId: branch.profileId,
                  documents: documents
                    .slice(0, 16)
                    .map(({ document, state, entries, codePoints, cap }) => ({
                      path: document.relativePath,
                      scope: document.scope,
                      state,
                      entryCount: entries.length,
                      codePoints,
                      cap,
                    })),
                })),
                Effect.mapError((cause) => toGatewayError(request.method, cause)),
              ),
        ),
      );
    case "memory.show":
      return decodeMemoryShow(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
        Effect.flatMap((params) =>
          route(params.profileId).pipe(
            Effect.flatMap((branch) => {
              const document = memoryDocumentFromRelativePath(branch.target.path, params.path);

              return document === undefined
                ? Effect.fail(badParams(request.method, "unknown logical memory path"))
                : config.memory === undefined
                  ? Effect.fail(noService(request.method))
                  : config.memory
                      .show(
                        branch.target,
                        document.scope === "shared"
                          ? { scope: "shared" }
                          : {
                              scope: document.scope,
                              id:
                                document.relativePath.split("/").at(-1)?.replace(/\.md$/u, "") ??
                                "",
                            },
                      )
                      .pipe(
                        Effect.flatMap(
                          ({ document: loaded, state, entries, codePoints, cap, content }) =>
                            decodeUiMemoryPath(loaded.relativePath).pipe(
                              Effect.mapError((cause) =>
                                protocolFailure("internal", "invalid memory document path", cause),
                              ),
                              Effect.map((path) => ({
                                profileId: branch.profileId,
                                path,
                                scope: loaded.scope,
                                state,
                                content,
                                entries,
                                codePoints,
                                cap,
                              })),
                            ),
                        ),
                        Effect.mapError((cause) => toGatewayError(request.method, cause)),
                      );
            }),
          ),
        ),
      );
    default:
      return Effect.fail(
        protocolFailure("unknown_method", `unknown memory method ${request.method}`),
      );
  }
};
