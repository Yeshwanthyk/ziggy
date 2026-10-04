import { expect, test } from "bun:test";
import { keyPairFromPrivate, noiseInitiator } from "../src/noise";

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

test("the initiator matches the published vector through transport", () => {
  const [one, two, three, four, five, six] = VECTOR.messages;

  const noise = noiseInitiator({
    staticKeyPair: keyPairFromPrivate(hex(VECTOR.initStatic)),
    ephemeralKeyPair: keyPairFromPrivate(hex(VECTOR.initEphemeral)),
    prologue: hex(VECTOR.prologue),
    payloads: [hex(one[0]), hex(three[0])],
  });

  expect(toHex(noise.start())).toBe(one[1]);

  const { message, transport } = noise.respond(hex(two[1]));

  expect(toHex(message)).toBe(three[1]);
  expect(toHex(transport.remoteStatic)).toBe(
    toHex(keyPairFromPrivate(hex(VECTOR.respStatic)).publicKey),
  );
  expect(toHex(transport.decrypt(hex(four[1])))).toBe(four[0]);
  expect(toHex(transport.encrypt(hex(five[0])))).toBe(five[1]);
  expect(toHex(transport.decrypt(hex(six[1])))).toBe(six[0]);
});

test("a tampered message fails and poisons the direction", () => {
  const [, two, , four] = VECTOR.messages;

  const noise = noiseInitiator({
    staticKeyPair: keyPairFromPrivate(hex(VECTOR.initStatic)),
    ephemeralKeyPair: keyPairFromPrivate(hex(VECTOR.initEphemeral)),
    prologue: hex(VECTOR.prologue),
    payloads: [hex(VECTOR.messages[0][0]), hex(VECTOR.messages[2][0])],
  });

  noise.start();

  const { transport } = noise.respond(hex(two[1]));

  const bad = hex(four[1]);

  bad[0] = (bad[0] ?? 0) ^ 1;

  expect(() => transport.decrypt(bad)).toThrow("a message failed authentication");
  expect(() => transport.decrypt(hex(four[1]))).toThrow("the link failed an earlier decrypt");
});
