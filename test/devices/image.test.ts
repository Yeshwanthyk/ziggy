/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests drive Ziggy through the Effect boundary. */
// Fixtures in images/ were written by Pillow, with Pillow's own RGBA decode beside each one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import * as Jpeg from "jpeg-js";
import { decodeImage, encodeRgb565, fitImage, type Rgba, screenImage } from "ziggy/devices/index";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dir, "images", name)));

const decode = (bytes: Uint8Array) => Effect.runSync(decodeImage(bytes));

const largestDifference = (left: Uint8Array, right: Uint8Array) =>
  left.reduce(
    (largest, value, index) => Math.max(largest, Math.abs(value - (right[index] ?? 0))),
    0,
  );

const solid = (
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): Rgba => ({
  width,
  height,
  data: new Uint8Array(Array.from({ length: width * height }, () => rgba).flat()),
});

const pixel = (image: Rgba, x: number, y: number) => [
  ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
];

test.each(["rgba8", "rgb8", "grey8", "greyalpha8", "grey1", "grey16", "palette8", "palette4"])(
  "decodes %s.png exactly as Pillow does",
  (name) => {
    const image = decode(fixture(`${name}.png`));

    expect({ width: image.width, height: image.height }).toEqual({ width: 9, height: 7 });
    expect([...image.data]).toEqual([...fixture(`${name}.rgba`)]);
  },
);

test("decodes a JPEG within rounding of Pillow", () => {
  const image = decode(fixture("photo.jpg"));

  expect({ width: image.width, height: image.height }).toEqual({ width: 32, height: 24 });
  expect(largestDifference(image.data, fixture("photo.rgba"))).toBeLessThanOrEqual(4);
});

test("refuses what is not a PNG or JPEG", () => {
  expect(Effect.runSync(Effect.flip(decodeImage(new TextEncoder().encode("hello"))))).toMatchObject(
    {
      message: "only PNG and JPEG images can be shown",
    },
  );
});

test("a larger image shrinks to fit, letterboxed and never cropped", () => {
  // A 1000×100 white bar with red end columns, on a 320×240 screen: 320×32, centred.
  const bar = solid(1000, 100, [255, 255, 255, 255]);

  for (let y = 0; y < 100; y++)
    for (const x of [0, 1, 2, 3, 996, 997, 998, 999])
      bar.data.set([255, 0, 0, 255], (y * 1000 + x) * 4);

  const fitted = fitImage(bar, 320, 240);

  expect({ width: fitted.width, height: fitted.height }).toEqual({ width: 320, height: 240 });
  expect(pixel(fitted, 160, 103)).toEqual([0, 0, 0, 255]);
  expect(pixel(fitted, 160, 104)).toEqual([255, 255, 255, 255]);
  expect(pixel(fitted, 160, 135)).toEqual([255, 255, 255, 255]);
  expect(pixel(fitted, 160, 136)).toEqual([0, 0, 0, 255]);
  expect(pixel(fitted, 0, 120)).toEqual([255, 0, 0, 255]);
  expect(pixel(fitted, 319, 120)).toEqual([255, 0, 0, 255]);
});

test("a smaller image is centred, not enlarged; transparency is black", () => {
  const fitted = fitImage(solid(100, 50, [0, 255, 0, 128]), 320, 240);

  expect(pixel(fitted, 109, 120)).toEqual([0, 0, 0, 255]);
  expect(pixel(fitted, 110, 120)).toEqual([0, 128, 0, 255]);
  expect(pixel(fitted, 209, 120)).toEqual([0, 128, 0, 255]);
  expect(pixel(fitted, 210, 120)).toEqual([0, 0, 0, 255]);
});

test("rgb565 is little-endian, red in the top bits", () => {
  expect([...encodeRgb565(solid(1, 1, [255, 0, 0, 255]))]).toEqual([0x00, 0xf8]);
  expect([...encodeRgb565(solid(1, 1, [0, 255, 0, 255]))]).toEqual([0xe0, 0x07]);
  expect([...encodeRgb565(solid(1, 1, [0, 0, 255, 255]))]).toEqual([0x1f, 0x00]);
});

test("the screen's listed formats pick rgb565 first, else jpeg at the screen's size", () => {
  const png = fixture("rgb8.png");

  const raw = Effect.runSync(
    screenImage(png, { width: 32, height: 24, formats: ["jpeg", "rgb565"] }),
  );

  const jpeg = Effect.runSync(screenImage(png, { width: 32, height: 24, formats: ["jpeg"] }));

  expect({ format: raw.format, bytes: raw.data.length }).toEqual({
    format: "rgb565",
    bytes: 32 * 24 * 2,
  });
  expect(jpeg.format).toBe("jpeg");
  expect(Jpeg.decode(jpeg.data, { useTArray: true })).toMatchObject({ width: 32, height: 24 });
});
