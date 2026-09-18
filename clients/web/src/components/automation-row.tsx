import type { ZiggyAutomationRun } from "../../../../packages/ui-sdk/src/index";
import { CircleAlert, LoaderCircle, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AutomationRowProps {
  readonly automation: {
    readonly id: string;
    readonly lifecycle: "active" | "paused" | "conflict";
    readonly message?: string;
    readonly schedule?: string;
  };
  readonly busy: boolean;
  readonly runState?: ZiggyAutomationRun["state"] | "starting";
  readonly onPause: () => void;
  readonly onInspect: () => void;
  readonly onResume: () => void;
  readonly onRun: () => void;
}

function scheduleLabel(schedule: string | undefined) {
  if (!schedule) return "Scheduled";
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/u.exec(schedule.trim());
  if (!daily) return schedule;
  const minute = Number(daily[1]);
  const hour = Number(daily[2]);
  if (minute > 59 || hour > 23) return schedule;
  const time = `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour < 12 ? "AM" : "PM"}`;
  return `Daily at ${time}`;
}

export function AutomationRow({
  automation,
  busy,
  runState,
  onInspect,
  onPause,
  onResume,
  onRun,
}: AutomationRowProps) {
  const actionable = automation.lifecycle !== "conflict";
  const needsAttention = Boolean(automation.message) || !actionable;
  const name = automation.id.replace(/[-_]+/gu, " ");
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  const running = runState === "running" || runState === "claimed" || runState === "starting";
  const runLabel =
    runState === "completed"
      ? "Last run completed"
      : runState === "failed"
        ? "Last run failed · View details"
        : runState === "unknown"
          ? "Run interrupted · View details"
          : runState === "skipped-busy"
            ? "Last attempt skipped · Busy"
            : undefined;
  const status = running
    ? runState === "starting"
      ? "Starting…"
      : "Running · View progress"
    : (runLabel ??
      (needsAttention
        ? "Needs attention"
        : automation.lifecycle === "paused"
          ? `Paused · ${scheduleLabel(automation.schedule)}`
          : `Enabled · ${scheduleLabel(automation.schedule)}`));
  return (
    <div className="automation-row">
      {running ? (
        <LoaderCircle
          className="size-3 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : needsAttention ? (
        <CircleAlert className="automation-warning" aria-hidden="true" />
      ) : (
        <span className={`automation-status is-${automation.lifecycle}`} aria-hidden="true" />
      )}
      <button
        className="automation-copy"
        onClick={onInspect}
        title={`${automation.id}\n${automation.message ?? automation.schedule ?? automation.lifecycle}`}
        type="button"
      >
        <strong>{label}</strong>
        <small>{status}</small>
      </button>
      {actionable ? (
        <span className="automation-actions">
          <Button
            aria-label={`Run ${automation.id}`}
            title={running ? "Already running" : "Run now"}
            disabled={busy || running}
            onClick={onRun}
            className="compact-icon"
            size="icon"
            type="button"
            variant="ghost"
          >
            <Play />
          </Button>
          {automation.lifecycle === "paused" ? (
            <Button
              aria-label={`Resume ${automation.id}`}
              title="Resume schedule"
              disabled={busy}
              onClick={onResume}
              className="compact-icon"
              size="icon"
              type="button"
              variant="ghost"
            >
              <RotateCcw />
            </Button>
          ) : (
            <Button
              aria-label={`Pause ${automation.id}`}
              title="Pause schedule"
              disabled={busy}
              onClick={onPause}
              className="compact-icon"
              size="icon"
              type="button"
              variant="ghost"
            >
              <Pause />
            </Button>
          )}
        </span>
      ) : null}
    </div>
  );
}
