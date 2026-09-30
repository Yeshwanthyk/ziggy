/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeDestinationBook } from "ziggy/resident/destinations";

test("a later sighting without a label keeps the known label", () => {
  const book = makeDestinationBook();

  const target = {
    _tag: "slack" as const,
    target: "slack:channel:C012345678",
    channelId: "C012345678",
  };

  Effect.runSync(book.remember({ target, label: "engineering" }));
  Effect.runSync(book.remember({ target }));

  expect(Effect.runSync(book.list)).toEqual([{ target, label: "engineering" }]);
});
