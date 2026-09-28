import type { ZiggyAutomationRun } from "../../../../packages/ui-sdk/src/index";
import { CircleAlert, LoaderCircle, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { automationTitle, scheduleLabel } from "@/lib/automation-labels";

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
  const label = automationTitle(automation.id);
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
      <span className="automation-leading" aria-hidden="true">
        {running ? (
          <LoaderCircle className="automation-spinner" />
        ) : needsAttention ? (
          <CircleAlert className="automation-warning" />
        ) : (
          <span className={`automation-status is-${automation.lifecycle}`} />
        )}
      </span>
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
            size="icon-sm"
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
              size="icon-sm"
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
              size="icon-sm"
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
