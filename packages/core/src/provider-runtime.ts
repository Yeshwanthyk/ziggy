import { randomUUID } from "node:crypto";
import {
  clampThinkingLevel,
  type AuthInteraction,
  type AuthType,
  type CredentialStore,
  type Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Effect, Schema, Scope } from "effect";
import { createFilesystemSessionRuntime } from "./agent/filesystem.ts";
import type { SessionRuntime } from "./agent/runtime.ts";
import {
  createProfileCredentialStore,
  type CredentialStoreError,
} from "./credentials/filesystem-store.ts";
import { loadInstalledExtensionSkills } from "./extensions/skill-loader.ts";
import { ZIGGY_VERSION } from "./product-version.ts";
import type { FilesystemWorld } from "./world/filesystem.ts";
import { readProfileSoul } from "./provider-node-adapter.ts";

export interface ProviderRuntimeConfig {
  readonly defaultProvider: string;
  readonly defaultModel: string;
  readonly thinkingLevel: "low" | "medium" | "high";
  readonly cacheRetention: "none" | "short" | "long";
}

export interface ProviderAuthStatus {
  readonly providerId: string;
  readonly configured: boolean;
  readonly type?: AuthType;
  readonly source?: string;
}

export class ProviderRuntimeError extends Schema.TaggedErrorClass<ProviderRuntimeError>()(
  "ProviderRuntimeError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class UnknownConfiguredProviderError extends Schema.TaggedErrorClass<UnknownConfiguredProviderError>()(
  "UnknownConfiguredProviderError",
  { providerId: Schema.String },
) {
  override get message(): string {
    return `Unknown configured Provider: ${this.providerId}`;
  }
}

export class UnknownConfiguredModelError extends Schema.TaggedErrorClass<UnknownConfiguredModelError>()(
  "UnknownConfiguredModelError",
  { providerId: Schema.String, modelId: Schema.String },
) {
  override get message(): string {
    return `Unknown configured model: ${this.providerId}/${this.modelId}`;
  }
}

export class UnknownProviderError extends Schema.TaggedErrorClass<UnknownProviderError>()(
  "UnknownProviderError",
  { providerId: Schema.String },
) {
  override get message(): string {
    return `Unknown Provider: ${this.providerId}`;
  }
}

export interface DaemonAuthService {
  login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Effect.Effect<ProviderAuthStatus, ProviderRuntimeError | UnknownProviderError>;
  status(
    providerId?: string,
  ): Effect.Effect<ReadonlyArray<ProviderAuthStatus>, ProviderRuntimeError | UnknownProviderError>;
}

export interface ProviderRuntimeComposition {
  readonly auth: DaemonAuthService;
  createRuntime(
    sessionId: string,
    world: FilesystemWorld,
  ): Effect.Effect<SessionRuntime, ConfiguredModelError | ProviderRuntimeError, Scope.Scope>;
}

export interface CreateProviderRuntimeCompositionOptions {
  readonly profilePath: string;
  readonly config: ProviderRuntimeConfig;
  readonly loadConfig?: () => Effect.Effect<ProviderRuntimeConfig, ProviderRuntimeError>;
  readonly credentials?: CredentialStore;
  readonly models?: Models;
}

type ConfiguredModelError = UnknownConfiguredModelError | UnknownConfiguredProviderError;

export function createProviderRuntimeComposition(
  options: CreateProviderRuntimeCompositionOptions,
): Effect.Effect<
  ProviderRuntimeComposition,
  ConfiguredModelError | CredentialStoreError | ProviderRuntimeError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const credentials =
      options.credentials ?? (yield* createProfileCredentialStore(options.profilePath));
    const models = options.models ?? builtinModels({ credentials });
    yield* resolveConfiguredModel(models, options.config);

    const auth: DaemonAuthService = {
      login(providerId, type, interaction) {
        return Effect.tryPromise({
          try: () => models.login(providerId, type, interaction),
          catch: providerFailure("Provider login failed"),
        }).pipe(Effect.andThen(statusFor(models, credentials, providerId)));
      },
      status(providerId) {
        if (providerId !== undefined) {
          return statusFor(models, credentials, providerId).pipe(Effect.map((status) => [status]));
        }
        return Effect.forEach(
          models
            .getProviders()
            .map((provider) => provider.id)
            .sort(),
          (id) => statusFor(models, credentials, id),
        );
      },
    };

    const composition: ProviderRuntimeComposition = {
      auth,
      createRuntime(sessionId, world) {
        return Effect.gen(function* () {
          const config =
            options.loadConfig === undefined ? options.config : yield* options.loadConfig();
          const { model, reasoning } = yield* resolveConfiguredModel(models, config);
          const snapshot = yield* world
            .readSessionSnapshot(sessionId)
            .pipe(Effect.mapError(providerFailure("Failed to read Session snapshot")));
          const baseSystemPrompt =
            snapshot === undefined ? yield* readProfileInstructions(options.profilePath) : "";
          return yield* createFilesystemSessionRuntime({
            sessionId,
            world,
            baseSystemPrompt,
            model,
            streamSimple: (selectedModel, context, streamOptions) =>
              models.streamSimple(selectedModel, context, streamOptions),
            cacheRetention: config.cacheRetention,
            ...(reasoning === undefined ? {} : { reasoning }),
            nextTurnId: randomUUID,
            nextStepId: randomUUID,
            tools: [],
          }).pipe(Effect.mapError(providerFailure("Failed to create Session runtime")));
        });
      },
    };
    return composition;
  });
}

function resolveConfiguredModel(models: Models, config: ProviderRuntimeConfig) {
  const model = models.getModel(config.defaultProvider, config.defaultModel);
  if (model === undefined) {
    if (models.getProvider(config.defaultProvider) === undefined) {
      return Effect.fail(
        new UnknownConfiguredProviderError({ providerId: config.defaultProvider }),
      );
    }
    return Effect.fail(
      new UnknownConfiguredModelError({
        providerId: config.defaultProvider,
        modelId: config.defaultModel,
      }),
    );
  }
  const clampedReasoning = clampThinkingLevel(model, config.thinkingLevel);
  return Effect.succeed({
    model,
    reasoning: clampedReasoning === "off" ? undefined : clampedReasoning,
  });
}

function statusFor(
  models: Models,
  credentials: CredentialStore,
  providerId: string,
): Effect.Effect<ProviderAuthStatus, ProviderRuntimeError | UnknownProviderError> {
  if (models.getProvider(providerId) === undefined) {
    return Effect.fail(new UnknownProviderError({ providerId }));
  }
  return Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => credentials.read(providerId),
      catch: providerFailure("Failed to read Provider credential"),
    });
    const checked = yield* Effect.tryPromise({
      try: () => models.checkAuth(providerId),
      catch: providerFailure("Failed to check Provider authentication"),
    });
    if (checked === undefined) return { providerId, configured: false };
    return {
      providerId,
      configured: true,
      type: checked.type,
      source: stored === undefined ? "environment" : "stored",
    };
  });
}

function readProfileInstructions(profilePath: string): Effect.Effect<string, ProviderRuntimeError> {
  return Effect.gen(function* () {
    const soul = yield* Effect.tryPromise({
      try: () => readProfileSoul(profilePath),
      catch: providerFailure("Failed to read Profile SOUL.md"),
    });
    const skills = yield* loadInstalledExtensionSkills(profilePath, ZIGGY_VERSION).pipe(
      Effect.mapError(providerFailure("Failed to load installed Extension Skills")),
    );
    const skillPrompt = skills
      .map((skill) => `<skill id="${skill.id}">\n${skill.content}\n</skill>`)
      .join("\n\n");
    return skillPrompt.length === 0 ? soul : `${soul}\n\n<skills>\n${skillPrompt}\n</skills>`;
  });
}

function providerFailure(message: string): (cause: unknown) => ProviderRuntimeError {
  return (cause) => new ProviderRuntimeError({ message, cause });
}
