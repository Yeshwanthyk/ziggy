import { Effect, Ref } from "effect";
import type {
  TelegramApiError,
  TelegramBotApi,
  TelegramPollRequest,
  TelegramPollResult,
  TelegramSendRequest,
} from "./telegram-api.ts";

export type FakeTelegramOutcome =
  | { readonly type: "poll"; readonly result: TelegramPollResult }
  | { readonly type: "failure"; readonly error: TelegramApiError };

export interface FakeTelegramBotApi extends TelegramBotApi {
  readonly pollRequests: Effect.Effect<ReadonlyArray<TelegramPollRequest>>;
  readonly sentRequests: Effect.Effect<ReadonlyArray<TelegramSendRequest>>;
}

export function makeFakeTelegramBotApi(
  outcomes: ReadonlyArray<FakeTelegramOutcome>,
): Effect.Effect<FakeTelegramBotApi> {
  return Effect.gen(function* () {
    const queue = yield* Ref.make(outcomes);
    const polls = yield* Ref.make<ReadonlyArray<TelegramPollRequest>>([]);
    const sent = yield* Ref.make<ReadonlyArray<TelegramSendRequest>>([]);
    return {
      getUpdates: (request) =>
        Effect.gen(function* () {
          yield* Ref.update(polls, (items) => [...items, request]);
          const outcome = yield* Ref.modify(queue, (items) => [items[0], items.slice(1)]);
          if (outcome === undefined) return { nextOffset: request.offset, messages: [] };
          if (outcome.type === "failure") return yield* Effect.fail(outcome.error);
          return outcome.result;
        }),
      sendMessage: (request) => Ref.update(sent, (items) => [...items, request]),
      pollRequests: Ref.get(polls),
      sentRequests: Ref.get(sent),
    };
  });
}
