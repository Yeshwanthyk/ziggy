import { useEffect, useId, useMemo, useState } from "react";

import { BotEngine, type BotFrame } from "../vendor/bloub/engine";
import { DEMI_VIEWBOX, RAYON } from "../vendor/bloub/repere";
import { COLORS, SHAPES } from "../vendor/bloub/skins";

export interface BotAvatarProps {
  name: string;
  active?: boolean;
  size?: number;
  className?: string;
}

function hashIdentity(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
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

export function BotAvatar({ name, active = false, size = 40, className }: BotAvatarProps) {
  const reducedMotion = useReducedMotion();
  const animated = active && !reducedMotion;
  const identity = useMemo(() => hashIdentity(name), [name]);
  const shape = SHAPES[identity % SHAPES.length] ?? SHAPES[0];
  const color = COLORS[(identity >>> 8) % COLORS.length] ?? COLORS[0];
  const engine = useMemo(
    () => new BotEngine(RAYON, animated ? "thinking" : "idle", shape?.radii ?? null),
    [animated, shape],
  );
  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(0));
  const reactId = useId();
  const maskId = `bloub-mask-${reactId.replaceAll(":", "")}`;

  useEffect(() => {
    setFrame(engine.sample(0));
    if (!animated) return;

    let animationFrame = 0;
    let startedAt: number | undefined;
    const tick = (now: number) => {
      startedAt ??= now;
      setFrame(engine.sample((now - startedAt) / 1000));
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [animated, engine]);

  const ink = color?.hex ?? "#0a0a0c";

  return (
    <svg
      aria-label={`${name} assistant${animated ? " is thinking" : ""}`}
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
