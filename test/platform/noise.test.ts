/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { Effect, Exit } from "effect";
import { expect, test } from "bun:test";
import {
  NoiseFailed,
  generateNoiseKeyPair,
  noiseKeyPairFromPrivate,
  noiseXX,
} from "ziggy/platform/noise";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

const toHex = (value: Uint8Array) => Buffer.from(value).toString("hex");

/** Noise_XX_25519_AESGCM_SHA256 from the cacophony vectors (snow `tests/vectors/cacophony.txt`). */
const VECTOR = {
  prologue: "4a6f686e2047616c74",
  initStatic: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  initEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  respStatic: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  respEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  handshakeHash: "1b7aefb1125762aa21a252890d00af54519638b76437444538f9a52f21e2e0dc",
  messages: [
    [
      "4c756477696720766f6e204d69736573",
      "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444c756477696720766f6e204d69736573",
    ],
    [
      "4d757272617920526f746862617264",
      "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843757117acceb05bd7a45733bc22015c97a9d0cbaf41b80446d5988ff5127235d76b79eade70f473d6a4ef521fdcbeda5340d01e028ba793fc059f2724a83af05f12dda0448a7621a926b379a92477fd",
    ],
    [
      "462e20412e20486179656b",
      "c90f1cf77eba4e50edb038991565e36c9758943a989229b6051244dc4fbecb6946744b401af2ee1a5881b65fbb87fd07cb6a328ececc9ce6ce84c399dc332d4fd521fa4bb7f467ce909395",
    ],
    ["4361726c204d656e676572", "bc3fa77f6aca3e8466d7dc6bea10013e88a6a29add5132b461806c"],
    [
      "4a65616e2d426170746973746520536179",
      "250b01074cdfe0df2ecf8ccbf1737b15a2ddb5b52fd9a396604e9c793cee3b3bb9",
    ],
    [
      "457567656e2042f6686d20766f6e2042617765726b",
      "449d4d433b3cdc3d02bf6fc881774b9df54366ebcffb9689bb13f14709822cd7ef42bcdb4d",
    ],
  ],
} as const;

test("Noise XX matches the published vector in both roles, through transport", async () => {
  const key = (value: string) => noiseKeyPairFromPrivate(hex(value));

  const initiator = noiseXX({
    role: "initiator",
    staticKeyPair: key(VECTOR.initStatic),
    ephemeralKeyPair: key(VECTOR.initEphemeral),
    prologue: hex(VECTOR.prologue),
  });

  const responder = noiseXX({
    role: "responder",
    staticKeyPair: key(VECTOR.respStatic),
    ephemeralKeyPair: key(VECTOR.respEphemeral),
    prologue: hex(VECTOR.prologue),
  });

  const seen = await Effect.runPromise(
    Effect.gen(function* () {
      const out: Array<{ ciphertext: string; payload: string }> = [];

      const handshake = [
        [initiator, responder, VECTOR.messages[0][0]],
        [responder, initiator, VECTOR.messages[1][0]],
        [initiator, responder, VECTOR.messages[2][0]],
      ] as const;

      for (const [from, to, payload] of handshake) {
        const ciphertext = yield* from.write(hex(payload));

        const received = yield* to.read(ciphertext);

        out.push({ ciphertext: toHex(ciphertext), payload: toHex(received) });
      }

      const i = yield* initiator.finish;
      const r = yield* responder.finish;

      for (const [index, [payload]] of VECTOR.messages.slice(3).entries()) {
        const [from, to] = index % 2 === 0 ? [r, i] : [i, r];
        const ciphertext = yield* from.send(hex(payload));
        out.push({ ciphertext: toHex(ciphertext), payload: toHex(yield* to.receive(ciphertext)) });
      }

      return {
        out,
        hashes: [toHex(i.handshakeHash), toHex(r.handshakeHash)],
        pinned: [toHex(i.remoteStatic), toHex(r.remoteStatic)],
      };
    }),
  );

  expect(seen).toEqual({
    out: VECTOR.messages.map(([payload, ciphertext]) => ({ ciphertext, payload })),
    hashes: [VECTOR.handshakeHash, VECTOR.handshakeHash],
    pinned: [
      toHex(noiseKeyPairFromPrivate(hex(VECTOR.respStatic)).publicKey),
      toHex(noiseKeyPairFromPrivate(hex(VECTOR.initStatic)).publicKey),
    ],
  });
});

test("a tampered transport message fails authentication and poisons the direction", async () => {
  const exits = await Effect.runPromise(
    Effect.gen(function* () {
      const initiator = noiseXX({ role: "initiator", staticKeyPair: generateNoiseKeyPair() });
      const responder = noiseXX({ role: "responder", staticKeyPair: generateNoiseKeyPair() });
      yield* responder.read(yield* initiator.write());
      yield* initiator.read(yield* responder.write());
      yield* responder.read(yield* initiator.write());
      const i = yield* initiator.finish;
      const r = yield* responder.finish;

      const good = yield* i.send(new TextEncoder().encode("hello"));
      const bad = Uint8Array.from(good);
      bad[0] = (bad[0] ?? 0) ^ 1;

      return [yield* Effect.exit(r.receive(bad)), yield* Effect.exit(r.receive(good))];
    }),
  );

  expect(exits).toEqual([
    Exit.fail(
      new NoiseFailed({ reason: "decrypt", message: "a Noise message failed authentication" }),
    ),
    Exit.fail(
      new NoiseFailed({ reason: "decrypt", message: "the link failed an earlier decrypt" }),
    ),
  ]);
});
