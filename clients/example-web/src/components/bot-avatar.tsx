import { useEffect, useId, useMemo, useState } from "react";

import { blobVariantById, blobVariantForIdentity, type BlobVariantId } from "../lib/blob-catalog";
import { BotEngine, type BotFrame } from "../vendor/bloub/engine";
import { DEMI_VIEWBOX, RAYON } from "../vendor/bloub/repere";

export interface BotAvatarProps {
  name: string;
  identity?: string;
  variantId?: BlobVariantId;
  active?: boolean;
  size?: number;
  className?: string;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

export function BotAvatar({
  name,
  identity = name,
  variantId,
  active = false,
  size = 40,
  className,
}: BotAvatarProps) {
  const reducedMotion = useReducedMotion();
  const animated = !reducedMotion;
  const variant = useMemo(
    () => (variantId ? blobVariantById(variantId) : undefined) ?? blobVariantForIdentity(identity),
    [identity, variantId],
  );
  const engine = useMemo(
    () => new BotEngine(RAYON, active ? "thinking" : "idle", variant.shape.radii),
    [active, variant.shape],
  );
  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(0));
  const reactId = useId();
  const maskId = `bloub-mask-${reactId.replaceAll(":", "")}`;

  useEffect(() => {
    setFrame(engine.sample(0));
    if (!animated) return;

    let animationFrame = 0;
    let elapsedSeconds = 0;
    let segmentStartedAt: number | undefined;
    let lastRenderedAt = -Infinity;

    const tick = (now: number) => {
      segmentStartedAt ??= now;
      if (now - lastRenderedAt >= 1000 / 30) {
        elapsedSeconds += (now - segmentStartedAt) / 1000;
        segmentStartedAt = now;
        lastRenderedAt = now;
        setFrame(engine.sample(elapsedSeconds));
      }
      animationFrame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (document.visibilityState === "hidden" || animationFrame !== 0) return;
      segmentStartedAt = undefined;
      animationFrame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (animationFrame === 0) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      segmentStartedAt = undefined;
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    start();
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stop();
    };
  }, [animated, engine]);

  const ink = variant.color.hex;

  return (
    <svg
      aria-label={`${name} assistant${active ? " is thinking" : ""}`}
      className={className}
      height={size}
      role="img"
      viewBox={`${-DEMI_VIEWBOX} ${-DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`}
      width={size}
    >
      <defs>
        <mask
          height={DEMI_VIEWBOX * 2}
          id={maskId}
          maskUnits="userSpaceOnUse"
          width={DEMI_VIEWBOX * 2}
          x={-DEMI_VIEWBOX}
          y={-DEMI_VIEWBOX}
        >
          <path d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, index) => (
            <path d={eye.d} fill="#000" key={index} opacity={eye.alpha} transform={eye.matrix} />
          ))}
          {frame.notch ? (
            <circle cx={frame.notch.x} cy={frame.notch.y} fill="#000" r={frame.notch.r} />
          ) : null}
        </mask>
        {frame.arcs.map((arc) => (
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id={`${maskId}-${arc.id}`}
            key={arc.id}
            x1={arc.grad.x1}
            x2={arc.grad.x2}
            y1={arc.grad.y1}
            y2={arc.grad.y2}
          >
            {arc.grad.stops.map((stop, index) => (
              <stop
                key={stop}
                offset={index / Math.max(1, arc.grad.stops.length - 1)}
                stopColor={stop}
              />
            ))}
          </linearGradient>
        ))}
      </defs>

      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            d={arc.back}
            key={`back-${arc.id}`}
            opacity={arc.opacity}
            stroke={`url(#${maskId}-${arc.id})`}
            strokeWidth={arc.width}
          />
        ))}
      </g>

      {frame.dotsBehind ? <Dots dots={frame.dots} fill={ink} /> : null}

      <g opacity={frame.bodyAlpha}>
        <g mask={`url(#${maskId})`}>
          <rect
            fill={ink}
            height={DEMI_VIEWBOX * 2}
            width={DEMI_VIEWBOX * 2}
            x={-DEMI_VIEWBOX}
            y={-DEMI_VIEWBOX}
          />
        </g>
        {variant.color.id === "creme" ? (
          <g fill="#746e62">
            <path d={frame.bodyPath} fill="none" stroke="#a39c90" strokeWidth={2} />
            {frame.eyes.map((eye, index) => (
              <path d={eye.d} key={index} opacity={eye.alpha} transform={eye.matrix} />
            ))}
          </g>
        ) : null}
      </g>

      {!frame.dotsBehind ? <Dots dots={frame.dots} fill={ink} /> : null}

      {frame.notif ? (
        <circle cx={frame.notif.x} cy={frame.notif.y} fill="#1688f8" r={frame.notif.r} />
      ) : null}

      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            d={arc.front}
            key={`front-${arc.id}`}
            opacity={arc.opacity}
            stroke={`url(#${maskId}-${arc.id})`}
            strokeWidth={arc.width}
          />
        ))}
      </g>
    </svg>
  );
}

function Dots({ dots, fill }: { dots: BotFrame["dots"]; fill: string }) {
  return (
    <g>
      {dots.map((dot, index) => {
        const dotFill = dot.color ?? fill;
        return dot.d ? (
          <path
            d={dot.d}
            fill={dotFill}
            key={index}
            opacity={dot.opacity}
            transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`}
          />
        ) : (
          <circle
            cx={dot.x}
            cy={dot.y}
            fill={dotFill}
            key={index}
            opacity={dot.opacity}
            r={dot.r}
          />
        );
      })}
    </g>
  );
}
