import * as React from "react";

import { cn } from "@/lib/utils";
import "./controls.css";

interface SegmentedOption<Value extends string> {
  value: Value;
  label: React.ReactNode;
  /** Accessible name when it should differ from the visible label. */
  ariaLabel?: string;
  disabled?: boolean;
  title?: string;
}

interface SegmentedControlProps<Value extends string> {
  "aria-label": string;
  className?: string;
  disabled?: boolean;
  name?: string;
  onValueChange: (value: Value) => void;
  options: readonly SegmentedOption<Value>[];
  value: Value | undefined;
}

const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * A radiogroup of native radios with a single thumb that slides between equal-width
 * segments. Pointer changes animate; keyboard changes move the thumb instantly.
 */
function SegmentedControl<Value extends string>({
  "aria-label": ariaLabel,
  className,
  disabled = false,
  name,
  onValueChange,
  options,
  value,
}: SegmentedControlProps<Value>) {
  const generatedName = React.useId();
  const [instant, setInstant] = React.useState(false);
  const index = options.findIndex((option) => option.value === value);

  return (
    <div className={cn("ui-segmented-scroll", className)}>
      <div
        aria-label={ariaLabel}
        className="ui-segmented"
        data-instant={instant ? "" : undefined}
        onKeyDown={(event) => {
          if (NAVIGATION_KEYS.has(event.key)) setInstant(true);
        }}
        onPointerDown={() => setInstant(false)}
        role="radiogroup"
        style={
          {
            "--segment-count": options.length,
            "--segment-index": Math.max(index, 0),
          } as React.CSSProperties
        }
      >
        {index < 0 ? null : <span aria-hidden="true" className="ui-segmented-thumb" />}
        {options.map((option) => (
          <label className="ui-segment" key={option.value} title={option.title}>
            <input
              aria-label={option.ariaLabel}
              checked={option.value === value}
              disabled={disabled || option.disabled}
              name={name ?? generatedName}
              onChange={() => onValueChange(option.value)}
              type="radio"
              value={option.value}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export { SegmentedControl };
