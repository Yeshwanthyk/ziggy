import type { ZiggyModelThinkingLevel } from "../../../../../packages/ui-sdk/src/index";
import type { ReactNode } from "react";

export const thinkingLevels: ReadonlyArray<ZiggyModelThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const thinkingLabels: Readonly<Record<ZiggyModelThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const isThinkingLevel = (value: string): value is ZiggyModelThinkingLevel =>
  thinkingLevels.some((level) => level === value);

/** Slider steps for the levels a model supports, in canonical order. */
export const thinkingSteps = (
  supported: ReadonlyArray<string>,
): ReadonlyArray<{ readonly value: ZiggyModelThinkingLevel; readonly label: string }> =>
  thinkingLevels
    .filter((level) => supported.includes(level))
    .map((level) => ({ value: level, label: thinkingLabels[level] }));

export const modelKey = (providerId: string, modelId: string): string =>
  JSON.stringify([providerId, modelId]);

/**
 * The CLI target for this Profile. Ziggy names a Profile by capitalising its folder name,
 * so lowering the first letter recovers the folder under the Profiles directory.
 */
export const profileTarget = (profileName: string): string =>
  `${profileName.charAt(0).toLocaleLowerCase()}${profileName.slice(1)}`;

export function PaneHeader({
  title,
  description,
  aside,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly aside?: ReactNode;
}) {
  return (
    <div className="settings-pane-header">
      <div>
        <h3>{title}</h3>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {aside}
    </div>
  );
}

export function Field({
  label,
  labelId,
  hint,
  children,
}: {
  readonly label: string;
  readonly labelId?: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="settings-field">
      <span className="settings-field-label" id={labelId}>
        {label}
      </span>
      {children}
      {hint === undefined ? null : <p className="settings-field-hint">{hint}</p>}
    </div>
  );
}
