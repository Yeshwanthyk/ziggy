import { join } from "node:path";
import { Effect } from "effect";
import { ProviderCallError, ProviderConfigError } from "../../domain/agent";

const runtimeFailureHint = (cause: unknown): string => {
  if (!(cause instanceof Error)) return "check Profile extension diagnostics with ziggy doctor";

  const message = cause.message;

  if (/no models available/iu.test(message))
    return "no models available; configure a provider or run /login";

  if (/authentication|unauthorized|api key/iu.test(message))
    return "provider authentication unavailable; check Profile credentials";

  if (/extension|skill|command conflict/iu.test(message))
    return "check Profile extension diagnostics with ziggy doctor";

  return "check ziggy doctor and the local runtime logs";
};

export const providerError = (
  profilePath: string,
  operation: string,
  cause: unknown,
): ProviderConfigError | ProviderCallError => {
  if (cause instanceof ProviderConfigError || cause instanceof ProviderCallError) {
    return cause;
  }

  if (operation === "call provider") {
    return new ProviderCallError({
      profilePath,
      operation,
      message: "provider request failed",
      cause,
    });
  }

  if (operation === "select model") {
    return new ProviderConfigError({
      profilePath,
      operation,
      message: `provider configuration failed; place credentials in ${join(profilePath, "auth.json")} and model configuration in ${join(profilePath, "models.json")}`,
      cause,
    });
  }

  return new ProviderConfigError({
    profilePath,
    operation,
    message:
      operation === "create agent runtime"
        ? `${operation} failed: ${runtimeFailureHint(cause)}`
        : `${operation} failed`,
    cause,
  });
};

export const piPromise = <A>(
  profilePath: string,
  operation: string,
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ProviderConfigError | ProviderCallError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => providerError(profilePath, operation, cause),
  });
