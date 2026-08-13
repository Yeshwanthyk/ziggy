import { Context, Effect, Layer } from "effect";
import type { AuthInteraction, ProviderAuthStatus } from "../adapters/pi/auth";
import type { KnownModel } from "../adapters/pi/models";
import { SetupIncomplete, type SetupResult } from "../domain/setup";
import type { ProfileTarget } from "../domain/profile";
import { Auth, type AuthError, type AuthApi } from "./auth";
import { Doctor, type DoctorApi } from "./doctor";
import { Models, type ModelsError, type ModelsApi } from "./models";
import { Profiles, type ProfileError, type ProfilesApi } from "./profiles";

export type SetupError = ProfileError | AuthError | ModelsError | SetupIncomplete;

export interface SetupChoice {
  readonly id: string;
  readonly label: string;
}

export interface SetupInteraction {
  readonly select: (
    message: string,
    choices: ReadonlyArray<SetupChoice>,
  ) => Effect.Effect<string, SetupIncomplete>;
  readonly auth: AuthInteraction;
}

export interface SetupOptions {
  readonly minimal: boolean;
  readonly interactive: boolean;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinking?: string;
}

export interface SetupApi {
  readonly initialize: (
    target: ProfileTarget,
    registryPath: string,
    repositoryRoot: string,
    options: SetupOptions,
    interaction: SetupInteraction,
  ) => Effect.Effect<SetupResult, SetupError>;
}

export class Setup extends Context.Service<Setup, SetupApi>()("ziggy/Setup") {}

const incomplete = (profilePath: string, message: string): SetupIncomplete =>
  new SetupIncomplete({
    profilePath,
    message: `${message}; resume with: ziggy init ${JSON.stringify(profilePath)} --non-interactive --provider <id> --model <id> [--thinking <level>]`,
  });

const choose = (
  target: ProfileTarget,
  interaction: SetupInteraction,
  message: string,
  choices: ReadonlyArray<SetupChoice>,
) =>
  choices.length === 0
    ? Effect.fail(incomplete(target.path, message))
    : interaction.select(message, choices);

const configuredProviderChoices = (
  providers: ReadonlyArray<ProviderAuthStatus>,
): ReadonlyArray<SetupChoice> =>
  [...providers]
    .sort(
      (left, right) =>
        Number(right.configured !== undefined) - Number(left.configured !== undefined) ||
        left.id.localeCompare(right.id),
    )
    .map((provider) => ({
      id: provider.id,
      label: `${provider.name}${provider.configured === undefined ? "" : " (authenticated)"}`,
    }));

const modelChoices = (models: ReadonlyArray<KnownModel>): ReadonlyArray<SetupChoice> =>
  models.map((model) => ({ id: model.modelId, label: `${model.name} (${model.modelId})` }));

export const makeSetup = (
  profiles: ProfilesApi,
  auth: AuthApi,
  models: ModelsApi,
  doctor: DoctorApi,
): SetupApi => ({
  initialize: (target, registryPath, repositoryRoot, options, interaction) =>
    Effect.gen(function* () {
      const initialized = yield* profiles.initProfile(target, {
        createStarterDirectories: !options.minimal,
      });
      yield* profiles.registerProfile(registryPath, target.path);

      if (options.minimal) {
        return {
          profilePath: target.path,
          soulCreated: initialized.created,
          createdDirectories: initialized.createdDirectories,
          minimal: true,
        };
      }

      const current = yield* models.status(target);
      const providers = yield* auth.status(target);
      let providerId = options.providerId ?? current.providerId;
      if (providerId === undefined) {
        if (!options.interactive) {
          return yield* incomplete(target.path, "provider selection is missing");
        }
        providerId = yield* choose(
          target,
          interaction,
          "Select a provider",
          configuredProviderChoices(providers),
        );
      }

      const provider = providers.find((candidate) => candidate.id === providerId);
      if (provider === undefined) {
        return yield* incomplete(target.path, `unknown provider ${providerId}`);
      }
      if (provider.configured === undefined) {
        if (!options.interactive) {
          return yield* incomplete(target.path, `provider ${providerId} is not authenticated`);
        }
        yield* auth.login(target, providerId, undefined, interaction.auth);
      }

      let modelId =
        options.modelId ?? (current.providerId === providerId ? current.modelId : undefined);
      const knownModels = yield* models.list(target, providerId);
      if (modelId === undefined) {
        if (!options.interactive) {
          return yield* incomplete(target.path, "model selection is missing");
        }
        modelId = yield* choose(
          target,
          interaction,
          `Select a ${providerId} model`,
          modelChoices(knownModels),
        );
      }

      const selectedModel = knownModels.find((candidate) => candidate.modelId === modelId);
      if (selectedModel === undefined) {
        return yield* incomplete(target.path, `unknown model ${providerId}/${modelId}`);
      }

      let thinking = options.thinking;
      const changesModel =
        current.providerId !== providerId ||
        current.modelId !== modelId ||
        options.modelId !== undefined ||
        options.providerId !== undefined;
      if (
        thinking === undefined &&
        options.interactive &&
        changesModel &&
        selectedModel.thinkingLevels.length > 0
      ) {
        thinking = yield* choose(
          target,
          interaction,
          `Select a thinking level for ${providerId}/${modelId}`,
          selectedModel.thinkingLevels.map((level) => ({ id: level, label: level })),
        );
      }
      if (changesModel || thinking !== undefined) {
        yield* models.set(target, providerId, modelId, thinking);
      }

      const modelStatus = yield* models.status(target);
      const report = yield* doctor.check(target, repositoryRoot);
      return {
        profilePath: target.path,
        soulCreated: initialized.created,
        createdDirectories: initialized.createdDirectories,
        minimal: false,
        modelStatus,
        doctor: report,
      };
    }),
});

export const SetupLive = Layer.effect(
  Setup,
  Effect.gen(function* () {
    return makeSetup(yield* Profiles, yield* Auth, yield* Models, yield* Doctor);
  }),
);
