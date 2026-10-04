/**
 * Pictures for small screens: decodes a PNG or JPEG, fits it inside the device's screen without
 * cropping, and encodes it in a format the device listed. The hub streams the result as chunks.
 */
import { inflateSync } from "node:zlib";
import { Effect, Schema } from "effect";
import * as Jpeg from "jpeg-js";

export class ImageUnreadable extends Schema.TaggedErrorClass<ImageUnreadable>()("ImageUnreadable", {
  message: Schema.String,
}) {}

/** Width × height pixels, 4 bytes each (R, G, B, A), row-major. */
export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export type ScreenFormat = "rgb565" | "jpeg";

/** A frame encoded for the device, at exactly the screen's size. */
export interface ScreenImage {
  readonly format: ScreenFormat;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Larger sources are refused before decoding, so a hostile file cannot exhaust memory. */
const MAX_PIXELS = 40_000_000;

const JPEG_QUALITY = 80;

const unreadable = (message: string) => Effect.fail(new ImageUnreadable({ message }));

// PNG (RFC 2083): non-interlaced, every colour type and bit depth.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Samples per pixel, by colour type: grey, -, RGB, palette, grey + alpha, -, RGBA. */
const CHANNELS = [1, undefined, 3, 1, 2, undefined, 4];

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly colorType: number;
  readonly interlace: number;
}

interface PngChunks {
  readonly header: PngHeader;
  readonly palette: Uint8Array | undefined;
  readonly transparency: Uint8Array | undefined;
  readonly compressed: Uint8Array;
}

const isPng = (bytes: Uint8Array) => PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

const isJpeg = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8;

const readChunks = (bytes: Uint8Array): Effect.Effect<PngChunks, ImageUnreadable> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const idat: Array<Uint8Array> = [];

  let header: PngHeader | undefined;

  let palette: Uint8Array | undefined;

  let transparency: Uint8Array | undefined;

  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);

    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));

    const data = bytes.subarray(offset + 8, offset + 8 + length);

    if (data.length !== length) return unreadable("the PNG is cut short");

    if (type === "IHDR" && length >= 13)
      header = {
        width: view.getUint32(offset + 8),
        height: view.getUint32(offset + 12),
        depth: data[8] ?? 0,
        colorType: data[9] ?? 0,
        interlace: data[12] ?? 0,
      };

    if (type === "PLTE") palette = data;

    if (type === "tRNS") transparency = data;

    if (type === "IDAT") idat.push(data);

    if (type === "IEND") break;

    offset += 12 + length;
  }

  if (header === undefined) return unreadable("the PNG has no header");

  return Effect.succeed({
    header,
    palette,
    transparency,
    compressed: new Uint8Array(Buffer.concat(idat)),
  });
};

const paeth = (left: number, up: number, upLeft: number) => {
  const estimate = left + up - upLeft;

  const toLeft = Math.abs(estimate - left);

  const toUp = Math.abs(estimate - up);

  const toUpLeft = Math.abs(estimate - upLeft);

  if (toLeft <= toUp && toLeft <= toUpLeft) return left;

  return toUp <= toUpLeft ? up : upLeft;
};

/** Undoes the per-row filters in place; returns the rows without their filter bytes. */
const unfilter = (
  raw: Uint8Array,
  rowBytes: number,
  height: number,
  pixelBytes: number,
): Effect.Effect<Uint8Array, ImageUnreadable> => {
  if (raw.length < (rowBytes + 1) * height) return unreadable("the PNG's pixel data is cut short");

  const out = new Uint8Array(rowBytes * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)] ?? 0;

    const source = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));

    const row = y * rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const left = x >= pixelBytes ? (out[row + x - pixelBytes] ?? 0) : 0;

      const up = y > 0 ? (out[row - rowBytes + x] ?? 0) : 0;

      const upLeft = y > 0 && x >= pixelBytes ? (out[row - rowBytes + x - pixelBytes] ?? 0) : 0;

      const predicted =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth(left, up, upLeft)
                : 0;

      if (filter > 4) return unreadable(`the PNG uses an unknown filter ${filter}`);

      out[row + x] = ((source[x] ?? 0) + predicted) & 0xff;
    }
  }

  return Effect.succeed(out);
};

const decodePng = (bytes: Uint8Array): Effect.Effect<Rgba, ImageUnreadable> =>
  Effect.gen(function* () {
    const { header, palette, transparency, compressed } = yield* readChunks(bytes);

    const { width, height, depth, colorType } = header;

    const channels = CHANNELS[colorType];

    if (channels === undefined)
      return yield* unreadable(`the PNG colour type ${colorType} is unknown`);

    if (header.interlace !== 0) return yield* unreadable("interlaced PNGs are not supported");

    if (width === 0 || height === 0 || width * height > MAX_PIXELS)
      return yield* unreadable(`the PNG is ${width}×${height}, too large to show`);

    if (colorType === 3 && palette === undefined)
      return yield* unreadable("the PNG has no palette");

    const raw = yield* Effect.try({
      try: () => new Uint8Array(inflateSync(compressed)),
      catch: () => new ImageUnreadable({ message: "the PNG's pixel data is corrupt" }),
    });

    const bitsPerPixel = channels * depth;

    const rowBytes = Math.ceil((width * bitsPerPixel) / 8);

    const rows = yield* unfilter(raw, rowBytes, height, Math.max(1, bitsPerPixel >> 3));

    /** The `index`-th sample of row `y`, scaled to 0–255. */
    const sample = (y: number, index: number): number => {
      if (depth === 8) return rows[y * rowBytes + index] ?? 0;

      if (depth === 16) return rows[y * rowBytes + index * 2] ?? 0;

      const bit = index * depth;

      const byte = rows[y * rowBytes + (bit >> 3)] ?? 0;

      const value = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);

      return colorType === 3 ? value : Math.round((value * 255) / ((1 << depth) - 1));
    };

    /** A palette index's raw value, never scaled. */
    const index = (y: number, x: number) =>
      depth === 8 ? (rows[y * rowBytes + x] ?? 0) : sample(y, x);

    const data = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;

        const pixel = (channel: number) => sample(y, x * channels + channel);

        const [r, g, b, a] =
          colorType === 0
            ? [pixel(0), pixel(0), pixel(0), 255]
            : colorType === 2
              ? [pixel(0), pixel(1), pixel(2), 255]
              : colorType === 4
                ? [pixel(0), pixel(0), pixel(0), pixel(1)]
                : colorType === 6
                  ? [pixel(0), pixel(1), pixel(2), pixel(3)]
                  : [
                      palette?.[index(y, x) * 3] ?? 0,
                      palette?.[index(y, x) * 3 + 1] ?? 0,
                      palette?.[index(y, x) * 3 + 2] ?? 0,
                      transparency?.[index(y, x)] ?? 255,
                    ];

        data[at] = r;
        data[at + 1] = g;
        data[at + 2] = b;
        data[at + 3] = a;
      }

    return { width, height, data };
  });

const decodeJpeg = (bytes: Uint8Array): Effect.Effect<Rgba, ImageUnreadable> =>
  Effect.try({
    try: () =>
      Jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: MAX_PIXELS / 1_000_000,
        maxMemoryUsageInMB: 512,
      }),
    catch: () => new ImageUnreadable({ message: "the JPEG is corrupt or too large" }),
  }).pipe(Effect.map(({ width, height, data }) => ({ width, height, data })));

/** Decodes a PNG or JPEG file's bytes. */
export const decodeImage = (bytes: Uint8Array): Effect.Effect<Rgba, ImageUnreadable> =>
  isPng(bytes)
    ? decodePng(bytes)
    : isJpeg(bytes)
      ? decodeJpeg(bytes)
      : unreadable("only PNG and JPEG images can be shown");

/**
 * The image centred on a black `width` × `height` frame: shrunk to fit if larger, never enlarged
 * and never cropped. Shrinking averages each output pixel's footprint; alpha blends onto black.
 */
export const fitImage = (image: Rgba, width: number, height: number): Rgba => {
  const scale = Math.min(1, width / image.width, height / image.height);

  const fittedWidth = Math.max(1, Math.round(image.width * scale));

  const fittedHeight = Math.max(1, Math.round(image.height * scale));

  const left = Math.floor((width - fittedWidth) / 2);

  const top = Math.floor((height - fittedHeight) / 2);

  const data = new Uint8Array(width * height * 4);

  for (let index = 3; index < data.length; index += 4) data[index] = 255;

  for (let y = 0; y < fittedHeight; y++) {
    const y0 = Math.floor((y * image.height) / fittedHeight);

    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / fittedHeight));

    for (let x = 0; x < fittedWidth; x++) {
      const x0 = Math.floor((x * image.width) / fittedWidth);

      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / fittedWidth));

      let red = 0;

      let green = 0;

      let blue = 0;

      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * image.width + sx) * 4;

          const alpha = image.data[at + 3] ?? 255;

          red += (image.data[at] ?? 0) * alpha;
          green += (image.data[at + 1] ?? 0) * alpha;
          blue += (image.data[at + 2] ?? 0) * alpha;
        }

      const weight = (y1 - y0) * (x1 - x0) * 255;

      const at = ((top + y) * width + left + x) * 4;

      data[at] = Math.round(red / weight);
      data[at + 1] = Math.round(green / weight);
      data[at + 2] = Math.round(blue / weight);
    }
  }

  return { width, height, data };
};

/** 2 bytes per pixel, little-endian: red in the top 5 bits, green 6, blue 5. */
export const encodeRgb565 = (image: Rgba): Uint8Array => {
  const out = new Uint8Array(image.width * image.height * 2);

  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    const r = image.data[pixel * 4] ?? 0;

    const g = image.data[pixel * 4 + 1] ?? 0;

    const b = image.data[pixel * 4 + 2] ?? 0;

    const value = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

    out[pixel * 2] = value & 0xff;
    out[pixel * 2 + 1] = value >> 8;
  }

  return out;
};

/** The image fitted to the screen, in rgb565 when the device takes it, otherwise jpeg. */
export const screenImage = (
  bytes: Uint8Array,
  screen: {
    readonly width: number;
    readonly height: number;
    readonly formats: ReadonlyArray<ScreenFormat>;
  },
): Effect.Effect<ScreenImage, ImageUnreadable> =>
  decodeImage(bytes).pipe(
    Effect.map((image) => fitImage(image, screen.width, screen.height)),
    Effect.map((fitted) =>
      screen.formats.includes("rgb565")
        ? {
            format: "rgb565" as const,
            width: fitted.width,
            height: fitted.height,
            data: encodeRgb565(fitted),
          }
        : {
            format: "jpeg" as const,
            width: fitted.width,
            height: fitted.height,
            data: new Uint8Array(Jpeg.encode(fitted, JPEG_QUALITY).data),
          },
    ),
  );
