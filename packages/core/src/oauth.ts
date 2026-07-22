import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Clock, Effect, Schema } from "effect";

export { registerBunOAuthFlows };

export class OAuthProbeError extends Schema.TaggedErrorClass<OAuthProbeError>()("OAuthProbeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const probeBunOAuthFlows: Effect.Effect<void, OAuthProbeError> = Effect.gen(function* () {
  yield* Effect.sync(registerBunOAuthFlows);
  const providers = builtinProviders();
  for (const providerId of ["anthropic", "openai-codex"]) {
    const provider = providers.find((candidate) => candidate.id === providerId);
    const oauth = provider?.auth.oauth;
    if (oauth === undefined) {
      return yield* new OAuthProbeError({
        message: `Missing built-in OAuth Provider ${providerId}`,
      });
    }
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise({
      try: () =>
        oauth.toAuth({
          type: "oauth",
          access: "compile-smoke-access",
          refresh: "compile-smoke-refresh",
          expires: now + 60_000,
        }),
      catch: (cause) =>
        new OAuthProbeError({
          message: `Failed to probe built-in OAuth Provider ${providerId}`,
          cause,
        }),
    });
  }
});
