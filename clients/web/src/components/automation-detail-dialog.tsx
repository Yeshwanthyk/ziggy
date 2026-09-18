import { CircleCheck, CircleX, Clock3, Pencil, RefreshCw, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { DefinitionEditor } from "@/components/definition-editor";
import { AutomationDestinationPicker } from "@/components/automation-destination-picker";
import {
  addAutomationBroadcastTarget,
  parseDefinitionSource,
  removeAutomationBroadcastTarget,
} from "@/lib/definition-source";
import type { AutomationDestinationOption, AutomationDetail, AutomationSummary } from "@/gateway";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface AutomationDetailDialogProps {
  readonly automation?: AutomationSummary;
  readonly available: boolean;
  readonly destinations: ReadonlyArray<AutomationDestinationOption>;
  readonly detail?: AutomationDetail;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRefresh: () => void;
  readonly onSave: (source: string, expectedSource: string) => Promise<void>;
  readonly open: boolean;
}

const formatTimestamp = (value: number | null, timezone?: string): string => {
  if (value === null) return "Not recorded";
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    second: "2-digit",
    timeZoneName: "short",
    year: "numeric",
    ...(timezone === undefined ? {} : { timeZone: timezone }),
  };
  try {
    return new Intl.DateTimeFormat(undefined, options).format(value);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      second: "2-digit",
      timeZoneName: "short",
      year: "numeric",
    }).format(value);
  }
};

const formatDuration = (started: number | null, finished: number | null): string => {
  if (started === null || finished === null) return "—";
  const duration = Math.max(0, finished - started);
  return duration < 1_000 ? `${duration} ms` : `${(duration / 1_000).toFixed(1)} s`;
};

const formatRunDuration = (run: AutomationDetail["runs"][number]): string => {
  if (
    (run.state === "running" || run.state === "claimed") &&
    run.startedAtMs !== null &&
    run.finishedAtMs === null
  ) {
    return formatDuration(run.startedAtMs, Date.now());
  }

  return formatDuration(run.startedAtMs, run.finishedAtMs);
};

const taskFromSource = (source: string): string => {
  const parsed = parseDefinitionSource(source);
  return parsed.structured ? parsed.task : source.trim();
};

const taskPreview = (task: string): { readonly clipped: boolean; readonly preview: string } => {
  const lines = task.split("\n");
  const clipped = lines.length > 6 || task.length > 720;
  if (!clipped) return { clipped, preview: task };
  const firstLines = lines.slice(0, 6).join("\n");
  const preview = firstLines.length > 720 ? firstLines.slice(0, 720) : firstLines;
  return { clipped, preview: `${preview.trimEnd()}…` };
};

const kindLabel = (kind: AutomationDestinationOption["kind"]): string =>
  kind === "conversation" ? "Conversation" : `${kind[0]?.toLocaleUpperCase()}${kind.slice(1)}`;

const actionLabel = (kind: AutomationDestinationOption["kind"]): string =>
  kind === "conversation" ? "Append history" : "Send message";

const runStateLabel = (state: AutomationDetail["runs"][number]["state"]): string => {
  if (state === "skipped-busy") return "Skipped · already running";
  if (state === "running") return "Running";
  if (state === "claimed") return "Waiting to start";
  return state.replaceAll("-", " ");
};

const emptyDeliveryCopy = (state: AutomationDetail["runs"][number]["state"]): string => {
  if (state === "running" || state === "claimed") {
    return "Broadcast delivery waits for this run to finish.";
  }
  if (state === "skipped-busy") {
    return "This attempt did not start, so no broadcasts were attempted.";
  }
  return "No delivery outcomes recorded.";
};

function RunTargets({
  destinations,
  run,
}: {
  readonly destinations: ReadonlyArray<AutomationDestinationOption>;
  readonly run: AutomationDetail["runs"][number];
}) {
  if (run.targets.length === 0) {
    return <p className="detail-muted">{emptyDeliveryCopy(run.state)}</p>;
  }

  return (
    <ul className="run-targets">
      {run.targets.map((target) => {
        const destination = destinations.find((entry) => entry.target === target.target);

        return (
          <li key={target.target}>
            <strong>{destination?.label ?? target.target}</strong>
            <span>
              {target.status}
              {target.failureCategory === null ? "" : ` · ${target.failureCategory}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function AutomationDetailDialog({
  automation,
  available,
  destinations,
  detail,
  onOpenChange,
  onRefresh,
  onSave,
  open,
}: AutomationDetailDialogProps) {
  const [editing, setEditing] = useState(false);
  const [destinationKey, setDestinationKey] = useState("");
  const [destinationError, setDestinationError] = useState<string>();
  const [savingDestination, setSavingDestination] = useState(false);
  useEffect(() => {
    setEditing(false);
    setDestinationKey("");
    setDestinationError(undefined);
  }, [automation?.id, open]);
  const timezone = automation?.timezone;
  const selectedSchedule = detail?.status?.schedules.find(
    (schedule) => schedule.automationId === automation?.id,
  );
  const latestRun = detail?.runs[0];
  const activeRun = detail?.runs.find((run) => run.state === "running" || run.state === "claimed");
  const featuredRun =
    activeRun ?? detail?.runs.find((run) => run.state !== "skipped-busy") ?? latestRun;
  const runsUnavailable = detail?.errors.some((error) => error.source === "runs") ?? false;
  const nextRun =
    automation?.lifecycle === "paused"
      ? "Paused · no next scheduled run"
      : selectedSchedule?.nextScheduledAtMs == null
        ? "No next run reported"
        : formatTimestamp(selectedSchedule.nextScheduledAtMs, timezone);
  const task =
    detail?.definition === undefined ? undefined : taskFromSource(detail.definition.source);
  const preview = task === undefined ? undefined : taskPreview(task);
  const parsedDefinition =
    detail?.definition === undefined ? undefined : parseDefinitionSource(detail.definition.source);
  const selectedTargets =
    parsedDefinition?.fields.broadcast.trim() === "none"
      ? []
      : (parsedDefinition?.fields.broadcast.trim().split(",").filter(Boolean) ?? []);
  const availableDestinations = destinations.filter(
    (destination) => !selectedTargets.includes(destination.target),
  );

  const saveDestination = async (): Promise<void> => {
    if (detail?.definition === undefined || parsedDefinition === undefined) return;
    const destination = destinations.find((option) => destinationKey === option.target);
    if (destination === undefined) return;
    setSavingDestination(true);
    setDestinationError(undefined);
    try {
      const source = addAutomationBroadcastTarget(detail.definition.source, destination.target);
      await onSave(source, detail.definition.source);
      setDestinationKey("");
    } catch (cause) {
      setDestinationError(
        cause instanceof Error ? cause.message : "The delivery destination could not be selected.",
      );
    } finally {
      setSavingDestination(false);
    }
  };

  const removeDestination = async (target: string): Promise<void> => {
    if (detail?.definition === undefined) return;
    setSavingDestination(true);
    setDestinationError(undefined);
    try {
      await onSave(
        removeAutomationBroadcastTarget(detail.definition.source, target),
        detail.definition.source,
      );
    } catch (cause) {
      setDestinationError(
        cause instanceof Error ? cause.message : "The delivery destination could not be removed.",
      );
    } finally {
      setSavingDestination(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="automation-dialog sm:max-w-[680px]">
        <DialogHeader>
          <div className="automation-detail-heading">
            <span>
              <DialogTitle>{automation?.id ?? "Automation"}</DialogTitle>
              <DialogDescription>
                Definition, schedule, and recent execution history.
              </DialogDescription>
            </span>
            <span className="automation-detail-actions">
              {editing || detail?.definition === undefined ? null : (
                <Button
                  disabled={!available}
                  onClick={() => setEditing(true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Pencil />
                  Edit
                </Button>
              )}
              <Button
                aria-label="Refresh automation details"
                disabled={!available || detail?.loading || automation === undefined || editing}
                onClick={onRefresh}
                size="icon"
                type="button"
                variant="ghost"
              >
                <RefreshCw className={detail?.loading ? "is-spinning" : ""} />
              </Button>
            </span>
          </div>
        </DialogHeader>
        <ScrollArea className="automation-detail-scroll">
          <div className="automation-detail-body">
            {detail?.loading ? <p className="detail-loading">Loading automation details…</p> : null}
            {detail?.errors.map((error) => (
              <p className="detail-error" key={error.source} role="alert">
                <strong>{error.source}:</strong> {error.message}
              </p>
            ))}

            {editing && detail?.definition !== undefined ? (
              <DefinitionEditor
                onCancel={() => setEditing(false)}
                onSave={async (source, expectedSource) => {
                  await onSave(source, expectedSource);
                  setEditing(false);
                }}
                source={detail.definition.source}
              />
            ) : (
              <>
                <section className="detail-section">
                  <h3>What it does</h3>
                  <p className="automation-task">
                    {preview === undefined
                      ? "Definition unavailable."
                      : preview.preview || "No task text."}
                  </p>
                  {preview?.clipped ? (
                    <details>
                      <summary>Show full task</summary>
                      <p className="automation-task full-task">{task}</p>
                    </details>
                  ) : null}
                  {detail?.definition === undefined ? null : (
                    <details>
                      <summary>Full definition</summary>
                      <pre>{detail.definition.source}</pre>
                    </details>
                  )}
                </section>

                <section className="detail-section detail-grid">
                  <div>
                    <span>Lifecycle</span>
                    <strong>{automation?.lifecycle ?? "Unknown"}</strong>
                  </div>
                  <div>
                    <span>Schedule</span>
                    <strong>
                      {automation?.schedule ?? automation?.gateState ?? "Manual only"}
                    </strong>
                  </div>
                  <div>
                    <span>Timezone</span>
                    <strong>{timezone ?? "Browser local"}</strong>
                  </div>
                  <div>
                    <span>Next run</span>
                    <strong>{nextRun}</strong>
                  </div>
                </section>

                <section className="detail-section automation-destination">
                  <h3>Broadcast results to</h3>
                  {selectedTargets.length === 0 ? (
                    <p className="detail-muted">No delivery destinations selected.</p>
                  ) : (
                    <ul className="automation-destination-list">
                      {selectedTargets.map((target) => {
                        const destination = destinations.find((entry) => entry.target === target);
                        return (
                          <li key={target}>
                            <span>
                              <strong>
                                {destination === undefined
                                  ? target
                                  : `${kindLabel(destination.kind)} · ${destination.label ?? destination.target}`}
                              </strong>
                              <small>
                                {destination === undefined
                                  ? "Saved broadcast target"
                                  : actionLabel(destination.kind)}
                              </small>
                            </span>
                            <Button
                              aria-label={`Remove ${target}`}
                              disabled={!available || savingDestination}
                              onClick={() => void removeDestination(target)}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              Remove
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="automation-destination-controls">
                    <div className="automation-destination-picker-field">
                      <span>Destination</span>
                      <AutomationDestinationPicker
                        destinations={availableDestinations}
                        disabled={
                          !available || savingDestination || availableDestinations.length === 0
                        }
                        onSelect={(destination) => setDestinationKey(destination.target)}
                        selected={destinations.find(
                          (destination) => destination.target === destinationKey,
                        )}
                      />
                    </div>
                    <Button
                      disabled={!available || destinationKey.length === 0 || savingDestination}
                      onClick={() => void saveDestination()}
                      size="sm"
                      type="button"
                    >
                      {savingDestination ? "Adding…" : "Add destination"}
                    </Button>
                  </div>
                  {availableDestinations.length === 0 ? (
                    <p className="detail-muted">No additional known destinations are available.</p>
                  ) : null}
                  {destinationError === undefined ? null : (
                    <p className="detail-error" role="alert">
                      {destinationError}
                    </p>
                  )}
                </section>

                <section className="detail-section">
                  <h3>{activeRun === undefined ? "Latest run" : "Active run"}</h3>
                  {detail === undefined || detail.loading ? (
                    <p className="detail-muted">Loading runs…</p>
                  ) : runsUnavailable ? (
                    <p className="detail-muted">Run history unavailable.</p>
                  ) : featuredRun === undefined ? (
                    <p className="detail-muted">No runs recorded for this automation.</p>
                  ) : (
                    <div className="run-card is-latest" data-state={featuredRun.state}>
                      <div className="run-card-heading">
                        <div className="run-status-group">
                          <strong className="run-status">
                            {featuredRun.state === "failed" ? (
                              <CircleX />
                            ) : featuredRun.state === "completed" ? (
                              <CircleCheck />
                            ) : (
                              <Clock3 />
                            )}
                            {runStateLabel(featuredRun.state)}
                          </strong>
                          <span className="run-trigger">{featuredRun.trigger} run</span>
                        </div>
                        <span
                          className="run-duration"
                          aria-label={`Duration: ${formatRunDuration(featuredRun)}`}
                        >
                          <Timer />
                          {formatRunDuration(featuredRun)}
                        </span>
                      </div>
                      <dl>
                        <div>
                          <dt>Started</dt>
                          <dd>{formatTimestamp(featuredRun.startedAtMs, timezone)}</dd>
                        </div>
                        <div>
                          <dt>Finished</dt>
                          <dd>
                            {featuredRun.state === "running" || featuredRun.state === "claimed"
                              ? "In progress"
                              : formatTimestamp(featuredRun.finishedAtMs, timezone)}
                          </dd>
                        </div>
                      </dl>
                      <RunTargets destinations={destinations} run={featuredRun} />
                      {featuredRun.state === "failed" || featuredRun.failureCategory !== null ? (
                        <div className="run-failure">
                          <span>Failure reason</span>
                          <code>{featuredRun.failureCategory ?? "Not reported"}</code>
                        </div>
                      ) : null}
                    </div>
                  )}
                </section>

                <section className="detail-section">
                  <h3>Scheduler</h3>
                  {detail?.status === undefined ? (
                    <p className="detail-muted">Scheduler status unavailable.</p>
                  ) : (
                    <div className="scheduler-line">
                      <span
                        className={`scheduler-dot is-${detail.status.lastTickStatus ?? "unknown"}`}
                      />
                      <span>
                        <strong>
                          {detail.status.lastTickStatus === "ok"
                            ? "Last scheduler tick succeeded"
                            : detail.status.lastTickStatus === "error"
                              ? "Scheduler error"
                              : "Scheduler status unknown"}
                        </strong>
                        <small>
                          Last tick {formatTimestamp(detail.status.lastTickAtMs, timezone)} ·
                          heartbeat {formatTimestamp(detail.status.heartbeatAtMs, timezone)}
                        </small>
                        {detail.status.lastTickError === null ? null : (
                          <small>{detail.status.lastTickError}</small>
                        )}
                      </span>
                    </div>
                  )}
                </section>

                <section className="detail-section">
                  <h3>Recent runs</h3>
                  {detail === undefined || detail.loading ? (
                    <p className="detail-muted">Loading runs…</p>
                  ) : runsUnavailable ? (
                    <p className="detail-muted">Run history unavailable.</p>
                  ) : detail.runs.length === 0 ? (
                    <p className="detail-muted">No runs recorded for this automation.</p>
                  ) : (
                    detail.runs.slice(0, 8).map((run) => (
                      <details className="run-row" key={run.runId}>
                        <summary>
                          <strong>{runStateLabel(run.state)}</strong>
                          <span>{formatTimestamp(run.recordedAtMs, timezone)}</span>
                          <span>{formatDuration(run.startedAtMs, run.finishedAtMs)}</span>
                        </summary>
                        <dl>
                          <div>
                            <dt>Run ID</dt>
                            <dd>{run.runId}</dd>
                          </div>
                          <div>
                            <dt>Trigger</dt>
                            <dd>{run.trigger}</dd>
                          </div>
                          <div>
                            <dt>Scheduled</dt>
                            <dd>{formatTimestamp(run.scheduledForMs, timezone)}</dd>
                          </div>
                          <div>
                            <dt>Started</dt>
                            <dd>{formatTimestamp(run.startedAtMs, timezone)}</dd>
                          </div>
                          <div>
                            <dt>Finished</dt>
                            <dd>{formatTimestamp(run.finishedAtMs, timezone)}</dd>
                          </div>
                          <div>
                            <dt>Failure</dt>
                            <dd>{run.failureCategory ?? "Not reported"}</dd>
                          </div>
                        </dl>
                        <RunTargets destinations={destinations} run={run} />
                      </details>
                    ))
                  )}
                </section>
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
