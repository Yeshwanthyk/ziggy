import { Effect, Ref } from "effect";
import type { SlackPostMessageReceipt, SlackPostMessageRequest } from "./model.ts";
import type { SlackService } from "./gateway.ts";

export interface FakeSlackService extends SlackService {
  readonly requests: Effect.Effect<ReadonlyArray<SlackPostMessageRequest>>;
}

export function makeFakeSlackService(): Effect.Effect<FakeSlackService> {
  return Ref.make<ReadonlyArray<SlackPostMessageRequest>>([]).pipe(
    Effect.map(
      (requests): FakeSlackService => ({
        requests: Ref.get(requests),
        postMessage: (request) =>
          Ref.modify(
            requests,
            (
              existing,
            ): readonly [SlackPostMessageReceipt, ReadonlyArray<SlackPostMessageRequest>] => [
              {
                channel: request.channel,
                ts: `1700000000.${String(existing.length + 1).padStart(6, "0")}`,
              },
              [...existing, request],
            ],
          ),
      }),
    ),
  );
}
