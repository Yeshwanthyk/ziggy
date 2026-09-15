import { describe, expect, it } from "vitest";

import { COLORS, SHAPES } from "../vendor/bloub/skins";
import {
  BLOB_CATALOG,
  blobVariantById,
  blobVariantForIdentity,
  normalizeBlobIdentity,
} from "./blob-catalog";

describe("blob catalog", () => {
  it("exposes every shape and color pair under a stable unique ID", () => {
    expect(BLOB_CATALOG).toHaveLength(SHAPES.length * COLORS.length);
    expect(new Set(BLOB_CATALOG.map(({ id }) => id)).size).toBe(BLOB_CATALOG.length);

    for (const shape of SHAPES) {
      for (const color of COLORS) {
        const id = `${shape.id}-${color.id}` as const;
        expect(blobVariantById(id)).toMatchObject({ id, shape, color });
      }
    }
  });

  it("normalizes display variations before deterministic assignment", () => {
    expect(normalizeBlobIdentity("  ADA\tLOVELACE  ")).toBe("ada lovelace");
    expect(blobVariantForIdentity("Ada")).toBe(blobVariantForIdentity("ada"));
    expect(blobVariantForIdentity("Ａｄａ")).toBe(blobVariantForIdentity("ada"));
    expect(blobVariantForIdentity("Ada   Lovelace")).toBe(blobVariantForIdentity(" ada lovelace "));
  });
});
