/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun test callbacks are Promise-shaped */
/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute Effects */
import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { makeUiUploadStore } from "ziggy/application/ui-gateway";
import { protocolFailure } from "ziggy/application/ui-gateway/errors";

const image = { type: "image", mimeType: "image/png", data: "fixture" } as const;

const unavailable = Result.fail(
  protocolFailure("bad_params", "An image attachment is unavailable or expired. Attach it again."),
);

test("uploads bind to an owner, consume once, and reject a whole invalid batch", async () => {
  const store = makeUiUploadStore();
  const id = store.put("alice", image);
  const foreign = store.put("bob", image);
  expect(await Effect.runPromise(store.consume("bob", [id]).pipe(Effect.result))).toEqual(
    unavailable,
  );
  expect(
    await Effect.runPromise(store.consume("alice", [id, foreign]).pipe(Effect.result)),
  ).toEqual(unavailable);
  expect(await Effect.runPromise(store.consume("alice", [id]))).toEqual([image]);
  expect(await Effect.runPromise(store.consume("alice", [id]).pipe(Effect.result))).toEqual(
    unavailable,
  );
  expect(await Effect.runPromise(store.consume("bob", [foreign]))).toEqual([image]);
});

test("uploads expire at ten minutes and evict only the owner's oldest upload", async () => {
  let now = 0;
  const store = makeUiUploadStore(() => now);
  const expired = store.put("alice", image);
  now = 600_000;
  expect(await Effect.runPromise(store.consume("alice", [expired]).pipe(Effect.result))).toEqual(
    unavailable,
  );
  const bob = store.put("bob", image);
  const ids = Array.from({ length: 9 }, () => store.put("alice", image));
  expect(
    await Effect.runPromise(store.consume("alice", ids.slice(0, 1)).pipe(Effect.result)),
  ).toEqual(unavailable);
  expect(await Effect.runPromise(store.consume("alice", ids.slice(1)))).toHaveLength(8);
  expect(await Effect.runPromise(store.consume("bob", [bob]))).toEqual([image]);
});

test("duplicate IDs fail without consuming the image", async () => {
  const store = makeUiUploadStore();
  const id = store.put("alice", image);
  expect(await Effect.runPromise(store.consume("alice", [id, id]).pipe(Effect.result))).toEqual(
    Result.fail(protocolFailure("bad_params", "Each image attachment must be unique.")),
  );
  expect(await Effect.runPromise(store.consume("alice", [id]))).toEqual([image]);
});
