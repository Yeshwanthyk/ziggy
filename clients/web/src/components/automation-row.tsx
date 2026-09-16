import { Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AutomationRowProps {
  readonly automation: {
    readonly id: string;
    readonly lifecycle: "active" | "paused" | "conflict";
    readonly message?: string;
    readonly schedule?: string;
  };
  readonly busy: boolean;
  readonly onPause: () => void;
  readonly onInspect: () => void;
  readonly onResume: () => void;
  readonly onRun: () => void;
}

export function AutomationRow({
  automation,
  busy,
  onInspect,
  onPause,
  onResume,
  onRun,
}: AutomationRowProps) {
  const actionable = automation.lifecycle !== "conflict";
  return (
    <div className="automation-row">
      <span className={`automation-status is-${automation.lifecycle}`} aria-hidden="true" />
      <button className="automation-copy" disabled={busy} onClick={onInspect} type="button">
        <strong>{automation.id}</strong>
        <small>{automation.message ?? automation.schedule ?? automation.lifecycle}</small>
      </button>
      {actionable ? (
        <span className="automation-actions">
          <Button
            aria-label={`Run ${automation.id}`}
            disabled={busy}
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
