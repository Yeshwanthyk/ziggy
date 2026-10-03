import { Context, Effect, Layer } from "effect";
import {
  listAuthStatusReadOnly,
  loginProvider,
  type AuthInteraction,
  type ProviderAuthStatus,
  type ProviderAuthType,
} from "./pi-auth";
import {
  checkSessionModel,
  getModelStatusReadOnly,
  listAvailableModels,
  listModelsReadOnly,
  setModel,
  type SessionModelOverride,
} from "./pi-models";
import {
  AuthProviderUnknown,
  type ProviderConfigError,
  type AuthFlowFailed,
  type AuthTypeUnsupported,
  type ModelOperationFailed,
  type ModelProviderUnknown,
  type ModelSettingsWriteFailed,
  type ModelThinkingUnsupported,
  type ModelUnknown,
  type ProfileNotInitialized,
  type ProfileTarget,
} from "./types";

export type ModelsError =
  | ProfileNotInitialized
  | ModelOperationFailed
  | ModelProviderUnknown
  | ModelUnknown
  | ModelThinkingUnsupported
  | ModelSettingsWriteFailed;

export type AuthError =
  | ProfileNotInitialized
  | ProviderConfigError
  | AuthProviderUnknown
  | AuthTypeUnsupported
  | AuthFlowFailed;

/** A Profile's model selection, read without writing Pi's settings or model cache. */
export class Models extends Context.Service<Models>()("ziggy/Models", {
  make: Effect.succeed({
    status: Effect.fn("Models.status")((target: ProfileTarget) =>
      getModelStatusReadOnly(target.path),
    ),
    list: Effect.fn("Models.list")((target: ProfileTarget, providerId?: string) =>
      listModelsReadOnly(target.path, providerId),
    ),
    available: Effect.fn("Models.available")((target: ProfileTarget) =>
      listAvailableModels(target.path),
    ),
    /** Whether a session with this override (or none: the Profile default) could run now. */
    check: Effect.fn("Models.check")((target: ProfileTarget, override?: SessionModelOverride) =>
      checkSessionModel(target.path, override),
    ),
    set: Effect.fn("Models.set")(
      (target: ProfileTarget, providerId: string, modelId: string, thinking?: string) =>
        setModel(target.path, providerId, modelId, thinking),
    ),
  } as const),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export type ModelsApi = (typeof Models)["Service"];

export const defaultAuthType = (provider: ProviderAuthStatus): ProviderAuthType =>
  provider.supportsOauth && !provider.supportsApiKeyLogin ? "oauth" : "api_key";

/** Provider credentials stored in a Profile. `status` never writes. */
export class Auth extends Context.Service<Auth>()("ziggy/Auth", {
  make: Effect.sync(() => {
    const status = Effect.fn("Auth.status")((target: ProfileTarget) =>
      listAuthStatusReadOnly(target.path),
    );

    /** Log in with `type`, or with the provider's default login type when it is omitted. */
    const login = Effect.fn("Auth.login")(function* (
      target: ProfileTarget,
      providerId: string,
      type: ProviderAuthType | undefined,
      interaction: AuthInteraction,
    ) {
      if (type !== undefined)
        return yield* loginProvider(target.path, providerId, type, interaction);

      const provider = (yield* status(target)).find((candidate) => candidate.id === providerId);

      if (provider === undefined) {
        return yield* new AuthProviderUnknown({
          profilePath: target.path,
          providerId,
          message: `unknown auth provider ${providerId}`,
        });
      }

      return yield* loginProvider(target.path, providerId, defaultAuthType(provider), interaction);
    });

    return { status, login } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export type AuthApi = (typeof Auth)["Service"];
