import { useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { BLOB_CATALOG } from "@/lib/blob-catalog";
import { COLORS } from "@/vendor/bloub/skins";

const shapeNames = {
  cercle: "Round",
  galet: "Pebble",
  squircle: "Squircle",
  capsule: "Capsule",
  triangle: "Triangle",
  hexagone: "Hexagon",
  nuage: "Cloud",
  goutte: "Drop",
};
const colorNames = {
  encre: "Ink",
  brun: "Brown",
  rouge: "Red",
  orange: "Orange",
  ambre: "Amber",
  vert: "Green",
  turquoise: "Turquoise",
  bleu: "Blue",
  violet: "Violet",
  rose: "Pink",
  gris: "Gray",
  creme: "Cream",
};

export function BlobCollection() {
  const [expanded, setExpanded] = useState(false);
  const [colorId, setColorId] = useState("bleu");

  return (
    <details
      className="blob-collection"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>Blob collection · {BLOB_CATALOG.length} identities</summary>
      {expanded ? (
        <div className="blob-collection-body">
          <p className="settings-muted">
            New bots automatically get a stable shape and color from this collection. Their identity
            stays the same in the sidebar and chat.
          </p>
          <div className="blob-colors" role="group" aria-label="Preview blob colors">
            {COLORS.map((color) => (
              <button
                aria-label={`Preview ${colorNames[color.id]} blobs`}
                aria-pressed={color.id === colorId}
                key={color.id}
                onClick={() => setColorId(color.id)}
                type="button"
                title={colorNames[color.id]}
              >
                <span style={{ backgroundColor: color.hex }} />
              </button>
            ))}
          </div>
          <div className="blob-grid">
            {BLOB_CATALOG.filter((variant) => variant.color.id === colorId).map((variant) => (
              <div className="blob-preview" key={variant.id}>
                <BotAvatar name={variant.id} size={64} variantId={variant.id} />
                <span>{shapeNames[variant.shape.id]}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </details>
  );
}
