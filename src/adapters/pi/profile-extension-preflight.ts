import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { discoverProfileAgents } from "../fs/profile-agents";
import { memoryFilePaths } from "../../domain/memory";
import {
  ProfileExtensionPreflight,
  ProfileExtensionPreflightFailed,
  type ProfileExtensionPreflightApi,
  type ProfileExtensionPreflightResult,
} from "../../domain/profile-extension";
import {
  createProfileCoreInlineExtensions,
  type ProfileCoreInlineExtensionFactory,
  type ProfileCoreInlineExtensionOptions,
} from "./profile-core-inline-extensions";
import {
  collectPiResourceDiagnostics,
  partitionPiResourceDiagnostics,
  piResourceDiagnosticFailure,
  type SkippedPiPackage,
} from "./profile-extension-diagnostics";
import { profileResourceLoaderOptions } from "./profile-resource-loader";
import { loadProfileSystemPrompt } from "./profile-prompt";
import { composePiResources, discoverPiResources } from "./resources";

const preflightCoreOptions = (
  profilePath: string,
  agents: ProfileCoreInlineExtensionOptions["agents"],
): ProfileCoreInlineExtensionOptions => {
  const memory = memoryFilePaths(profilePath, { kind: "local" });

  if (!memory.ok) throw memory.error;

  return {
    profilePath,
    agents,
    memoryDocuments: memory.documents,
    ephemeralPromptContext: () => undefined,
  };
};

const preflightFailure = (
  profilePath: string,
  message: string,
  source: string,
  cause: unknown,
): ProfileExtensionPreflightFailed =>
  new ProfileExtensionPreflightFailed({
    profilePath,
    stage: "services",
    message,
    diagnostics: [{ source, message }],
    cause,
  });

export const makeProfileExtensionPreflight = (
  createServices: typeof createAgentSessionServices = createAgentSessionServices,
  createCoreInlineExtensions: ProfileCoreInlineExtensionFactory = createProfileCoreInlineExtensions,
): ProfileExtensionPreflightApi => ({
  preflight: (profilePath, _repositoryRoot, selected) =>
    Effect.gen(function* () {
      const resources = yield* composePiResources(profilePath, selected);

      const agents = yield* discoverProfileAgents(profilePath).pipe(
        Effect.mapError((cause) =>
          preflightFailure(
            profilePath,
            "could not load Profile agent guidance for Pi preflight",
            profilePath,
            cause,
          ),
        ),
      );

      const systemPrompt = yield* loadProfileSystemPrompt(
        profilePath,
        join(profilePath, "SOUL.md"),
      ).pipe(
        Effect.mapError((cause) =>
          preflightFailure(
            profilePath,
            "could not load the Profile system prompt for Pi preflight",
            join(profilePath, "SOUL.md"),
            cause,
          ),
        ),
      );

      const inlineExtensions: ReadonlyArray<InlineExtension> = yield* Effect.try({
        try: () => createCoreInlineExtensions(preflightCoreOptions(profilePath, agents)),
        catch: (cause) =>
          preflightFailure(
            profilePath,
            "could not construct Ziggy core inline extensions for Pi preflight",
            "core-inline-extensions",
            cause,
          ),
      });

      const temporaryAgentDir = yield* Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "ziggy-profile-preflight-")),
        catch: (cause) =>
          preflightFailure(
            profilePath,
            "could not create disposable Pi preflight storage",
            "services",
            cause,
          ),
      });

      return yield* Effect.acquireUseRelease(
        Effect.succeed(temporaryAgentDir),
        (agentDir) =>
          Effect.tryPromise({
            try: () =>
              createServices({
                cwd: profilePath,
                agentDir,
                resourceLoaderOptions: profileResourceLoaderOptions(
                  systemPrompt,
                  resources,
                  inlineExtensions,
                ),
              }),
            catch: (cause) =>
              preflightFailure(
                profilePath,
                "could not construct Pi resource services for preflight",
                "services",
                cause,
              ),
          }).pipe(
            Effect.flatMap((services) =>
              Effect.gen(function* () {
                const diagnostics = collectPiResourceDiagnostics(services);

                const partition = partitionPiResourceDiagnostics(resources, diagnostics);

                const diagnosticFailure = piResourceDiagnosticFailure(
                  profilePath,
                  services,
                  partition.fatal,
                );

                if (diagnosticFailure !== undefined) return yield* diagnosticFailure;

                if (partition.skipped.length > 0) {
                  const healthy = yield* Effect.tryPromise({
                    try: () =>
                      createServices({
                        cwd: profilePath,
                        agentDir,
                        resourceLoaderOptions: profileResourceLoaderOptions(
                          systemPrompt,
                          partition.resources,
                          inlineExtensions,
                        ),
                      }),
                    catch: (cause) =>
                      preflightFailure(
                        profilePath,
                        "could not construct healthy Pi services",
                        "services",
                        cause,
                      ),
                  });

                  const remaining = piResourceDiagnosticFailure(profilePath, healthy);

                  if (remaining !== undefined) return yield* remaining;
                }

                const result: ProfileExtensionPreflightResult = {
                  extensionPathCount: partition.resources.extensionPaths.length,
                  skillPathCount: partition.resources.skillPaths.length,
                  extensionFactoryCount:
                    inlineExtensions.length + resources.extensionFactories.length,
                };

                return result;
              }),
            ),
          ),
        (agentDir) =>
          Effect.tryPromise({
            try: () => rm(agentDir, { recursive: true, force: true }),
            catch: (cause) =>
              preflightFailure(
                profilePath,
                "could not clean up disposable Pi preflight storage",
                agentDir,
                cause,
              ),
          }),
      );
    }),
});

export const ProfileExtensionPreflightLive = Layer.succeed(
  ProfileExtensionPreflight,
  makeProfileExtensionPreflight(),
);

export {
  createProfileCoreInlineExtensions,
  type ProfileCoreInlineExtensionFactory,
  type ProfileCoreInlineExtensionOptions,
} from "./profile-core-inline-extensions";

/** Read-only diagnostic projection for doctor, agent tools and the UI gateway. */
export const inspectPiPackageHealth = (
  profilePath: string,
  repositoryRoot: string,
): Effect.Effect<ReadonlyArray<SkippedPiPackage>, ProfileExtensionPreflightFailed> =>
  Effect.gen(function* () {
    const resources = yield* discoverPiResources(profilePath, repositoryRoot);
    const agents = yield* discoverProfileAgents(profilePath);
    const systemPrompt = yield* loadProfileSystemPrompt(profilePath, join(profilePath, "SOUL.md"));

    const inlineExtensions = createProfileCoreInlineExtensions(
      preflightCoreOptions(profilePath, agents),
    );

    const agentDir = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "ziggy-package-health-")),
      catch: (cause) =>
        preflightFailure(profilePath, "could not create package health storage", "services", cause),
    });

    return yield* Effect.acquireUseRelease(
      Effect.succeed(agentDir),
      (directory) =>
        Effect.tryPromise({
          try: () =>
            createAgentSessionServices({
              cwd: profilePath,
              agentDir: directory,
              resourceLoaderOptions: profileResourceLoaderOptions(
                systemPrompt,
                resources,
                inlineExtensions,
              ),
            }),
          catch: (cause) =>
            preflightFailure(profilePath, "could not inspect Pi packages", "services", cause),
        }).pipe(
          Effect.flatMap((services) => {
            const partition = partitionPiResourceDiagnostics(
              resources,
              collectPiResourceDiagnostics(services),
            );

            const fatal = piResourceDiagnosticFailure(profilePath, services, partition.fatal);

            return fatal === undefined ? Effect.succeed(partition.skipped) : Effect.fail(fatal);
          }),
        ),
      (directory) =>
        Effect.tryPromise({
          try: () => rm(directory, { recursive: true, force: true }),
          catch: (cause) =>
            preflightFailure(
              profilePath,
              "could not clean up package health storage",
              "services",
              cause,
            ),
        }),
    );
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ProfileExtensionPreflightFailed
        ? cause
        : preflightFailure(profilePath, "could not inspect Pi packages", "resources", cause),
    ),
  );
