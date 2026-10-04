/**
 * The initiator side of Noise_XX_25519_AESGCM_SHA256, which is the only side a device plays.
 * It matches the hub's `src/platform/noise.ts` and the standard Noise test vectors.
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

/** The link cannot continue: a bad handshake, a failed decrypt, or a message out of order. */
export class NoiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoiseError";
  }
}

export interface KeyPair {
  /** Raw 32-byte X25519 public key. */
  readonly publicKey: Uint8Array;
  /** Raw 32-byte X25519 private key. */
  readonly privateKey: Uint8Array;
}

export interface NoiseTransport {
  readonly encrypt: (plaintext: Uint8Array) => Uint8Array;
  /** Throws on a failed decrypt; the link must then be dropped. */
  readonly decrypt: (ciphertext: Uint8Array) => Uint8Array;
  /** The hub's static key, proven by the handshake. */
  readonly remoteStatic: Uint8Array;
}

export interface NoiseInitiator {
  /** Message 1. */
  readonly start: () => Uint8Array;
  /** Reads message 2 and returns message 3 with the finished transport. */
  readonly respond: (message: Uint8Array) => {
    readonly message: Uint8Array;
    readonly transport: NoiseTransport;
  };
}

const PROTOCOL_NAME = "Noise_XX_25519_AESGCM_SHA256";

const KEY_LENGTH = 32;

const TAG_LENGTH = 16;

const MAX_MESSAGE = 65_535;

const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const EMPTY = new Uint8Array(0);

const privateKeyObject = (raw: Uint8Array): KeyObject =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });

export const generateKeyPair = (): KeyPair => {
  const { privateKey } = generateKeyPairSync("x25519");

  return keyPairFromPrivate(
    new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-KEY_LENGTH)),
  );
};

/** The key pair whose private half is `privateKey`. */
export const keyPairFromPrivate = (privateKey: Uint8Array): KeyPair => {
  if (privateKey.length !== KEY_LENGTH) throw new NoiseError("a private key is 32 bytes");

  // An X25519 private JWK carries its public half as `x`.
  const publicKey = privateKeyObject(privateKey).export({ format: "jwk" }).x ?? "";

  return { publicKey: new Uint8Array(Buffer.from(publicKey, "base64url")), privateKey };
};

/** X25519; node rejects low-order points, whose shared secret is all zeros. */
const dh = (keyPair: KeyPair, publicKey: Uint8Array): Uint8Array => {
  try {
    return new Uint8Array(
      diffieHellman({
        privateKey: privateKeyObject(keyPair.privateKey),
        publicKey: createPublicKey({
          key: Buffer.concat([SPKI_PREFIX, publicKey]),
          format: "der",
          type: "spki",
        }),
      }),
    );
  } catch {
    throw new NoiseError("the hub sent an invalid X25519 public key");
  }
};

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

/** One direction's AEAD state. A failed decrypt poisons it: Noise cannot resynchronise a nonce. */
const makeCipher = (key: Uint8Array | undefined) => {
  let nonce = 0;

  let poisoned = false;

  const next = () => {
    if (poisoned) throw new NoiseError("the link failed an earlier decrypt");

    if (nonce >= Number.MAX_SAFE_INTEGER) throw new NoiseError("the link exhausted its nonces");

    nonce += 1;

    return nonce - 1;
  };

  const encrypt = (ad: Uint8Array, plaintext: Uint8Array): Uint8Array => {
    if (key === undefined) return plaintext;

    const cipher = createCipheriv("aes-256-gcm", key, nonceIv(next()));

    cipher.setAAD(ad);

    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return new Uint8Array(Buffer.concat([body, cipher.getAuthTag()]));
  };

  const decrypt = (ad: Uint8Array, ciphertext: Uint8Array): Uint8Array => {
    if (key === undefined) return ciphertext;

    if (ciphertext.length < TAG_LENGTH) throw new NoiseError("a message is shorter than its tag");

    const decipher = createDecipheriv("aes-256-gcm", key, nonceIv(next()));

    try {
      decipher.setAAD(ad);
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));

      const body = decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH));

      return new Uint8Array(Buffer.concat([body, decipher.final()]));
    } catch {
      poisoned = true;

      throw new NoiseError("a message failed authentication");
    }
  };

  return { encrypt, decrypt };
};

const guard = (data: Uint8Array) => {
  if (data.length > MAX_MESSAGE) throw new NoiseError(`a message is over ${MAX_MESSAGE} bytes`);

  return data;
};

export interface NoiseInitiatorOptions {
  readonly staticKeyPair: KeyPair;
  readonly prologue: Uint8Array;
  /** Fixed ephemeral key, for the published test vectors only. */
  readonly ephemeralKeyPair?: KeyPair;
  /** Handshake payloads, for the published test vectors only; ZDP sends none. */
  readonly payloads?: readonly [Uint8Array, Uint8Array];
}

/** XX as the initiator: `-> e`, `<- e, ee, s, es`, `-> s, se`. */
export const noiseInitiator = (options: NoiseInitiatorOptions): NoiseInitiator => {
  const name = new TextEncoder().encode(PROTOCOL_NAME);

  let h: Uint8Array = Uint8Array.from({ length: 32 }, (_, i) => name[i] ?? 0);

  let ck = h;

  let cipher = makeCipher(undefined);

  const ephemeral = options.ephemeralKeyPair ?? generateKeyPair();

  let started = false;

  let finished = false;

  const mixHash = (data: Uint8Array) => {
    h = sha256(h, data);
  };

  const mixKey = (input: Uint8Array) => {
    const [nextCk, key] = hkdf2(ck, input);

    ck = nextCk;
    cipher = makeCipher(key);
  };

  const encryptAndHash = (plaintext: Uint8Array) => {
    const ciphertext = cipher.encrypt(h, plaintext);

    mixHash(ciphertext);

    return ciphertext;
  };

  const decryptAndHash = (ciphertext: Uint8Array) => {
    const plaintext = cipher.decrypt(h, ciphertext);

    mixHash(ciphertext);

    return plaintext;
  };

  mixHash(options.prologue);

  const start = () => {
    if (started) throw new NoiseError("the handshake already started");

    started = true;
    mixHash(ephemeral.publicKey);

    return new Uint8Array(
      Buffer.concat([ephemeral.publicKey, encryptAndHash(options.payloads?.[0] ?? EMPTY)]),
    );
  };

  const respond = (message: Uint8Array) => {
    if (!started || finished) throw new NoiseError("handshake message 2 arrived out of order");

    finished = true;

    if (message.length < KEY_LENGTH * 2 + TAG_LENGTH * 2 || message.length > MAX_MESSAGE)
      throw new NoiseError("handshake message 2 has the wrong length");

    const remoteEphemeral = message.subarray(0, KEY_LENGTH);

    mixHash(remoteEphemeral);
    mixKey(dh(ephemeral, remoteEphemeral));

    const remoteStatic = decryptAndHash(message.subarray(KEY_LENGTH, KEY_LENGTH * 2 + TAG_LENGTH));

    mixKey(dh(ephemeral, remoteStatic));

    // The hub's payload is empty in ZDP; it is authenticated and dropped.
    decryptAndHash(message.subarray(KEY_LENGTH * 2 + TAG_LENGTH));

    const own = encryptAndHash(options.staticKeyPair.publicKey);

    mixKey(dh(options.staticKeyPair, remoteEphemeral));

    const third = new Uint8Array(
      Buffer.concat([own, encryptAndHash(options.payloads?.[1] ?? EMPTY)]),
    );

    const [sendKey, receiveKey] = hkdf2(ck, EMPTY);

    const send = makeCipher(sendKey);

    const receive = makeCipher(receiveKey);

    return {
      message: third,
      transport: {
        encrypt: (plaintext: Uint8Array) => send.encrypt(EMPTY, guard(plaintext)),
        decrypt: (ciphertext: Uint8Array) => receive.decrypt(EMPTY, guard(ciphertext)),
        remoteStatic: new Uint8Array(remoteStatic),
      },
    };
  };

  return { start, respond };
};
