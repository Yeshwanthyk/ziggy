import { Context, Effect, Layer } from "effect";
import {
  listAuthStatusReadOnly,
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
  readonly readOnlyStatus: (
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

const status = (
  target: ProfileTarget,
): Effect.Effect<ReadonlyArray<ProviderAuthStatus>, AuthError> =>
  listAuthStatusReadOnly(target.path);

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

    return yield* loginProvider(target.path, providerId, selectedType, interaction);
  });

export const AuthLive = Layer.succeed(Auth, {
  status,
  readOnlyStatus: (target) => listAuthStatusReadOnly(target.path),
  login,
});
