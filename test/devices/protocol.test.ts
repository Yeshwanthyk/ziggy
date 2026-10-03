/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { expect, test } from "bun:test";
import {
  ZdpErrorCode,
  ZdpInvalid,
  decodeZdpFrame,
  decodeZdpMessage,
  decodeZdpPairing,
  decodeZdpResult,
  encodeZdpChunk,
  encodeZdpMessage,
  encodeZdpMessageFrame,
  formatZdpPairing,
  type ZdpRequestMethod,
} from "ziggy/devices/index";

const spec = readFileSync(join(import.meta.dir, "../../docs/devices/protocol.md"), "utf8");

/** Every fenced example the spec marks `json zdp`, with its label. */
const examples = [...spec.matchAll(/^```json zdp(?: (\S+))?\n(.*)\n```$/gm)].map(
  ([, label = "message", text = ""]) => ({ label, text }),
);

const requestMethods: ReadonlyArray<ZdpRequestMethod> = [
  "device.pair",
  "device.hello",
  "ping",
  "tools/list",
  "tools/call",
  "chat.send",
  "chat.abort",
];

test("the spec shows every method", () => {
  const shown = new Set(
    examples.flatMap(({ text }) =>
      [...text.matchAll(/"method":"([^"]+)"/g)].map(([, method]) => method),
    ),
  );

  expect([...shown].toSorted()).toEqual([
    "audio.play",
    "chat.abort",
    "chat.delta",
    "chat.done",
    "chat.error",
    "chat.send",
    "chat.status",
    "chat.transcript",
    "device.hello",
    "device.pair",
    "display.show",
    "notifications/tools/list_changed",
    "notify",
    "ping",
    "tools/call",
    "tools/list",
  ]);
});

test("every spec example decodes strictly and encodes back to the same text", () => {
  const outcomes = Effect.runSync(
    Effect.forEach(examples, ({ label, text }) =>
      Effect.gen(function* () {
        const message = yield* decodeZdpMessage(text);

        const encoded = yield* encodeZdpMessage(message);

        const method = label.startsWith("result=") ? label.slice("result=".length) : undefined;

        const requestMethod = requestMethods.find((candidate) => candidate === method);

        const result =
          requestMethod !== undefined && "result" in message
            ? yield* decodeZdpResult(requestMethod, message.result)
            : undefined;

        return { label, roundTrips: encoded === text, resultMethod: result?.method ?? "none" };
      }),
    ),
  );

  expect<ReadonlyArray<{ label: string; roundTrips: boolean; resultMethod: string }>>(
    outcomes,
  ).toEqual(
    examples.map(({ label }) => ({
      label,
      roundTrips: true,
      resultMethod: label.startsWith("result=") ? label.slice("result=".length) : "none",
    })),
  );
});

test("a bad message fails with the JSON-RPC code to answer it with", () => {
  const codes = Effect.runSync(
    Effect.forEach(
      [
        "{not json",
        `{"id":1,"method":"ping"}`,
        `{"jsonrpc":"2.0","id":1,"method":"device.reboot"}`,
        `{"jsonrpc":"2.0","id":1,"method":"chat.send","params":{"text":"hi","mood":"glad"}}`,
        `{"jsonrpc":"2.0","method":"display.show","params":{"text":"hi","image":{"stream":2,"format":"jpeg","width":1,"height":1}}}`,
        `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Lights-Set"}}`,
      ],
      (text) =>
        decodeZdpMessage(text).pipe(
          Effect.map(() => 0),
          Effect.catchTag("ZdpInvalid", (failure) => Effect.succeed(failure.code)),
        ),
    ),
  );

  expect(codes).toEqual([
    ZdpErrorCode.parse,
    ZdpErrorCode.invalidRequest,
    ZdpErrorCode.methodNotFound,
    ZdpErrorCode.invalidParams,
    ZdpErrorCode.invalidParams,
    ZdpErrorCode.invalidParams,
  ]);
});

test("frames carry a JSON message or a stream chunk, and nothing else", () => {
  const data = Uint8Array.of(1, 2, 3);

  const frames = Effect.runSync(
    Effect.gen(function* () {
      const message = yield* decodeZdpFrame(
        yield* encodeZdpMessageFrame({ jsonrpc: "2.0", id: 7, method: "ping" }),
      );

      const chunk = yield* decodeZdpFrame(encodeZdpChunk(513, true, data));

      const other = yield* Effect.exit(decodeZdpFrame(Uint8Array.of(0x02, 0, 1, 0)));

      return { message, chunk, other };
    }),
  );

  expect(frames).toEqual({
    message: { kind: "message", message: { jsonrpc: "2.0", id: 7, method: "ping" } },
    chunk: { kind: "chunk", stream: 513, last: true, data },
    other: Exit.fail(new ZdpInvalid({ code: ZdpErrorCode.parse, message: "not a ZDP frame" })),
  });
});

test("a pairing URI round-trips, and its code ignores case and dashes", () => {
  const pairing = { host: "192.168.1.20", port: 7316, code: "K7QM3XW9TB", key: new Uint8Array(32) };

  const uri = formatZdpPairing(pairing);

  const decoded = Effect.runSync(
    Effect.all([
      decodeZdpPairing(uri),
      decodeZdpPairing(uri.replace("K7QM-3XW9-TB", "k7qm3xw9tb")),
      Effect.exit(decodeZdpPairing(uri.replace("K7QM-3XW9-TB", "K7QM-3XW9-TU"))),
    ]),
  );

  expect(uri).toBe(
    "zdp://192.168.1.20:7316/pair?code=K7QM-3XW9-TB&key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  expect(decoded.slice(0, 2)).toEqual([pairing, pairing]);
  expect(Exit.isFailure(decoded[2])).toBe(true);
});
