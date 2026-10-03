/**
 * Noise_XX_25519_AESGCM_SHA256 (Noise Protocol Framework rev 34), both roles.
 *
 * The device link runs this handshake over a WebSocket. It matches Muse's `noise_core` and
 * `noise_xx.py` byte for byte, and the standard Noise test vectors.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { Effect, Schema } from "effect";

export class NoiseFailed extends Schema.TaggedErrorClass<NoiseFailed>()("NoiseFailed", {
  reason: Schema.Literals(["decrypt", "malformed", "key", "phase", "nonce"]),
  message: Schema.String,
}) {}

export interface NoiseKeyPair {
  /** Raw 32-byte X25519 public key. */
  readonly publicKey: Uint8Array;
  /** Raw 32-byte X25519 private key. */
  readonly privateKey: Uint8Array;
}

export interface NoiseCipher {
  readonly encrypt: (plaintext: Uint8Array) => Effect.Effect<Uint8Array, NoiseFailed>;
  readonly decrypt: (ciphertext: Uint8Array) => Effect.Effect<Uint8Array, NoiseFailed>;
}

export interface NoiseSession {
  /** Sends to the peer. */
  readonly send: NoiseCipher["encrypt"];
  /** Receives from the peer. */
  readonly receive: NoiseCipher["decrypt"];
  /** The peer's static public key, proven by the handshake. Pin it. */
  readonly remoteStatic: Uint8Array;
  readonly handshakeHash: Uint8Array;
}

export interface NoiseHandshake {
  /** Message 1 or 3 for the initiator, message 2 for the responder. */
  readonly write: (payload?: Uint8Array) => Effect.Effect<Uint8Array, NoiseFailed>;
  /** Message 2 for the initiator, message 1 or 3 for the responder. Returns the payload. */
  readonly read: (message: Uint8Array) => Effect.Effect<Uint8Array, NoiseFailed>;
  /** After the third message. */
  readonly finish: Effect.Effect<NoiseSession, NoiseFailed>;
}

export interface NoiseHandshakeOptions {
  readonly role: "initiator" | "responder";
  readonly staticKeyPair: NoiseKeyPair;
  readonly prologue?: Uint8Array;
  /** Fixed ephemeral key, for the published test vectors only. */
  readonly ephemeralKeyPair?: NoiseKeyPair;
}

const PROTOCOL_NAME = "Noise_XX_25519_AESGCM_SHA256";

const KEY_LENGTH = 32;

const TAG_LENGTH = 16;

const MAX_MESSAGE = 65_535;

const MAX_NONCE = Number.MAX_SAFE_INTEGER;

const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const EMPTY = new Uint8Array(0);

const fail = (reason: NoiseFailed["reason"], message: string) =>
  new NoiseFailed({ reason, message });

const privateKeyObject = (raw: Uint8Array): KeyObject =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });

const rawPublicKey = (key: KeyObject): Uint8Array =>
  new Uint8Array(key.export({ format: "der", type: "spki" }).subarray(-KEY_LENGTH));

export const generateNoiseKeyPair = (): NoiseKeyPair => {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");

  return {
    publicKey: rawPublicKey(publicKey),
    privateKey: new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)),
  };
};

/** The key pair whose private half is `privateKey`. */
export const noiseKeyPairFromPrivate = (privateKey: Uint8Array): NoiseKeyPair => ({
  // An X25519 private JWK carries its public half as `x`.
  publicKey: new Uint8Array(
    Buffer.from(privateKeyObject(privateKey).export({ format: "jwk" }).x ?? "", "base64url"),
  ),
  privateKey,
});

/** X25519; node rejects low-order points, whose shared secret is all zeros. */
const dh = (keyPair: NoiseKeyPair, publicKey: Uint8Array): Effect.Effect<Uint8Array, NoiseFailed> =>
  Effect.try({
    try: () =>
      new Uint8Array(
        diffieHellman({
          privateKey: privateKeyObject(keyPair.privateKey),
          publicKey: createPublicKey({
            key: Buffer.concat([SPKI_PREFIX, publicKey]),
            format: "der",
            type: "spki",
          }),
        }),
      ),
    catch: () => fail("key", "the peer sent an invalid X25519 public key"),
  });

const sha256 = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const hash = createHash("sha256");

  for (const part of parts) hash.update(part);

  return new Uint8Array(hash.digest());
};

const hmac = (key: Uint8Array, ...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const mac = createHmac("sha256", key);

  for (const part of parts) mac.update(part);

  return new Uint8Array(mac.digest());
};

const hkdf2 = (chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] => {
  const temp = hmac(chainingKey, input);
  const first = hmac(temp, Uint8Array.of(1));

  return [first, hmac(temp, first, Uint8Array.of(2))];
};

const nonceIv = (nonce: number): Uint8Array => {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(nonce), false);

  return iv;
};

/**
 * One direction's AEAD state. A failed decrypt poisons it: Noise has no way to resynchronise a
 * nonce, so the link must be dropped.
 */
const makeCipher = (key: Uint8Array | undefined) => {
  let nonce = 0;
  let poisoned = false;

  const next = Effect.suspend(() => {
    if (poisoned) return Effect.fail(fail("decrypt", "the link failed an earlier decrypt"));

    if (nonce >= MAX_NONCE) return Effect.fail(fail("nonce", "the link exhausted its nonces"));
    const current = nonce;
    nonce += 1;

    return Effect.succeed(current);
  });

  const encryptWithAd = (ad: Uint8Array, plaintext: Uint8Array) =>
    key === undefined
      ? Effect.succeed(plaintext)
      : Effect.map(next, (n) => {
          const cipher = createCipheriv("aes-256-gcm", key, nonceIv(n));
          cipher.setAAD(ad);
          const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);

          return new Uint8Array(Buffer.concat([body, cipher.getAuthTag()]));
        });

  const decryptWithAd = (ad: Uint8Array, ciphertext: Uint8Array) => {
    if (key === undefined) return Effect.succeed(ciphertext);

    if (ciphertext.length < TAG_LENGTH)
      return Effect.fail(fail("malformed", "a Noise message is shorter than its tag"));

    return Effect.flatMap(next, (n) =>
      Effect.try({
        try: () => {
          const decipher = createDecipheriv("aes-256-gcm", key, nonceIv(n));
          decipher.setAAD(ad);
          decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
          const body = decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH));

          return new Uint8Array(Buffer.concat([body, decipher.final()]));
        },
        catch: () => {
          poisoned = true;

          return fail("decrypt", "a Noise message failed authentication");
        },
      }),
    );
  };

  return { encryptWithAd, decryptWithAd };
};

const transportCipher = (key: Uint8Array): NoiseCipher => {
  const cipher = makeCipher(key);

  const guard = (data: Uint8Array) =>
    data.length > MAX_MESSAGE
      ? Effect.fail(fail("malformed", `a Noise message is over ${MAX_MESSAGE} bytes`))
      : Effect.succeed(data);

  return {
    encrypt: (plaintext) =>
      Effect.flatMap(guard(plaintext), (data) => cipher.encryptWithAd(EMPTY, data)),
    decrypt: (ciphertext) =>
      Effect.flatMap(guard(ciphertext), (data) => cipher.decryptWithAd(EMPTY, data)),
  };
};

/** XX: `-> e`, `<- e, ee, s, es`, `-> s, se`. */
export const noiseXX = (options: NoiseHandshakeOptions): NoiseHandshake => {
  const initiator = options.role === "initiator";
  const name = new TextEncoder().encode(PROTOCOL_NAME);

  let h: Uint8Array =
    name.length <= 32 ? Uint8Array.from({ length: 32 }, (_, i) => name[i] ?? 0) : sha256(name);

  let ck = h;
  let cipher = makeCipher(undefined);
  let ephemeral: NoiseKeyPair | undefined;
  let remoteEphemeral: Uint8Array | undefined;
  let remoteStatic: Uint8Array | undefined;
  let step = 0;

  const mixHash = (data: Uint8Array) => {
    h = sha256(h, data);
  };

  const mixKey = (input: Uint8Array) => {
    const [nextCk, key] = hkdf2(ck, input);
    ck = nextCk;
    cipher = makeCipher(key);
  };

  const mixDh = (keyPair: NoiseKeyPair, publicKey: Uint8Array) =>
    Effect.map(dh(keyPair, publicKey), mixKey);

  const encryptAndHash = (plaintext: Uint8Array) =>
    Effect.map(cipher.encryptWithAd(h, plaintext), (ciphertext) => {
      mixHash(ciphertext);

      return ciphertext;
    });

  const decryptAndHash = (ciphertext: Uint8Array) =>
    Effect.map(cipher.decryptWithAd(h, ciphertext), (plaintext) => {
      mixHash(ciphertext);

      return plaintext;
    });

  mixHash(options.prologue ?? EMPTY);

  const ownStatic = options.staticKeyPair;

  const takeEphemeral = () => {
    ephemeral = options.ephemeralKeyPair ?? generateNoiseKeyPair();
    mixHash(ephemeral.publicKey);

    return ephemeral.publicKey;
  };

  const required = <A>(value: A | undefined, what: string) =>
    value === undefined ? Effect.fail(fail("phase", `${what} is missing`)) : Effect.succeed(value);

  const writes = initiator ? [0, 2] : [1];
  const reads = initiator ? [1] : [0, 2];

  const write = (payload: Uint8Array = EMPTY) =>
    Effect.gen(function* () {
      if (!writes.includes(step)) return yield* fail("phase", `cannot write message ${step + 1}`);
      const parts: Array<Uint8Array> = [];

      if (step === 0) {
        parts.push(takeEphemeral());
      } else if (step === 1) {
        parts.push(takeEphemeral());
        const re = yield* required(remoteEphemeral, "the initiator ephemeral key");
        yield* mixDh(yield* required(ephemeral, "the ephemeral key"), re);
        parts.push(yield* encryptAndHash(ownStatic.publicKey));
        yield* mixDh(ownStatic, re);
      } else {
        parts.push(yield* encryptAndHash(ownStatic.publicKey));
        yield* mixDh(ownStatic, yield* required(remoteEphemeral, "the responder ephemeral key"));
      }

      parts.push(yield* encryptAndHash(payload));
      step += 1;
      const message = new Uint8Array(Buffer.concat(parts));

      if (message.length > MAX_MESSAGE)
        return yield* fail("malformed", `a Noise message is over ${MAX_MESSAGE} bytes`);

      return message;
    });

  const read = (message: Uint8Array) =>
    Effect.gen(function* () {
      if (!reads.includes(step)) return yield* fail("phase", `cannot read message ${step + 1}`);

      const minimum =
        [KEY_LENGTH, KEY_LENGTH * 2 + TAG_LENGTH * 2, KEY_LENGTH + TAG_LENGTH * 2][step] ?? 0;

      if (message.length < minimum || message.length > MAX_MESSAGE)
        return yield* fail("malformed", `Noise message ${step + 1} has the wrong length`);

      let rest = message;

      if (step === 0) {
        remoteEphemeral = rest.subarray(0, KEY_LENGTH);
        mixHash(remoteEphemeral);
        rest = rest.subarray(KEY_LENGTH);
      } else if (step === 1) {
        remoteEphemeral = rest.subarray(0, KEY_LENGTH);
        mixHash(remoteEphemeral);
        const e = yield* required(ephemeral, "the ephemeral key");
        yield* mixDh(e, remoteEphemeral);
        remoteStatic = yield* decryptAndHash(
          rest.subarray(KEY_LENGTH, KEY_LENGTH * 2 + TAG_LENGTH),
        );
        yield* mixDh(e, remoteStatic);
        rest = rest.subarray(KEY_LENGTH * 2 + TAG_LENGTH);
      } else {
        remoteStatic = yield* decryptAndHash(rest.subarray(0, KEY_LENGTH + TAG_LENGTH));
        yield* mixDh(yield* required(ephemeral, "the ephemeral key"), remoteStatic);
        rest = rest.subarray(KEY_LENGTH + TAG_LENGTH);
      }

      const payload = yield* decryptAndHash(rest);
      step += 1;

      return payload;
    });

  const finish = Effect.gen(function* () {
    if (step !== 3) return yield* fail("phase", "the handshake is not complete");
    const peer = yield* required(remoteStatic, "the peer static key");
    const [first, second] = hkdf2(ck, EMPTY);
    const [sendKey, receiveKey] = initiator ? [first, second] : [second, first];
    const send = transportCipher(sendKey);
    const receive = transportCipher(receiveKey);
    step = 4;

    return {
      send: send.encrypt,
      receive: receive.decrypt,
      remoteStatic: peer,
      handshakeHash: h,
    } satisfies NoiseSession;
  });

  return { write, read, finish };
};
