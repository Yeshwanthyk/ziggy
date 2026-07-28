import { Context, Effect, Layer, Predicate } from "effect";
import {
  listAuthStatus,
  loginProvider,
  type AuthInteraction,
  type ProviderAuthStatus,
  type ProviderAuthType,
  type ProviderLoginResult,
} from "../adapters/pi/auth";
import {
  AuthFlowFailed,
  AuthProviderUnknown,
  AuthTypeUnsupported,
  ProfileNotInitialized,
  ProviderConfigError,
} from "../domain/agent";
import type { ProfileTarget } from "../domain/profile";

export type AuthError =
  | ProfileNotInitialized
  | ProviderConfigError
  | AuthProviderUnknown
  | AuthTypeUnsupported
  | AuthFlowFailed;

export interface AuthShape {
  readonly status: (
    target: ProfileTarget,
  ) => Effect.Effect<ReadonlyArray<ProviderAuthStatus>, AuthError>;
  readonly login: (
    target: ProfileTarget,
    providerId: string,
    type: ProviderAuthType | undefined,
    interaction: AuthInteraction,
  ) => Effect.Effect<ProviderLoginResult, AuthError>;
}

export class Auth extends Context.Service<Auth, AuthShape>()("ziggy/Auth") {}

export const defaultAuthType = (provider: ProviderAuthStatus): ProviderAuthType =>
  provider.supportsOauth && !provider.supportsApiKeyLogin ? "oauth" : "api_key";

const isAuthError = (cause: unknown): cause is AuthError =>
  Predicate.isTagged(cause, "ProfileNotInitialized") ||
  Predicate.isTagged(cause, "ProviderConfigError") ||
  Predicate.isTagged(cause, "AuthProviderUnknown") ||
  Predicate.isTagged(cause, "AuthTypeUnsupported") ||
  Predicate.isTagged(cause, "AuthFlowFailed");

const statusFailure = (profilePath: string, cause: unknown): AuthError =>
  isAuthError(cause)
    ? cause
    : new ProviderConfigError({
        profilePath,
        operation: "load provider auth",
        message: `could not load provider auth for ${profilePath}`,
        cause,
      });

const loginFailure = (providerId: string, cause: unknown): AuthError =>
  isAuthError(cause)
    ? cause
    : new AuthFlowFailed({
        providerId,
        message: `authentication failed for ${providerId}`,
        cause,
      });

const status = (
  target: ProfileTarget,
): Effect.Effect<ReadonlyArray<ProviderAuthStatus>, AuthError> =>
  Effect.tryPromise({
    try: () => listAuthStatus(target.path),
    catch: (cause) => statusFailure(target.path, cause),
  });

const login = (
  target: ProfileTarget,
  providerId: string,
  type: ProviderAuthType | undefined,
  interaction: AuthInteraction,
): Effect.Effect<ProviderLoginResult, AuthError> =>
  Effect.gen(function* () {
    let selectedType = type;
    if (selectedType === undefined) {
      const providers = yield* status(target);
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (provider === undefined) {
        return yield* new AuthProviderUnknown({
          profilePath: target.path,
          providerId,
          message: `unknown auth provider ${providerId}`,
        });
      }
      selectedType = defaultAuthType(provider);
    }

    return yield* Effect.tryPromise({
      try: () => loginProvider(target.path, providerId, selectedType, interaction),
      catch: (cause) => loginFailure(providerId, cause),
    });
  });

export const AuthLive = Layer.succeed(Auth, { status, login });
