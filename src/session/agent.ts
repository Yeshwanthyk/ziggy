import { dirname, join } from "node:path";
import {
  SessionManager,
  runPrintMode,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { Effect, Result } from "effect";
import { piPromise, providerError } from "../adapters/pi/provider-failure";
import { SpecialistToolUnsupported, type ZiggyAgentError } from "../domain/agent";
import { ProviderConfigError, type ProfileTarget } from "../profile";
import { makeChatHandle } from "./handle";
import { findRecentTranscript, readTranscriptHeader } from "./transcript";
import { makeSessionLeaseSet, type SessionLeaseSet } from "./lease";
import {
  createProfileRuntime,
  disposeRuntime,
  requireSoul,
  type ProfileRuntimeOptions,
} from "./runtime";
import type { SessionPrepare } from "./tools";
import type { SessionPersona } from "./types";
import type { ChatContext, ChatHandle, OpenSessionRequest, RunOnceOptions } from "./types";

/** What composition plugs into every session this agent opens. */
export type SessionDependencies = Pick<
  ProfileRuntimeOptions,
  "tools" | "prompts" | "runtimeFactory"
> & { readonly prepare?: SessionPrepare };

export const localMainSessionDirectory = (profilePath: string): string =>
  join(profilePath, "sessions", "local", "main");

const disposeQuietly = (profilePath: string, runtime: AgentSessionRuntime) =>
  disposeRuntime(profilePath, runtime).pipe(
    Effect.catch((failure) => Effect.logWarning("Pi runtime cleanup failed", { failure })),
  );

const runtimeOptions = (
  { prepare: _prepare, ...deps }: SessionDependencies,
  options: ProfileRuntimeOptions = {},
): ProfileRuntimeOptions => ({ ...options, ...deps });

/** Pi builds every replacement session through the factory; lease it there or refuse. */
const leaseEachSession = (leases: SessionLeaseSet) => (manager: SessionManager) => {
  const held = leases.hold(manager.getSessionId());

  if (Result.isFailure(held)) throw held.failure;
};

/**
 * Pick the transcript, lease it, then open it — so a held transcript is refused before Pi sees it.
 * A new transcript with `parentSession` is a child that records its parent in its header.
 */
const openTranscript = (
  profilePath: string,
  directory: string,
  session: "new" | "continue",
  leases: SessionLeaseSet,
  file?: string,
  parentSession?: string,
): Effect.Effect<SessionManager, ZiggyAgentError> =>
  Effect.gen(function* () {
    // An uninitialized Profile is refused before any lease or session directory is created.
    yield* requireSoul(profilePath);

    const existing =
      file ??
      (session === "continue"
        ? yield* findRecentTranscript(profilePath, directory).pipe(
            Effect.mapError((cause) => providerError(profilePath, "open session", cause)),
          )
        : undefined);

    if (existing === undefined) {
      const manager =
        parentSession === undefined
          ? SessionManager.create(profilePath, directory)
          : SessionManager.create(profilePath, directory, { parentSession });

      yield* Effect.fromResult(leases.hold(manager.getSessionId()));

      return manager;
    }

    const header = yield* readTranscriptHeader(existing).pipe(
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

/** Pi drops a tool it cannot find; a Profile agent must not run with less than it declared. */
const requirePersonaTools = (
  profilePath: string,
  runtime: AgentSessionRuntime,
  persona: SessionPersona | undefined,
) => {
  const active = new Set(runtime.session.getActiveToolNames());
  const missing = persona?.tools.find((name) => !active.has(name));

  return persona === undefined || missing === undefined
    ? Effect.void
    : disposeQuietly(profilePath, runtime).pipe(
        Effect.andThen(
          new SpecialistToolUnsupported({
            profilePath,
            agentId: persona.id,
            toolName: missing,
            message: `tool is unavailable to Profile agent ${persona.id}: ${missing}`,
          }),
        ),
      );
};

/** Open a live session on the Profile, or as a Profile agent when `persona` is set. */
export const openSession = (
  request: OpenSessionRequest,
  deps: SessionDependencies = {},
): Effect.Effect<ChatHandle, ZiggyAgentError | SpecialistToolUnsupported> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const profilePath = request.target.path;
      const leases = makeSessionLeaseSet(profilePath);
      const { persona } = request;

      const build = Effect.gen(function* () {
        const manager = yield* openTranscript(
          profilePath,
          request.directory,
          request.session,
          leases,
          undefined,
          request.parentSession,
        );

        const options: ProfileRuntimeOptions = {
          beforeServices: leaseEachSession(leases),
          model: request.model,
          persona,
        };

        const runtime = yield* createProfileRuntime(
          profilePath,
          manager,
          request.context,
          runtimeOptions(deps, options),
        );

        yield* requireModel(profilePath, runtime);
        yield* requirePersonaTools(profilePath, runtime, persona);

        return runtime;
      });

      const releaseLeases = Effect.sync(() => leases.keepOnly(undefined));
      const runtime = yield* restore(build).pipe(Effect.onError(() => releaseLeases));
      const prepare = persona === undefined ? deps.prepare : undefined;

      return yield* makeChatHandle({
        profilePath,
        runtime,
        leases,
        name: request.name,
        prepare: prepare === undefined ? undefined : (text) => prepare(profilePath, text),
      }).pipe(
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

      const prepared = yield* deps.prepare?.(profilePath, prompt) ?? Effect.succeed(prompt);

      yield* requireModel(profilePath, runtime);

      const exitCode = yield* piPromise(profilePath, "call provider", () =>
        runPrintMode(runtime, { mode: options?.mode ?? "text", initialMessage: prepared }),
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
