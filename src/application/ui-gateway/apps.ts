import { Effect, Schema } from "effect";
import {
  UiAppCallToolParams,
  UiAppContentResult,
  UiAppReadResourceParams,
  type UiGatewayError,
  type UiGatewayResult,
  type UiRequestEnvelope,
  type UiSessionRef,
} from "../../domain/ui-gateway";
import type { ProfileId } from "../../domain/profile-directory";
import type { McpAppRefused } from "../../extensions";
import { UI_APP_CONTENT_MAX_BYTES, type UiAppContentStore } from "./app-content";
import { badParams, liveFailure, protocolFailure } from "./errors";
import type { UiGatewayBranch } from "./types";

const decodeCallTool = Schema.decodeUnknownEffect(UiAppCallToolParams, {
  onExcessProperty: "error",
});

const decodeReadResource = Schema.decodeUnknownEffect(UiAppReadResourceParams, {
  onExcessProperty: "error",
});

const decodeResult = Schema.decodeUnknownEffect(UiAppContentResult);

const refusal = (cause: McpAppRefused): UiGatewayError =>
  cause.reason === "unavailable" || cause.reason === "failed"
    ? protocolFailure("internal", cause.message)
    : protocolFailure("ownership", cause.message);

/**
 * `app.callTool` and `app.readResource`: a view in the web UI reaches its own MCP server through
 * the live web-UI session that rendered it; other live kinds are watch-only. The session's MCP
 * Apps registry enforces the owning server and the tool's `"app"` visibility; the result waits in
 * the content store, readable only by the connection's upload owner that asked for it.
 */
export const makeAppDispatcher =
  (
    route: (profileId: ProfileId) => Effect.Effect<UiGatewayBranch, UiGatewayError>,
    content: UiAppContentStore,
  ) =>
  (request: UiRequestEnvelope, owner: string): Effect.Effect<UiGatewayResult, UiGatewayError> => {
    const handleFor = (ref: UiSessionRef) =>
      Effect.gen(function* () {
        if (ref.kind === "stored")
          return yield* protocolFailure("watch_only", "views of stored sessions are read-only");

        const branch = yield* route(ref.profileId);
        const entry = yield* branch.live.get(ref.key).pipe(Effect.mapError(liveFailure));

        // Telegram, Discord and Slack sessions are watch-only here, as they are for prompt.submit.
        if (entry.kind !== "ui")
          return yield* protocolFailure("watch_only", `${ref.key} is watch-only`);

        return { branch, handle: entry.handle };
      });

    const stored = (branch: UiGatewayBranch, value: Schema.Json) =>
      Effect.gen(function* () {
        const body = JSON.stringify(value);
        const bytes = new TextEncoder().encode(body).byteLength;

        if (bytes > UI_APP_CONTENT_MAX_BYTES)
          return yield* protocolFailure("internal", "the MCP result is too large for a view");

        return yield* decodeResult({
          profileId: branch.profileId,
          contentId: content.put(owner, body),
          bytes,
        }).pipe(Effect.mapError(() => protocolFailure("internal", "invalid app content result")));
      });

    if (request.method === "app.callTool")
      return Effect.gen(function* () {
        const params = yield* decodeCallTool(request.params).pipe(
          Effect.mapError((cause) => badParams(request.method, cause)),
        );

        const { branch, handle } = yield* handleFor(params.ref);

        const result = yield* handle
          .callAppTool(params.server, params.resourceUri, params.tool, params.arguments ?? {})
          .pipe(Effect.mapError(refusal));

        return yield* stored(branch, result);
      });

    return Effect.gen(function* () {
      const params = yield* decodeReadResource(request.params).pipe(
        Effect.mapError((cause) => badParams(request.method, cause)),
      );

      const { branch, handle } = yield* handleFor(params.ref);

      const result = yield* handle
        .readAppResource(params.server, params.uri)
        .pipe(Effect.mapError(refusal));

      return yield* stored(branch, result);
    });
  };
