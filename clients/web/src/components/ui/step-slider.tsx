import * as React from "react";

import { cn } from "@/lib/utils";
import "./controls.css";

interface Step<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

interface StepSliderProps<Value extends string> {
  /** Visible label in the header row. */
  readonly label: string;
  /** Accessible name when it should differ from the visible label. */
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly steps: ReadonlyArray<Step<Value>>;
  readonly value: Value | undefined;
  /** Called on every step the thumb crosses. */
  readonly onValueChange?: (value: Value) => void;
  /** Called once the choice settles: on pointer release, or immediately for keyboard input. */
  readonly onValueCommit?: (value: Value) => void;
  readonly startLabel?: string;
  readonly endLabel?: string;
}

/**
 * A discrete slider: a native range input over tick dots, with the current value in the header
 * and end labels under the track. The thumb snaps to steps and never animates.
 */
function StepSlider<Value extends string>({
  label,
  "aria-label": ariaLabel,
  className,
  disabled = false,
  steps,
  value,
  onValueChange,
  onValueCommit,
  startLabel,
  endLabel,
}: StepSliderProps<Value>) {
  const labelId = React.useId();
  const dragging = React.useRef(false);
  const dragStart = React.useRef<Value | undefined>(undefined);
  const index = Math.max(
    0,
    steps.findIndex((step) => step.value === value),
  );
  const current = steps[index];
  const last = Math.max(steps.length - 1, 1);

  const commit = (): void => {
    if (!dragging.current) return;
    dragging.current = false;
    if (current !== undefined && current.value !== dragStart.current)
      onValueCommit?.(current.value);
  };

  return (
    <div
      className={cn("ui-steps", className)}
      data-disabled={disabled ? "" : undefined}
      style={{ "--steps-fill": index / last } as React.CSSProperties}
    >
      <div className="ui-steps-header">
        <span id={labelId}>{label}</span>
        <output aria-hidden="true">{current?.label ?? "—"}</output>
      </div>
      <div className="ui-steps-track">
        <span aria-hidden="true" className="ui-steps-rail" />
        {steps.map((step, stepIndex) => (
          <span
            aria-hidden="true"
            className="ui-steps-dot"
            data-filled={stepIndex <= index ? "" : undefined}
            key={step.value}
            style={{ "--step-at": stepIndex / last } as React.CSSProperties}
          />
        ))}
        <input
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel === undefined ? labelId : undefined}
          aria-valuetext={current?.value}
          disabled={disabled || steps.length < 2}
          max={steps.length - 1}
          min={0}
          onChange={(event) => {
            const next = steps[Number(event.target.value)];
            if (next === undefined) return;
            onValueChange?.(next.value);
            if (!dragging.current) onValueCommit?.(next.value);
          }}
          onBlur={commit}
          onPointerDown={() => {
            dragging.current = true;
            dragStart.current = current?.value;
          }}
          onPointerUp={commit}
          step={1}
          type="range"
          value={index}
        />
      </div>
      {startLabel === undefined && endLabel === undefined ? null : (
        <div aria-hidden="true" className="ui-steps-ends">
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </div>
      )}
    </div>
  );
}

export { StepSlider };
