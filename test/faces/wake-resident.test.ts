/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute the face Effect */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- the fake SDK connection implements its Promise contract */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  ZiggyInvalidResponseError,
  type ZiggyConnection,
} from "../../packages/ui-sdk/src/connection";
import { wakeInResident } from "ziggy/faces/wake-resident";

const target = { name: "test", path: "/tmp/ziggy-wake-face-fixture" };

const projection = { version: 1 as const, port: 1234, token: "a".repeat(64) };

test("a stale resident socket fails before send on the short connect deadline", async () => {
  let requests = 0;
  let closes = 0;
  let unsubscribes = 0;

  const connection: ZiggyConnection = {
    state: "connecting",
    epoch: undefined,
    request: () => {
      requests += 1;

      return Promise.reject("unexpected request");
    },
    watch: () => Promise.resolve(),
    unwatch: () => Promise.resolve(),
    on: () => () => {
      unsubscribes += 1;
    },
    onAny: () => () => undefined,
    close: () => {
      closes += 1;
    },
  };

  const result = await Effect.runPromise(
    wakeInResident(target, "daily-note", projection, {
      connect: () => connection,
      connectTimeoutMs: 20,
    }).pipe(Effect.result),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { message: "resident wake timed out before send; safe to retry" },
  });
  expect({ requests, closes, unsubscribes }).toEqual({ requests: 0, closes: 1, unsubscribes: 1 });
});

test("old resident response schema reports an unknown outcome, never a safe retry", async () => {
  let closes = 0;

  const connection: ZiggyConnection = {
    state: "open",
    epoch: undefined,
    request: () => Promise.reject(new ZiggyInvalidResponseError("automation.run")),
    watch: () => Promise.resolve(),
    unwatch: () => Promise.resolve(),
    on: () => () => undefined,
    onAny: () => () => undefined,
    close: () => {
      closes += 1;
    },
  };

  const result = await Effect.runPromise(
    wakeInResident(target, "daily-note", projection, {
      connect: () => connection,
      connectTimeoutMs: 20,
    }).pipe(Effect.result),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      message: "resident wake outcome unknown; check `ziggy automations runs` before retrying",
    },
  });
  expect(closes).toBe(1);
});
