import { dirname, join } from "node:path";
import {
  SessionManager,
  runPrintMode,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { Effect, Result } from "effect";
import { discoverProfileAgents } from "../adapters/fs/profile-agents";
import { piPromise, providerError } from "../adapters/pi/provider-failure";
import { promptForAssistantText } from "../adapters/pi/prompt-turn";
import { findRecentSessionFile, readSessionHeaderOnly } from "../adapters/pi/session-discovery";
import { sessionReference } from "../adapters/pi/session-lineage";
import { ensurePiSessionName } from "../adapters/pi/session-name";
import { selectSpecialist, specialistRuntime, useSpecialistChild } from "../adapters/pi/specialist";
import {
  SpecialistAgentNotFound,
  type ProfileAgentRunContext,
  type ProfileAgentRunResult,
  type ProfileSpecialistError,
  type ZiggyAgentError,
} from "../domain/agent";
import type { ChatContext } from "../domain/memory";
import { prepareProfileAgentPrompt, ProfileAgentMentionInvalid } from "../domain/profile";
import { ProviderConfigError, type ProfileTarget } from "../profile";
import { makeChatHandle } from "./handle";
import { makeSessionLeaseSet, takeSessionLease, type SessionLeaseSet } from "./lease";
import {
  createProfileRuntime,
  disposeRuntime,
  requireSoul,
  type ProfileRuntimeOptions,
} from "./runtime";
import type { ChatHandle, OpenSession, RunOnceOptions, ZiggyAgentApi } from "./types";

/** What composition plugs into every session this agent opens. */
export type SessionDependencies = Pick<
  ProfileRuntimeOptions,
  "extensions" | "tools" | "runtimeFactory"
>;

export const localMainSessionDirectory = (profilePath: string): string =>
  join(profilePath, "sessions", "local", "main");

export const localSpecialistSessionDirectory = (profilePath: string, agentId: string): string =>
  join(profilePath, "sessions", "local", "agents", agentId);

const disposeQuietly = (profilePath: string, runtime: AgentSessionRuntime) =>
  disposeRuntime(profilePath, runtime).pipe(
    Effect.catch((failure) => Effect.logWarning("Pi runtime cleanup failed", { failure })),
  );

const runtimeOptions = (
  deps: SessionDependencies,
  options: ProfileRuntimeOptions = {},
): ProfileRuntimeOptions => ({ ...options, ...deps });

/** Pi builds every replacement session through the factory; lease it there or refuse. */
const leaseEachSession = (leases: SessionLeaseSet) => (manager: SessionManager) => {
  const held = leases.hold(manager.getSessionId());

  if (Result.isFailure(held)) throw held.failure;
};

/** Pick the transcript, lease it, then open it — so a held transcript is refused before Pi sees it. */
const openTranscript = (
  profilePath: string,
  directory: string,
  session: "new" | "continue",
  leases: SessionLeaseSet,
  file?: string,
): Effect.Effect<SessionManager, ZiggyAgentError> =>
  Effect.gen(function* () {
    // An uninitialized Profile is refused before any lease or session directory is created.
    yield* requireSoul(profilePath);

    const existing =
      file ??
      (session === "continue"
        ? yield* findRecentSessionFile(profilePath, directory).pipe(
            Effect.mapError((cause) => providerError(profilePath, "open session", cause)),
          )
        : undefined);

    if (existing === undefined) {
      const manager = SessionManager.create(profilePath, directory);
      yield* Effect.fromResult(leases.hold(manager.getSessionId()));

      return manager;
    }

    const header = yield* readSessionHeaderOnly(existing).pipe(
      Effect.mapError((cause) => providerError(profilePath, "open session", cause)),
    );

    yield* Effect.fromResult(leases.hold(header.id));

    const manager = yield* Effect.try({
      try: () => SessionManager.open(existing, directory, profilePath),
      catch: (cause) => providerError(profilePath, "open session", cause),
    });

    return manager.getSessionId() === header.id
      ? manager
      : yield* providerError(
          profilePath,
          "open session",
          new Error("session header changed while opening"),
        );
  });

const requireModel = (profilePath: string, runtime: AgentSessionRuntime) =>
  runtime.modelFallbackMessage === undefined
    ? Effect.void
    : disposeQuietly(profilePath, runtime).pipe(
        Effect.andThen(
          new ProviderConfigError({
            profilePath,
            operation: "select model",
            message: `no configured model is available; place credentials in ${join(profilePath, "auth.json")} and model configuration in ${join(profilePath, "models.json")}`,
            cause: new Error(runtime.modelFallbackMessage),
          }),
        ),
      );

const requireAgent = (profilePath: string, agentId: string) =>
  discoverProfileAgents(profilePath).pipe(
    Effect.flatMap((agents) =>
      agents.some((agent) => agent.id === agentId)
        ? Effect.succeed(agents)
        : Effect.fail(
            new SpecialistAgentNotFound({
              profilePath,
              agentId,
              message: `unknown Profile agent: ${agentId}`,
            }),
          ),
    ),
  );

/** Resolve a Profile agent's model, thinking and tools against a throwaway Profile runtime. */
const selectAgent = (
  profilePath: string,
  agentId: string,
  prompt: string,
  manager: SessionManager,
  deps: SessionDependencies,
) =>
  Effect.gen(function* () {
    const agents = yield* requireAgent(profilePath, agentId);

    return yield* Effect.acquireUseRelease(
      createProfileRuntime(
        profilePath,
        manager,
        { kind: "local" },
        runtimeOptions(deps, { agents }),
      ),
      (runtime) =>
        selectSpecialist({ profilePath, agents }, { agent: agentId, prompt }, runtime).pipe(
          Effect.map((selected) => ({
            selected,
            environment: { services: runtime.services, resources: runtime.resources },
          })),
        ),
      (runtime) => disposeQuietly(profilePath, runtime),
    );
  });

/** Open a live session on the Profile, or on one of its agents. */
export const openSession = (
  request: OpenSession,
  deps: SessionDependencies = {},
): Effect.Effect<ChatHandle, ZiggyAgentError | ProfileSpecialistError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const profilePath = request.target.path;
      const leases = makeSessionLeaseSet(profilePath);
      const beforeServices = leaseEachSession(leases);
      const agentId = request.agent;

      const build = Effect.gen(function* () {
        if (agentId === undefined) {
          const manager = yield* openTranscript(
            profilePath,
            request.directory,
            request.session,
            leases,
          );

          const options: ProfileRuntimeOptions =
            request.model === undefined
              ? { beforeServices }
              : { beforeServices, model: request.model };

          const runtime = yield* createProfileRuntime(
            profilePath,
            manager,
            request.context,
            runtimeOptions(deps, options),
          );

          yield* requireModel(profilePath, runtime);

          return runtime;
        }

        const { selected, environment } = yield* selectAgent(
          profilePath,
          agentId,
          agentId,
          SessionManager.inMemory(profilePath),
          deps,
        );

        const manager = yield* openTranscript(
          profilePath,
          request.directory,
          request.session,
          leases,
        );

        return yield* specialistRuntime(
          profilePath,
          environment,
          selected.agent,
          selected.model,
          selected.thinking,
          selected.tools,
          manager,
          beforeServices,
        );
      });

      const releaseLeases = Effect.sync(() => leases.keepOnly(undefined));
      const runtime = yield* restore(build).pipe(Effect.onError(() => releaseLeases));
      const name = request.name ?? (agentId === undefined ? undefined : `Agent · ${agentId}`);

      return yield* makeChatHandle({ profilePath, runtime, leases, name }).pipe(
        Effect.onError(() =>
          disposeQuietly(profilePath, runtime).pipe(Effect.ensuring(releaseLeases)),
        ),
      );
    }),
  );

/** One print-mode turn: `ziggy run`. */
export const runOnce = (
  target: ProfileTarget,
  prompt: string,
  continueSession: boolean,
  context: ChatContext,
  options: RunOnceOptions | undefined,
  deps: SessionDependencies = {},
): Effect.Effect<number, ZiggyAgentError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const profilePath = target.path;

      const leases = yield* Effect.acquireRelease(
        Effect.sync(() => makeSessionLeaseSet(profilePath)),
        (held) => Effect.sync(() => held.keepOnly(undefined)),
      );

      const directory =
        options?.sessionPath !== undefined
          ? dirname(options.sessionPath)
          : continueSession
            ? localMainSessionDirectory(profilePath)
            : join(profilePath, "sessions");

      const manager = yield* openTranscript(
        profilePath,
        directory,
        continueSession ? "continue" : "new",
        leases,
        options?.sessionPath,
      );

      const runtime = yield* Effect.acquireRelease(
        createProfileRuntime(
          profilePath,
          manager,
          context,
          runtimeOptions(deps, { beforeServices: leaseEachSession(leases) }),
        ),
        (created) => disposeQuietly(profilePath, created),
      );

      const prepared = prepareProfileAgentPrompt(prompt, runtime.agents);

      if (!prepared.ok)
        return yield* new ProfileAgentMentionInvalid({ profilePath, message: prepared.message });

      yield* requireModel(profilePath, runtime);

      const exitCode = yield* piPromise(profilePath, "call provider", () =>
        runPrintMode(runtime, { mode: options?.mode ?? "text", initialMessage: prepared.text }),
      );

      return exitCode === 0
        ? exitCode
        : yield* providerError(
            profilePath,
            "call provider",
            new Error(`provider returned exit code ${exitCode}`),
          );
    }),
  );

/** Run one task on a Profile agent in a fresh saved transcript. */
export const runSpecialist = (
  target: ProfileTarget,
  agentId: string,
  task: string,
  context: ProfileAgentRunContext,
  deps: SessionDependencies = {},
): Effect.Effect<ProfileAgentRunResult, ProfileSpecialistError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const profilePath = target.path;
      yield* requireAgent(profilePath, agentId);
      const root = SessionManager.create(profilePath, context.sessionDirectory);
      ensurePiSessionName(root, `Agent · ${agentId}`, task);
      const reference = sessionReference(root);

      if (reference === undefined) {
        return yield* new ProviderConfigError({
          profilePath,
          operation: "create Profile agent session",
          message: "Pi did not create a persistent Profile agent session",
          cause: undefined,
        });
      }

      yield* Effect.acquireRelease(
        Effect.fromResult(takeSessionLease(profilePath, reference.id)),
        (lease) => Effect.sync(lease.release),
      );

      const { selected, environment } = yield* selectAgent(profilePath, agentId, task, root, deps);

      const result = yield* useSpecialistChild(
        profilePath,
        specialistRuntime(
          profilePath,
          environment,
          selected.agent,
          selected.model,
          selected.thinking,
          selected.tools,
          root,
        ).pipe(
          Effect.map((runtime) => ({
            session: runtime.session,
            reference,
            dispose: () => runtime.dispose(),
          })),
        ),
        selected,
        (runtime) => promptForAssistantText(profilePath, runtime.session, task),
      );

      return { answer: result.answer, session: result.session };
    }),
  );

/** The Pi-backed `ZiggyAgent`. */
export const makeZiggyAgent = (deps: SessionDependencies): ZiggyAgentApi => ({
  open: (request) => openSession(request, deps),
  runOnce: (target, prompt, continueSession, context, options) =>
    runOnce(target, prompt, continueSession, context, options, deps),
  runSpecialist: (target, agentId, task, context) =>
    runSpecialist(target, agentId, task, context, deps),
});
