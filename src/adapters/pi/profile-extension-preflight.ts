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
import type { AutomationTuiDispatch } from "./automation-tui";
import {
  createProfileCoreInlineExtensions,
  type ProfileCoreInlineExtensionFactory,
  type ProfileCoreInlineExtensionOptions,
} from "./profile-core-inline-extensions";
import type { ProfileExtensionSelectionRunner } from "./profile-extension-selection";
import {
  collectPiResourceDiagnostics,
  piResourceDiagnosticFailure,
} from "./profile-extension-diagnostics";
import { profileResourceLoaderOptions } from "./profile-resource-loader";
import { loadProfileSystemPrompt } from "./profile-prompt";
import { composePiResources } from "./resources";

const preflightSelection: ProfileExtensionSelectionRunner = {
  list: () => Promise.resolve({ available: [], selected: [] }),
  setSelected: (ids) => Promise.resolve({ changed: false, selected: [...ids].sort() }),
};

const preflightAutomationDispatch: AutomationTuiDispatch = () =>
  Promise.resolve({
    kind: "failure",
    category: "unavailable",
    message: "automation dispatch is unavailable during Pi preflight",
  });

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
    extensionSelection: preflightSelection,
    automationDispatch: preflightAutomationDispatch,
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
            Effect.flatMap((services) => {
              const diagnostics = collectPiResourceDiagnostics(services);
              const diagnosticFailure = piResourceDiagnosticFailure(
                profilePath,
                services,
                diagnostics,
              );
              if (diagnosticFailure !== undefined) return Effect.fail(diagnosticFailure);
              const result: ProfileExtensionPreflightResult = {
                extensionPathCount: resources.extensionPaths.length,
                skillPathCount: resources.skillPaths.length,
                extensionFactoryCount:
                  inlineExtensions.length + resources.extensionFactories.length,
              };
              return Effect.succeed(result);
            }),
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
