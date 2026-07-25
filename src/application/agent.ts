import { Context, Effect, Layer } from "effect";
import { PiAgent } from "../adapters/pi/pi-agent";
import type { ZiggyAgentError } from "../domain/agent";
import type { ProfileTarget } from "../domain/profile";

export interface ZiggyAgentShape {
  readonly runOnce: (
    target: ProfileTarget,
    prompt: string,
  ) => Effect.Effect<number, ZiggyAgentError>;
}

export class ZiggyAgent extends Context.Service<ZiggyAgent, ZiggyAgentShape>()(
  "ziggy/ZiggyAgent",
) {}

export const ZiggyAgentLive = Layer.effect(
  ZiggyAgent,
  Effect.gen(function* () {
    const piAgent = yield* PiAgent;
    return {
      runOnce: (target: ProfileTarget, prompt: string) => piAgent.askOnce(target, prompt),
    };
  }),
);
