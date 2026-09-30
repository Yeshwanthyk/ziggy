import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Effect, Option, Result, Semaphore } from "effect";
import {
  AUTOMATION_RESULT_CUSTOM_TYPE,
  automationResultContent,
  isAutomationReceipt,
} from "../adapters/pi/automation-result";
import { createChatEventProjector } from "../adapters/pi/chat-event-projector";
import { promptForAssistantText } from "../adapters/pi/prompt-turn";
import { piPromise, providerError } from "../adapters/pi/provider-failure";
import { readSessionHeaderOnly } from "../adapters/pi/session-discovery";
import { sessionReference } from "../adapters/pi/session-lineage";
import { ensurePiSessionName } from "../adapters/pi/session-name";
import { showProfileSession } from "../adapters/pi/sessions";
import {
  ChatNotStreaming,
  SessionBusy,
  SessionHeld,
  type SessionReference,
  type ZiggyAgentError,
} from "../domain/agent";
import {
  AutomationConversationDeliveryFailed,
  type AutomationConversationResult,
} from "../domain/automation";
import { prepareProfileAgentPrompt, ProfileAgentMentionInvalid } from "../domain/profile";
import { fileSystemCauseDetails } from "../platform/cause";
import { ProviderConfigError } from "../profile";
import type { SessionLeaseSet } from "./lease";
import { disposeRuntime, type ProfileRuntime } from "./runtime";
import type { ChatEvent, ChatHandle, ChatSessionModelState } from "./types";

/** The parts of Pi's live session the handle drives. */
export type HandleSession = Pick<
  AgentSession,
  | "isIdle"
  | "sessionManager"
  | "model"
  | "thinkingLevel"
  | "subscribe"
  | "bindExtensions"
  | "waitForIdle"
  | "navigateTree"
  | "reload"
  | "prompt"
  | "abort"
  | "steer"
  | "followUp"
  | "sendCustomMessage"
  | "setModel"
  | "setThinkingLevel"
>;

/** The parts of Pi's runtime the handle drives. A Profile runtime also carries agents and prompt context. */
export interface HandleRuntime
  extends
    Pick<
      AgentSessionRuntime,
      "switchSession" | "newSession" | "fork" | "setRebindSession" | "dispose"
    >,
    Partial<Pick<ProfileRuntime, "agents" | "ephemeralPromptContext" | "voiceHub">> {
  readonly session: HandleSession;
  readonly services: { readonly modelRuntime: Pick<ModelRuntime, "getModel"> };
}

export interface ChatHandleOptions {
  readonly profilePath: string;
  readonly runtime: HandleRuntime;
  /** Already holds the lease on the runtime's current transcript. */
  readonly leases: SessionLeaseSet;
  readonly name?: string | undefined;
}

const transcriptChanged: ChatEvent = { kind: "session-state", scope: "transcript" };

/** Pi rethrows a lease refusal from the runtime factory; keep it typed. */
const piStep = <A>(profilePath: string, operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause): ZiggyAgentError =>
      cause instanceof SessionHeld ? cause : providerError(profilePath, operation, cause),
  });

const shareAbort = (abort: () => Promise<void>): (() => Promise<void>) => {
  let inFlight: Promise<void> | undefined;

  return () => {
    inFlight ??= abort().finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  };
};

const currentReference = (
  profilePath: string,
  manager: SessionManager,
): Effect.Effect<SessionReference | undefined, ZiggyAgentError> =>
  Effect.suspend(() => {
    const reference = sessionReference(manager);

    if (reference === undefined) return Effect.succeed(undefined);

    return Effect.tryPromise({ try: () => stat(reference.file), catch: (cause) => cause }).pipe(
      Effect.flatMap((metadata) =>
        metadata.isFile()
          ? Effect.succeed(reference)
          : Effect.fail(
              providerError(
                profilePath,
                "inspect agent session transcript",
                new Error("Pi session transcript is not a file"),
              ),
            ),
      ),
      Effect.catch((cause) =>
        fileSystemCauseDetails(cause).code === "ENOENT"
          ? Effect.succeed(undefined)
          : Effect.fail(providerError(profilePath, "inspect agent session transcript", cause)),
      ),
    );
  });

/**
 * The one live chat handle. A turn holds the handle for its whole run; controls that change the
 * session refuse instead of waiting behind one. Whenever Pi moves to another transcript the handle
 * keeps only that transcript's lease and tells watchers with `session-state`.
 */
export const makeChatHandle = (
  options: ChatHandleOptions,
): Effect.Effect<ChatHandle, ZiggyAgentError> =>
  Effect.gen(function* () {
    const { profilePath, runtime, leases } = options;
    const turn = Semaphore.makeUnsafe(1);
    const listeners = new Set<(event: ChatEvent) => void>();
    const project = createChatEventProjector();
    const abort = shareAbort(() => runtime.session.abort());
    let unsubscribeSession: () => void = () => undefined;

    const publish = (event: ChatEvent) => {
      for (const listener of listeners) listener(event);
    };

    const forward = (event: AgentSessionEvent) => {
      for (const chatEvent of project(event)) publish(chatEvent);
    };

    const currentId = () => runtime.session.sessionManager.getSessionId();

    const busy = () =>
      new SessionBusy({
        profilePath,
        message: "session is busy; wait for the current turn to finish",
      });

    /** Run a session-changing control only when no turn holds the handle and Pi is idle. */
    const control = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | SessionBusy> =>
      turn
        .withPermitsIfAvailable(1)(
          Effect.suspend(
            (): Effect.Effect<A, E | SessionBusy> =>
              runtime.session.isIdle ? effect : Effect.fail(busy()),
          ),
        )
        .pipe(
          Effect.flatMap(
            Option.match({ onNone: () => Effect.fail(busy()), onSome: Effect.succeed }),
          ),
        );

    /** Pi replaced (or kept) the transcript: drop stale leases and tell watchers. */
    const replaced = async <R extends { readonly cancelled: boolean }>(
      run: () => Promise<R>,
    ): Promise<R> => {
      try {
        const result = await run();

        if (!result.cancelled) publish(transcriptChanged);

        return result;
      } finally {
        leases.keepOnly(currentId());
      }
    };

    /** Lease the target before Pi tears the current session down. */
    const switchSession: AgentSessionRuntime["switchSession"] = async (path, switchOptions) => {
      // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi command callback bridge.
      const header = await Effect.runPromise(readSessionHeaderOnly(path));
      const held = leases.hold(header.id);

      if (Result.isFailure(held)) throw held.failure;

      return replaced(() => runtime.switchSession(path, switchOptions));
    };

    const bindSession = async (): Promise<void> => {
      const session = runtime.session;
      unsubscribeSession();
      unsubscribeSession = session.subscribe(forward);

      await session.bindExtensions({
        mode: "print",
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          newSession: (newOptions) => replaced(() => runtime.newSession(newOptions)),
          fork: async (entryId, forkOptions) => ({
            cancelled: (await replaced(() => runtime.fork(entryId, forkOptions))).cancelled,
          }),
          navigateTree: async (targetId, navigateOptions) => ({
            cancelled: (await session.navigateTree(targetId, navigateOptions)).cancelled,
          }),
          switchSession,
          reload: () => session.reload(),
        },
        onError: (error) => {
          console.error(`Extension error (${error.extensionPath}): ${error.error}`);
        },
      });
    };

    runtime.setRebindSession(bindSession);
    yield* piPromise(profilePath, "bind agent runtime", bindSession);

    const unsubscribeVoice =
      runtime.voiceHub?.subscribe((agentId, text) => publish({ kind: "voice", agentId, text })) ??
      (() => undefined);

    const modelState = (): ChatSessionModelState => {
      const { model, thinkingLevel } = runtime.session;

      return model === undefined
        ? { thinking: thinkingLevel }
        : { providerId: model.provider, modelId: model.id, thinking: thinkingLevel };
    };

    const prompt = (text: string, promptOptions?: Parameters<ChatHandle["prompt"]>[1]) =>
      Effect.suspend((): Effect.Effect<string, ZiggyAgentError> => {
        const prepared =
          runtime.agents === undefined
            ? { ok: true as const, text }
            : prepareProfileAgentPrompt(text, runtime.agents);

        if (!prepared.ok)
          return Effect.fail(
            new ProfileAgentMentionInvalid({ profilePath, message: prepared.message }),
          );

        ensurePiSessionName(runtime.session.sessionManager, options.name, text);
        const context = runtime.ephemeralPromptContext;
        const generation = context === undefined ? 0 : ++context.generation;

        if (context !== undefined) {
          if (promptOptions?.ephemeralContext === undefined) delete context.value;
          else context.value = promptOptions.ephemeralContext;
        }

        return promptForAssistantText(
          profilePath,
          {
            abort,
            prompt: (message, turnOptions) => runtime.session.prompt(message, turnOptions),
            subscribe: (listener) => runtime.session.subscribe(listener),
            get isIdle() {
              return runtime.session.isIdle;
            },
          },
          prepared.text,
          promptOptions,
          runtime.voiceHub,
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (context?.generation === generation) delete context.value;
            }),
          ),
        );
      });

    const deliveryFailure = (
      category: AutomationConversationDeliveryFailed["category"],
      retriable: boolean,
      message: string,
      cause?: unknown,
    ) =>
      cause === undefined
        ? new AutomationConversationDeliveryFailed({ category, retriable, message })
        : new AutomationConversationDeliveryFailed({ category, retriable, message, cause });

    const alreadyDelivered = (result: AutomationConversationResult): boolean => {
      const file = runtime.session.sessionManager.getSessionFile();

      return (
        file !== undefined &&
        SessionManager.open(file, dirname(file), profilePath)
          .getEntries()
          .some((entry) => isAutomationReceipt(entry, result))
      );
    };

    const appendAutomationResult = (result: AutomationConversationResult) =>
      turn
        .withPermitsIfAvailable(1)(
          Effect.tryPromise({
            try: async () => {
              if (currentId() !== result.targetSessionId)
                throw deliveryFailure(
                  "destination-missing",
                  false,
                  `live session no longer owns ${result.targetSessionId}`,
                );

              if (alreadyDelivered(result)) return false;

              if (!runtime.session.isIdle)
                throw deliveryFailure("session-busy", true, "conversation has an active turn");

              try {
                await runtime.session.sendCustomMessage(
                  {
                    customType: AUTOMATION_RESULT_CUSTOM_TYPE,
                    content: automationResultContent(result),
                    display: true,
                    details: {
                      automationId: result.automationId,
                      runId: result.runId,
                      targetSessionId: result.targetSessionId,
                    },
                  },
                  { triggerTurn: false },
                );
              } catch (cause) {
                // A send can throw after Pi persisted the entry; the transcript is the receipt.
                if (alreadyDelivered(result)) return true;

                throw cause;
              }

              if (!alreadyDelivered(result))
                throw deliveryFailure(
                  "write",
                  true,
                  "the automation result was not persisted to the conversation",
                );

              return true;
            },
            catch: (cause) =>
              cause instanceof AutomationConversationDeliveryFailed
                ? cause
                : deliveryFailure(
                    "write",
                    true,
                    "could not append the automation result to the conversation",
                    cause,
                  ),
          }),
        )
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  deliveryFailure("session-busy", true, "conversation has an active turn"),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );

    const whileStreaming = (
      operation: "steer" | "followUp",
      run: () => ReturnType<HandleSession["steer"]>,
    ) =>
      Effect.suspend(
        (): Effect.Effect<void, ZiggyAgentError | ChatNotStreaming> =>
          runtime.session.isIdle
            ? Effect.fail(
                new ChatNotStreaming({
                  profilePath,
                  operation,
                  message:
                    operation === "steer" ? "no live turn to steer" : "no live turn to follow up",
                }),
              )
            : piPromise(profilePath, `${operation} agent session`, run).pipe(Effect.asVoid),
      );

    const handle: ChatHandle = {
      get isIdle() {
        return runtime.session.isIdle;
      },
      modelState: Effect.sync(modelState),
      setModel: (providerId, modelId) =>
        control(
          Effect.suspend(() => {
            const model = runtime.services.modelRuntime.getModel(providerId, modelId);

            return model === undefined
              ? Effect.fail(
                  new ProviderConfigError({
                    profilePath,
                    operation: "set session model",
                    message: `model ${providerId}/${modelId} is not available in this Profile`,
                    cause: undefined,
                  }),
                )
              : Effect.tryPromise({
                  try: () => runtime.session.setModel(model, { persist: false }),
                  catch: (cause) =>
                    cause instanceof Error && cause.message.startsWith("No API key for ")
                      ? new ProviderConfigError({
                          profilePath,
                          operation: "set session model",
                          message: `no API key configured for ${providerId}/${modelId}`,
                          cause: undefined,
                        })
                      : providerError(profilePath, "set session model", cause),
                });
          }).pipe(Effect.andThen(Effect.sync(modelState))),
        ),
      setThinkingLevel: (level) =>
        control(
          Effect.sync(() => {
            runtime.session.setThinkingLevel(level, { persist: false });

            return modelState();
          }),
        ),
      resume: (reference) =>
        control(
          Effect.gen(function* () {
            const metadata = yield* showProfileSession(profilePath, reference);
            const path = join(profilePath, "sessions", metadata.path);

            const header = yield* readSessionHeaderOnly(path).pipe(
              Effect.mapError((cause) => providerError(profilePath, "resume session", cause)),
            );

            // Lease the target and switch as one step: once Pi starts tearing the old
            // session down the switch must finish, and an interrupt must not strand the lease.
            const result = yield* Effect.uninterruptible(
              Effect.fromResult(leases.hold(header.id)).pipe(
                Effect.andThen(
                  piStep(profilePath, "resume session", () =>
                    replaced(() => runtime.switchSession(path)),
                  ),
                ),
              ),
            );

            return { cancelled: result.cancelled };
          }),
        ),
      currentSession: Effect.suspend(() =>
        currentReference(profilePath, runtime.session.sessionManager),
      ),
      appendAutomationResult,
      prompt: (text, promptOptions) =>
        turn
          .withPermitsIfAvailable(1)(prompt(text, promptOptions))
          .pipe(
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(busy()), onSome: Effect.succeed }),
            ),
          ),
      abort: piPromise(profilePath, "abort agent session", abort),
      steer: (text) => whileStreaming("steer", () => runtime.session.steer(text)),
      followUp: (text) => whileStreaming("followUp", () => runtime.session.followUp(text)),
      subscribe: (listener) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
      dispose: Effect.sync(() => {
        unsubscribeSession();
        unsubscribeVoice();
      }).pipe(
        Effect.andThen(disposeRuntime(profilePath, runtime)),
        Effect.ensuring(Effect.sync(() => leases.keepOnly(undefined))),
      ),
    };

    return handle;
  });
