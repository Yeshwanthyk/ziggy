/**
 * One-off proof that Ziggy's Noise_XX talks to Muse's: runs Muse's Python implementation in each
 * role against `src/platform/noise.ts`. CI keeps the published vectors instead
 * (`noise.test.ts`); run this after touching either side.
 *
 *   bun test/platform/noise-interop.ts /path/to/muse-gadget-sdk
 */
/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- a manual proof script is its own entrypoint */
import { join } from "node:path";
import { Effect } from "effect";
import { generateNoiseKeyPair, noiseXX } from "ziggy/platform/noise";

const muse = process.argv[2];

if (muse === undefined) {
  console.error("usage: bun test/platform/noise-interop.ts <muse-gadget-sdk>");
  process.exit(2);
}

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

const bytes = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

const run = async (museRole: "initiator" | "responder") => {
  const child = Bun.spawn(
    [
      "uv",
      "run",
      "-q",
      "--with",
      "cryptography",
      "python",
      join(import.meta.dir, "noise-interop.py"),
      muse,
      museRole,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );

  const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();

  let buffered = "";

  const recv = async () => {
    while (!buffered.includes("\n")) {
      const { value, done } = await lines.read();

      if (done) return new Uint8Array(0);

      buffered += value;
    }

    const [line = "", ...rest] = buffered.split("\n");

    buffered = rest.join("\n");

    return bytes(line);
  };

  const send = (data: Uint8Array) => {
    child.stdin.write(`${hex(data)}\n`);
    child.stdin.flush();
  };

  const ours = noiseXX({
    role: museRole === "initiator" ? "responder" : "initiator",
    staticKeyPair: generateNoiseKeyPair(),
  });

  if (museRole === "initiator") {
    await Effect.runPromise(ours.read(await recv()));
    send(await Effect.runPromise(ours.write()));
    await Effect.runPromise(ours.read(await recv()));
  } else {
    send(await Effect.runPromise(ours.write()));
    await Effect.runPromise(ours.read(await recv()));
    send(await Effect.runPromise(ours.write()));
  }

  const session = await Effect.runPromise(ours.finish);
  const museHash = await recv();

  send(await Effect.runPromise(session.send(new TextEncoder().encode("hello from ziggy"))));

  const reply = new TextDecoder().decode(await Effect.runPromise(session.receive(await recv())));

  await child.exited;

  const ok =
    hex(museHash) === hex(session.handshakeHash) && reply === "muse heard: hello from ziggy";

  console.log(`muse ${museRole}: hash ${ok ? "equal" : "DIFFERENT"}, reply "${reply}"`);

  return ok;
};

const results = [await run("initiator"), await run("responder")];

process.exit(results.every(Boolean) ? 0 : 1);
