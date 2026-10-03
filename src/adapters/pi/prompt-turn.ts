import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { ChatPromptOptions } from "../../session";
import { ProviderCallError } from "../../domain/agent";
import { createChatEventProjector } from "./chat-event-projector";
import { piPromise, providerError } from "./provider-failure";
import { ProviderConfigError } from "../../profile";

export type PromptSession = Pick<
  AgentSessionRuntime["session"],
  "abort" | "isIdle" | "prompt" | "subscribe"
>;

export interface SpecialistVoiceHub {
  readonly emit: (agentId: string, text: string) => void;
  readonly subscribe: (listener: (agentId: string, text: string) => void) => () => void;
}

export const promptForAssistantText = (
  profilePath: string,
  session: PromptSession,
  text: string,
  options?: ChatPromptOptions,
  voiceHub?: SpecialistVoiceHub,
): Effect.Effect<string, ProviderConfigError | ProviderCallError> =>
  Effect.callback((resume) => {
    let assistantText = "";
    let assistantError: string | undefined;
    let finished = false;
    let unsubscribe: () => void = () => undefined;
    let unsubscribeVoice: () => void = () => undefined;
    const projector = createChatEventProjector();

    const finish = (result: Effect.Effect<string, ProviderConfigError | ProviderCallError>) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      unsubscribeVoice();
      resume(result);
    };

    const completeAssistant = () =>
      assistantError === undefined
        ? Effect.succeed(assistantText)
        : Effect.fail(providerError(profilePath, "call provider", new Error(assistantError)));

    unsubscribe = session.subscribe((event) => {
      for (const chatEvent of projector(event)) {
        if (chatEvent.kind === "assistant-text" || chatEvent.kind === "tool") {
          options?.onProgress?.(chatEvent);
        }
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        assistantText = event.message.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("");
        assistantError =
          event.message.stopReason === "error" || event.message.stopReason === "aborted"
            ? (event.message.errorMessage ?? `Request ${event.message.stopReason}`)
            : undefined;
      }

      if (event.type === "agent_settled") finish(completeAssistant());
    });

    if (voiceHub !== undefined && options?.onProgress !== undefined) {
      const onProgress = options.onProgress;
      unsubscribeVoice = voiceHub.subscribe((agentId, text) => {
        onProgress({ kind: "voice", agentId, text });
      });
    }

    const promptOptions = options?.images === undefined ? undefined : { images: options.images };
    void session.prompt(text, promptOptions).then(
      () => {
        if (session.isIdle) finish(completeAssistant());
      },
      (cause: unknown) => finish(Effect.fail(providerError(profilePath, "call provider", cause))),
    );

    return Effect.sync(() => {
      if (finished) return false;
      finished = true;
      unsubscribe();
      unsubscribeVoice();

      return true;
    }).pipe(
      Effect.flatMap((shouldAbort) =>
        shouldAbort
          ? piPromise(profilePath, "abort agent session", () => session.abort()).pipe(
              Effect.catch((failure) =>
                Effect.logWarning("Pi prompt interruption cleanup failed", { failure }),
              ),
            )
          : Effect.void,
      ),
    );
  });
