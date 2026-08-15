/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun executes the scoped Pi callback bridge */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  makeAutomationTuiDispatch,
  type AutomationTuiHandler,
} from "ziggy/adapters/pi/automation-tui";

test("keeps automation application execution inside the scoped Effect worker", async () => {
  const requests: string[] = [];
  const handler: AutomationTuiHandler = (request) =>
    Effect.sync(() => {
      requests.push(request.kind);
      return {
        kind: "overview" as const,
        definitions: [],
        statusText: "scheduler: unknown",
      };
    });

  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dispatch = yield* makeAutomationTuiDispatch(handler);
        return yield* Effect.tryPromise(() => dispatch({ kind: "overview" }));
      }),
    ),
  );

  expect(requests).toEqual(["overview"]);
  expect(response).toEqual({
    kind: "overview",
    definitions: [],
    statusText: "scheduler: unknown",
  });
});
