import { Context, Effect, Layer } from "effect";
import { PiAgent } from "../adapters/pi/pi-agent";
import type { ZiggyAgentError } from "../domain/agent";
import type { ProfileTarget } from "../domain/profile";

export interface ZiggyAgentShape {
  readonly runOnce: (
    target: ProfileTarget,
    prompt: string,
    continueSession: boolean,
  ) => Effect.Effect<number, ZiggyAgentError>;
  readonly openTui: (target: ProfileTarget) => Effect.Effect<number, ZiggyAgentError>;
}

export class ZiggyAgent extends Context.Service<ZiggyAgent, ZiggyAgentShape>()(
  "ziggy/ZiggyAgent",
) {}

export const ZiggyAgentLive = Layer.effect(
  ZiggyAgent,
  Effect.gen(function* () {
    const piAgent = yield* PiAgent;
    return {
      runOnce: (target: ProfileTarget, prompt: string, continueSession: boolean) =>
        piAgent.askOnce(target, prompt, continueSession),
      openTui: (target: ProfileTarget) => piAgent.openTui(target),
    };
  }),
);
