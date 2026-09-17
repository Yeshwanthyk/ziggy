import appPath from "../../generated/web-assets/assets/app.js" with { type: "file" };
import heroWide1440Path from "../../generated/web-assets/assets/prism-hero-wide-1440.webp" with { type: "file" };
import heroWide768Path from "../../generated/web-assets/assets/prism-hero-wide-768.webp" with { type: "file" };
import tileSquare320Path from "../../generated/web-assets/assets/prism-tile-square-320.webp" with { type: "file" };
import stylePath from "../../generated/web-assets/assets/index.css" with { type: "file" };
import indexPath from "../../generated/web-assets/index.embed" with { type: "file" };
import prismPath from "../../generated/web-assets/ziggy-prism.webp" with { type: "file" };

const assets = new Map<string, { readonly path: string; readonly contentType: string }>([
  ["/assets/app.js", { path: appPath, contentType: "text/javascript; charset=utf-8" }],
  ["/assets/index.css", { path: stylePath, contentType: "text/css; charset=utf-8" }],
  ["/assets/prism-hero-wide-1440.webp", { path: heroWide1440Path, contentType: "image/webp" }],
  ["/assets/prism-hero-wide-768.webp", { path: heroWide768Path, contentType: "image/webp" }],
  ["/assets/prism-tile-square-320.webp", { path: tileSquare320Path, contentType: "image/webp" }],
  ["/ziggy-prism.webp", { path: prismPath, contentType: "image/webp" }],
]);

export const webAssetResponse = (pathname: string): Response | undefined => {
  if (pathname === "/" || pathname === "/index.html")
    return new Response(Bun.file(indexPath), {
      headers: { "Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8" },
    });
  const asset = assets.get(pathname);

  if (asset === undefined) return undefined;

  return new Response(Bun.file(asset.path), {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": asset.contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
};
