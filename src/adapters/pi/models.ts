import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type Api,
  type CredentialStore,
  getSupportedThinkingLevels,
  type Model,
  type ModelsStore,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  readStoredCredential,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  ModelOperationFailed,
  ModelProviderUnknown,
  ModelSettingsWriteFailed,
  ModelThinkingUnsupported,
  ModelUnknown,
  ProfileNotInitialized,
} from "../../domain/agent";

export interface ModelStatus {
  readonly providerId: string | undefined;
  readonly modelId: string | undefined;
  readonly thinking: string;
  readonly authConfigured: boolean;
}

export interface KnownModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly thinkingLevels: ReadonlyArray<string>;
}

export interface ModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly thinking: string | undefined;
}

interface PiModelsSession {
  readonly status: () => Promise<ModelStatus>;
  readonly hasProvider: (providerId: string) => boolean;
  readonly list: (providerId?: string) => ReadonlyArray<KnownModel>;
  readonly select: (
    providerId: string,
    modelId: string,
    thinking?: string,
  ) => ModelSelection | undefined;
  readonly flush: () => Promise<void>;
  readonly drainSettingsError: () => unknown | undefined;
}

export type PiModelsSessionFactory = (profilePath: string) => Promise<PiModelsSession>;

const toKnownModel = (model: Model<Api>): KnownModel => ({
  providerId: model.provider,
  modelId: model.id,
  name: model.name,
  thinkingLevels: getSupportedThinkingLevels(model),
});

const readOnlyCredentials = (profilePath: string): CredentialStore => ({
  read: (providerId) =>
    Promise.resolve(readStoredCredential(providerId, join(profilePath, "auth.json"))),
  list: () => Promise.resolve([]),
  modify: (providerId, update) =>
    update(readStoredCredential(providerId, join(profilePath, "auth.json"))),
  delete: () => Promise.resolve(),
});

const readOnlyModelsStore: ModelsStore = {
  read: () => Promise.resolve(undefined),
  write: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

const createPiModelsSessionWith = async (
  profilePath: string,
  readOnly: boolean,
): Promise<PiModelsSession> => {
  const runtime = await ModelRuntime.create({
    ...(readOnly
      ? { credentials: readOnlyCredentials(profilePath), modelsStore: readOnlyModelsStore }
      : {
          authPath: join(profilePath, "auth.json"),
          modelsStorePath: join(profilePath, "models-store.json"),
        }),
    modelsPath: join(profilePath, "models.json"),
  });
  const settings = SettingsManager.create(profilePath, profilePath);

  return {
    status: async () => {
      const providerId = settings.getDefaultProvider();
      const modelId = settings.getDefaultModel();
      const model =
        providerId === undefined || modelId === undefined
          ? undefined
          : runtime.getModel(providerId, modelId);
      const authConfigured =
        model === undefined ? false : (await runtime.checkAuth(model.provider)) !== undefined;
      return {
        providerId: model?.provider,
        modelId: model?.id,
        thinking: settings.getDefaultThinkingLevel() ?? "medium",
        authConfigured,
      };
    },
    hasProvider: (providerId) => runtime.getProvider(providerId) !== undefined,
    list: (providerId) => runtime.getModels(providerId).map(toKnownModel),
    select: (providerId, modelId, thinking) => {
      const model = runtime.getModel(providerId, modelId);
      if (model === undefined) return undefined;
      let selectedThinking;
      if (thinking !== undefined) {
        const supported = getSupportedThinkingLevels(model);
        selectedThinking = supported.find((candidate) => candidate === thinking);
        if (selectedThinking === undefined) {
          return { providerId, modelId, thinking: undefined };
        }
      }
      settings.setDefaultModelAndProvider(providerId, modelId);
      if (selectedThinking !== undefined) settings.setDefaultThinkingLevel(selectedThinking);
      return { providerId, modelId, thinking: selectedThinking };
    },
    flush: () => settings.flush(),
    drainSettingsError: () => settings.drainErrors()[0]?.error,
  };
};

const createPiModelsSession: PiModelsSessionFactory = (profilePath) =>
  createPiModelsSessionWith(profilePath, false);
const createPiReadOnlyModelsSession: PiModelsSessionFactory = (profilePath) =>
  createPiModelsSessionWith(profilePath, true);

const causeCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const requireSoul = (
  profilePath: string,
): Effect.Effect<void, ProfileNotInitialized | ModelOperationFailed> =>
  Effect.tryPromise({
    try: () => stat(join(profilePath, "SOUL.md")),
    catch: (cause) =>
      causeCode(cause) === "ENOENT"
        ? new ProfileNotInitialized({
            profilePath,
            message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
          })
        : new ModelOperationFailed({
            profilePath,
            operation: "inspect Profile",
            message: `could not inspect Profile at ${profilePath}`,
            cause,
          }),
  }).pipe(
    Effect.flatMap((status) =>
      status.isFile()
        ? Effect.void
        : Effect.fail(
            new ProfileNotInitialized({
              profilePath,
              message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
            }),
          ),
    ),
  );

export const makePiModels = (createSession: PiModelsSessionFactory = createPiModelsSession) => {
  const open = (
    profilePath: string,
    operation: string,
  ): Effect.Effect<PiModelsSession, ProfileNotInitialized | ModelOperationFailed> =>
    requireSoul(profilePath).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => createSession(profilePath),
          catch: (cause) =>
            new ModelOperationFailed({
              profilePath,
              operation,
              message: `could not ${operation} for ${profilePath}`,
              cause,
            }),
        }),
      ),
      Effect.flatMap((session) => {
        const cause = session.drainSettingsError();
        return cause === undefined
          ? Effect.succeed(session)
          : Effect.fail(
              new ModelOperationFailed({
                profilePath,
                operation: "load model settings",
                message: `could not load model settings for ${profilePath}`,
                cause,
              }),
            );
      }),
    );

  const status = (
    profilePath: string,
  ): Effect.Effect<ModelStatus, ProfileNotInitialized | ModelOperationFailed> =>
    Effect.gen(function* () {
      const session = yield* open(profilePath, "load model status");
      return yield* Effect.tryPromise({
        try: () => session.status(),
        catch: (cause) =>
          new ModelOperationFailed({
            profilePath,
            operation: "resolve effective model",
            message: `could not resolve the effective model for ${profilePath}`,
            cause,
          }),
      });
    });

  const list = (
    profilePath: string,
    providerId?: string,
  ): Effect.Effect<
    ReadonlyArray<KnownModel>,
    ProfileNotInitialized | ModelOperationFailed | ModelProviderUnknown
  > =>
    Effect.gen(function* () {
      const session = yield* open(profilePath, "list models");
      if (providerId !== undefined && !session.hasProvider(providerId)) {
        return yield* new ModelProviderUnknown({
          profilePath,
          providerId,
          message: `unknown model provider ${providerId}`,
        });
      }
      return [...session.list(providerId)].sort(
        (left, right) =>
          left.providerId.localeCompare(right.providerId) ||
          left.modelId.localeCompare(right.modelId),
      );
    });

  const set = (
    profilePath: string,
    providerId: string,
    modelId: string,
    thinking?: string,
  ): Effect.Effect<
    ModelSelection,
    | ProfileNotInitialized
    | ModelOperationFailed
    | ModelProviderUnknown
    | ModelUnknown
    | ModelThinkingUnsupported
    | ModelSettingsWriteFailed
  > =>
    Effect.gen(function* () {
      const session = yield* open(profilePath, "select model");
      if (!session.hasProvider(providerId)) {
        return yield* new ModelProviderUnknown({
          profilePath,
          providerId,
          message: `unknown model provider ${providerId}`,
        });
      }
      const known = session.list(providerId).find((model) => model.modelId === modelId);
      if (known === undefined) {
        return yield* new ModelUnknown({
          profilePath,
          providerId,
          modelId,
          message: `unknown model ${providerId}/${modelId}`,
        });
      }
      if (thinking !== undefined && !known.thinkingLevels.includes(thinking)) {
        return yield* new ModelThinkingUnsupported({
          providerId,
          modelId,
          thinking,
          supported: [...known.thinkingLevels],
          message: `model ${providerId}/${modelId} does not support thinking level ${thinking}; supported: ${known.thinkingLevels.join(", ")}`,
        });
      }
      const selection = yield* Effect.try({
        try: () => session.select(providerId, modelId, thinking),
        catch: (cause) =>
          new ModelSettingsWriteFailed({
            profilePath,
            message: `could not update model settings for ${profilePath}`,
            cause,
          }),
      });
      if (selection === undefined) {
        return yield* new ModelUnknown({
          profilePath,
          providerId,
          modelId,
          message: `unknown model ${providerId}/${modelId}`,
        });
      }
      yield* Effect.tryPromise({
        try: () => session.flush(),
        catch: (cause) =>
          new ModelSettingsWriteFailed({
            profilePath,
            message: `could not save model settings for ${profilePath}`,
            cause,
          }),
      });
      const settingsCause = session.drainSettingsError();
      if (settingsCause !== undefined) {
        return yield* new ModelSettingsWriteFailed({
          profilePath,
          message: `could not save model settings for ${profilePath}`,
          cause: settingsCause,
        });
      }
      return selection;
    });

  return { status, list, set } as const;
};

const piModels = makePiModels();
const piReadOnlyModels = makePiModels(createPiReadOnlyModelsSession);
export const getModelStatus = piModels.status;
export const getModelStatusReadOnly = piReadOnlyModels.status;
export const listModels = piModels.list;
export const setModel = piModels.set;
