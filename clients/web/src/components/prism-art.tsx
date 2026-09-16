import heroSmall from "../../../../assets/ziggy-prism/web/prism-hero-wide-768.webp";
import heroLarge from "../../../../assets/ziggy-prism/web/prism-hero-wide-1440.webp";
import tile from "../../../../assets/ziggy-prism/web/prism-tile-square-320.webp";

export function PrismArt({ compact = false }: { readonly compact?: boolean }) {
  return compact ? (
    <img alt="" className="ziggy-brand-image" height={32} src={tile} width={32} />
  ) : (
    <img
      alt=""
      className="ziggy-prism-art"
      height={256}
      sizes="(max-width: 720px) 90vw, 640px"
      src={heroSmall}
      srcSet={`${heroSmall} 768w, ${heroLarge} 1440w`}
      width={768}
    />
  );
}
