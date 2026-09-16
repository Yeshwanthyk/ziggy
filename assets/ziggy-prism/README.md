# Ziggy prism assets

Quiet illustrated glass prism at blue hour. These four approved compositions share the same subject and visual treatment.

| Composition | Master size | WebP widths |
| --- | --- | --- |
| Wide hero | 2172 × 724 | 768, 1440, 2172 |
| Landscape card | 1536 × 1024 | 480, 960, 1536 |
| Square tile | 1254 × 1254 | 320, 640, 1254 |
| Mobile portrait | 1024 × 1536 | 480, 768, 1024 |

Use `web/` for delivery and responsive `srcset` selection. Select a source width close to the rendered CSS width multiplied by device pixel ratio. Preserve each composition's aspect ratio; the wide hero leaves room for copy on the left. Use the portrait composition for tall mobile placements rather than cropping the hero.

`originals/` preserves the original generated PNGs byte-for-byte at native resolution, without upscaling. `prompts.md` records the built-in imagegen prompts. `manifest.json` records each web asset's dimensions and byte size.

WebP encoding: cwebp 1.6.0, quality 90, method 6, sharp YUV conversion. Smaller variants use cwebp's proportional resize. Full-size WebPs total 752,768 bytes versus 9,113,323 bytes for PNG masters, a 91.7% reduction. Compression is lossy; use the masters for future editing.

Suggested descriptive alt text: “An illustrated glass prism on a windowsill sends a fine beam of light into the blue evening.” Use empty alt text when the image is purely decorative.

Validation: all 12 WebPs decoded successfully and dimensions were inspected; all four copied PNGs match their sources byte-for-byte. No application integration is included.
