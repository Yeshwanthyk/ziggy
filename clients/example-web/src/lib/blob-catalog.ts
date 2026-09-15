import {
  COLORS,
  SHAPES,
  type BotColor,
  type BotShape,
  type ColorId,
  type ShapeId,
} from "../vendor/bloub/skins";

export type BlobVariantId = `${ShapeId}-${ColorId}`;

export interface BlobVariant {
  id: BlobVariantId;
  shape: BotShape;
  color: BotColor;
}

function createBlobVariant(shape: BotShape, color: BotColor): BlobVariant {
  const id: BlobVariantId = `${shape.id}-${color.id}`;
  return { id, shape, color };
}

export const BLOB_CATALOG: readonly BlobVariant[] = SHAPES.flatMap((shape) =>
  COLORS.map((color) => createBlobVariant(shape, color)),
);

const BLOB_BY_ID = new Map<BlobVariantId, BlobVariant>(
  BLOB_CATALOG.map((variant) => [variant.id, variant]),
);

export function normalizeBlobIdentity(identity: string): string {
  return identity.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function blobVariantForIdentity(identity: string): BlobVariant {
  const normalized = normalizeBlobIdentity(identity);
  let hash = 0x811c9dc5;
  for (const character of normalized) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  const variant = BLOB_CATALOG[(hash >>> 0) % BLOB_CATALOG.length];
  if (!variant) throw new RangeError("Blob catalog must contain at least one variant");
  return variant;
}

export function blobVariantById(id: BlobVariantId): BlobVariant | undefined {
  return BLOB_BY_ID.get(id);
}
