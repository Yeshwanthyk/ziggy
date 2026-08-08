import { Context, Effect, Layer } from "effect";
import type { AutomationTuiHandler } from "../adapters/pi/automation-tui";
import { PiAgent, type ChatHandle, type ChatSessionMode } from "../adapters/pi/pi-agent";
import type {
  OpenTuiError,
  ProfileAgentRunContext,
  ProfileAgentRunResult,
  ProfileSpecialistError,
  ZiggyAgentError,
} from "../domain/agent";
import type { ChatContext } from "../domain/memory";
import type { ProfileTarget } from "../domain/profile";

export type { ChatHandle } from "../adapters/pi/pi-agent";

export interface ZiggyAgentShape {
  readonly runOnce: (
    target: ProfileTarget,
    prompt: string,
    continueSession: boolean,
    context: ChatContext,
  ) => Effect.Effect<number, ZiggyAgentError>;
  readonly openTui: (
    target: ProfileTarget,
    context: ChatContext,
    automationHandler?: AutomationTuiHandler,
  ) => Effect.Effect<number, OpenTuiError>;
  readonly openChat: (
    target: ProfileTarget,
    context: ChatContext,
    sessionDirectory: string,
    sessionMode?: ChatSessionMode,
  ) => Effect.Effect<ChatHandle, ZiggyAgentError>;
  readonly runSpecialist: (
    target: ProfileTarget,
    agentId: string,
    task: string,
    context: ProfileAgentRunContext,
  ) => Effect.Effect<ProfileAgentRunResult, ProfileSpecialistError>;
}

export class ZiggyAgent extends Context.Service<ZiggyAgent, ZiggyAgentShape>()(
  "ziggy/ZiggyAgent",
) {}

export const ZiggyAgentLive = Layer.effect(
  ZiggyAgent,
  Effect.gen(function* () {
    const piAgent = yield* PiAgent;
    return {
      runOnce: (
        target: ProfileTarget,
        prompt: string,
        continueSession: boolean,
        context: ChatContext,
      ) => piAgent.askOnce(target, prompt, continueSession, context),
      openTui: (
        target: ProfileTarget,
        context: ChatContext,
        automationHandler?: AutomationTuiHandler,
      ) => piAgent.openTui(target, context, automationHandler),
      openChat: (
        target: ProfileTarget,
        context: ChatContext,
        sessionDirectory: string,
        sessionMode?: ChatSessionMode,
      ) => piAgent.openChat(target, context, sessionDirectory, sessionMode),
      runSpecialist: (target, agentId, task, context) =>
        piAgent.runSpecialist(target, agentId, task, context),
    };
  }),
);
