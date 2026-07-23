import { Effect, Ref } from "effect";
import { DiscordApiError, DiscordService } from "./discord.ts";

export interface FakeDiscordDelivery {
  readonly messageId: string;
  readonly channelId: string;
  readonly content: string;
}

/** Deterministic Discord API substitute; message identity follows accepted send order. */
export const makeFakeDiscordService = Effect.gen(function* () {
  const deliveries = yield* Ref.make<ReadonlyArray<FakeDiscordDelivery>>([]);
  const failNext = yield* Ref.make(false);
  const service = DiscordService.of({
    sendMessage: (channelId, content) =>
      Ref.getAndSet(failNext, false).pipe(
        Effect.flatMap((shouldFail) => {
          if (shouldFail) {
            return Effect.fail(
              new DiscordApiError({
                operation: "send-message",
                code: "target-unavailable",
                message: "Fake Discord delivery failed",
              }),
            );
          }
          return Ref.update(deliveries, (current) => {
            const delivery = {
              messageId: `discord-fixture-${current.length + 1}`,
              channelId,
              content,
            };
            return [...current, delivery];
          });
        }),
      ),
  });
  return {
    service,
    deliveries: Ref.get(deliveries),
    failNextSend: Ref.set(failNext, true),
  };
});

export type FakeDiscordService = Effect.Success<typeof makeFakeDiscordService>;
