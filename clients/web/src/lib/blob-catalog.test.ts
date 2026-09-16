import { describe, expect, it } from "vitest";

import { COLORS, SHAPES } from "../vendor/bloub/skins";
import {
  AUTOMATIC_BLOB_VARIANTS,
  BLOB_CATALOG,
  blobPhaseForIdentity,
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
    expect(blobPhaseForIdentity("Ada")).toBe(blobPhaseForIdentity("ada"));
  });

  it("uses compact shapes and saturated colors for automatic assignments", () => {
    expect(AUTOMATIC_BLOB_VARIANTS).toHaveLength(24);
    expect(new Set(AUTOMATIC_BLOB_VARIANTS.map(({ shape }) => shape.id))).toEqual(
      new Set(["cercle", "galet", "squircle", "hexagone"]),
    );
    expect(new Set(AUTOMATIC_BLOB_VARIANTS.map(({ color }) => color.id))).toEqual(
      new Set(["rouge", "orange", "vert", "turquoise", "bleu", "violet"]),
    );
    for (const name of ["Ada", "Grace", "Linus", "Margaret", "Ken", "Barbara"]) {
      expect(AUTOMATIC_BLOB_VARIANTS).toContain(blobVariantForIdentity(name));
    }
  });
});
