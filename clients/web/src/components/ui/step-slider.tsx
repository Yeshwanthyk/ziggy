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
  /**
   * Called once the choice settles: on pointer release, on blur, or after keyboard input pauses,
   * so arrow keys can move several steps before a single commit.
   */
  readonly onValueCommit?: (value: Value) => void;
  readonly startLabel?: string;
  readonly endLabel?: string;
}

/** Quiet period after the last keyboard step before the choice commits. */
const KEYBOARD_COMMIT_DELAY_MS = 500;

const UNSET_LABEL = "Not set";

/**
 * A discrete slider: a native range input over tick dots, with the current value in the header
 * and end labels under the track. The thumb snaps to steps and never animates. A value outside
 * the steps renders as "Not set" rather than silently as the first step.
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
  const edit = React.useRef<{ start: Value | undefined; latest: Value } | undefined>(undefined);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = React.useRef(onValueCommit);
  React.useLayoutEffect(() => {
    commitRef.current = onValueCommit;
  });
  const found = steps.findIndex((step) => step.value === value);
  const unset = found < 0;
  const index = Math.max(0, found);
  const current = unset ? undefined : steps[index];
  const last = Math.max(steps.length - 1, 1);

  const flush = React.useCallback((): void => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const pending = edit.current;
    edit.current = undefined;
    if (pending !== undefined && pending.latest !== pending.start)
      commitRef.current?.(pending.latest);
  }, []);

  React.useEffect(() => flush, [flush]);

  const choose = (next: Value): void => {
    edit.current = { start: edit.current?.start ?? current?.value, latest: next };
    onValueChange?.(next);
    clearTimeout(timer.current);
    if (!dragging.current) timer.current = setTimeout(flush, KEYBOARD_COMMIT_DELAY_MS);
  };

  const release = (): void => {
    dragging.current = false;
    flush();
  };

  return (
    <div
      className={cn("ui-steps", className)}
      data-disabled={disabled ? "" : undefined}
      data-unset={unset ? "" : undefined}
      style={{ "--steps-fill": unset ? 0 : index / last } as React.CSSProperties}
    >
      <div className="ui-steps-header">
        <span id={labelId}>{label}</span>
        <output aria-hidden="true">{current?.label ?? UNSET_LABEL}</output>
      </div>
      <div className="ui-steps-track">
        <span aria-hidden="true" className="ui-steps-rail" />
        {steps.map((step, stepIndex) => (
          <span
            aria-hidden="true"
            className="ui-steps-dot"
            data-filled={!unset && stepIndex <= index ? "" : undefined}
            key={step.value}
            style={{ "--step-at": stepIndex / last } as React.CSSProperties}
          />
        ))}
        <input
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel === undefined ? labelId : undefined}
          aria-valuetext={current?.label ?? UNSET_LABEL}
          disabled={disabled || steps.length < 2}
          max={steps.length - 1}
          min={0}
          onBlur={release}
          onChange={(event) => {
            const next = steps[Number(event.target.value)];
            if (next !== undefined) choose(next.value);
          }}
          onKeyDown={(event) => {
            // At the first position an unset slider fires no change, so pick the first step.
            const first = steps[0];
            if (
              unset &&
              first !== undefined &&
              ["ArrowLeft", "ArrowDown", "Home", "PageDown"].includes(event.key)
            ) {
              event.preventDefault();
              choose(first.value);
            }
          }}
          onPointerDown={() => {
            dragging.current = true;
          }}
          onPointerUp={(event) => {
            const at = steps[Number(event.currentTarget.value)];
            if (unset && edit.current === undefined && at !== undefined) choose(at.value);
            release();
          }}
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
