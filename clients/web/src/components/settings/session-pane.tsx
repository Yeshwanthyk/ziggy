import { ModelPicker } from "@/components/model-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StepSlider } from "@/components/ui/step-slider";
import type {
  ZiggyModelDescriptor,
  ZiggyModelThinkingLevel,
  ZiggySessionModelResult,
  ZiggySessionSummaryResult,
} from "../../../../../packages/ui-sdk/src/index";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Field, PaneHeader, isThinkingLevel, thinkingLevels, thinkingSteps } from "./shared";

interface SessionPaneProps {
  readonly live: boolean;
  readonly availableModels: ReadonlyArray<ZiggyModelDescriptor>;
  readonly sessionBusy: boolean;
  readonly sessionModel: {
    readonly value?: ZiggySessionModelResult;
    readonly error?: string;
    readonly pending: boolean;
  };
  readonly sessionSummaries: {
    readonly value?: ZiggySessionSummaryResult;
    readonly error?: string;
    readonly pending: boolean;
  };
  readonly onChangeSessionModel: (providerId: string, modelId: string) => Promise<void>;
  readonly onChangeSessionThinking: (level: ZiggyModelThinkingLevel) => Promise<void>;
  readonly onLoadSessionSummaries: () => Promise<void>;
  readonly onResumePastSession: (sessionId: string) => Promise<void>;
}

const relativeTime = (value: string): { readonly label: string; readonly title: string } => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return { label: value, title: value };
  const seconds = Math.round((time - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const [unit, size] = units.find(([, length]) => Math.abs(seconds) >= length) ?? ["second", 1];
  return {
    label: format.format(Math.round(seconds / size), unit),
    title: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      time,
    ),
  };
};

export function SessionPane({
  live,
  availableModels,
  sessionBusy,
  sessionModel,
  sessionSummaries,
  onChangeSessionModel,
  onChangeSessionThinking,
  onLoadSessionSummaries,
  onResumePastSession,
}: SessionPaneProps) {
  const current = sessionModel.value;
  const savedThinking =
    current?.thinking !== undefined && isThinkingLevel(current.thinking)
      ? current.thinking
      : undefined;
  const [thinking, setThinking] = useState(savedThinking);
  // Bumped whenever a thinking change settles, so the slider falls back to the saved value
  // after a rejected (or ignored) request as well as after a successful one.
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    if (!sessionModel.pending) setThinking(savedThinking);
  }, [savedThinking, sessionModel.pending, settled]);

  if (!live) {
    return (
      <div className="settings-pane">
        <div className="settings-pane-body">
          <PaneHeader title="This conversation" />
          <p className="settings-muted">
            Open a conversation to change its model or resume a past session into it.
          </p>
        </div>
      </div>
    );
  }

  const known = availableModels.find(
    (model) => model.providerId === current?.providerId && model.modelId === current.modelId,
  );
  const selected: ZiggyModelDescriptor | undefined =
    known ??
    (current?.providerId && current.modelId
      ? {
          providerId: current.providerId,
          modelId: current.modelId,
          name: current.modelId,
          thinkingLevels: [...thinkingLevels],
        }
      : undefined);
  const summaries = sessionSummaries.value;

  return (
    <div className="settings-pane">
      <div className="settings-pane-body">
        <PaneHeader
          description="Changes apply right away to this open session, not the Profile default."
          title="This conversation"
        />
        {sessionBusy ? (
          <p className="settings-muted" role="status">
            Wait for the current turn to finish before switching.
          </p>
        ) : null}
        {sessionModel.error ? (
          <p className="form-error" role="alert">
            {sessionModel.error}
          </p>
        ) : null}
        {current ? (
          <div className="settings-fields">
            <Field label="Model">
              <ModelPicker
                aria-label="Session model"
                // Stay enabled while a switch is pending so focus stays on the trigger.
                disabled={sessionBusy}
                models={availableModels}
                onSelect={(model) => void onChangeSessionModel(model.providerId, model.modelId)}
                selected={selected}
              />
            </Field>
            <StepSlider
              aria-label="Session thinking"
              disabled={sessionBusy}
              endLabel="Smarter"
              label="Thinking"
              onValueChange={setThinking}
              onValueCommit={(level) =>
                void onChangeSessionThinking(level)
                  .catch(() => undefined)
                  .finally(() => setSettled((count) => count + 1))
              }
              startLabel="Faster"
              steps={thinkingSteps(selected?.thinkingLevels ?? thinkingLevels)}
              value={thinking}
            />
          </div>
        ) : sessionModel.pending ? (
          <p className="settings-muted" role="status">
            Loading session model…
          </p>
        ) : null}

        {summaries?.canResume === false ? null : (
          <section aria-label="Resume past session" className="settings-section">
            <PaneHeader
              aside={
                <Button
                  aria-label="Refresh sessions"
                  disabled={sessionSummaries.pending}
                  onClick={() => void onLoadSessionSummaries()}
                  size="icon-sm"
                  title="Refresh sessions"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCw aria-hidden="true" />
                </Button>
              }
              description="Resume into this conversation. A session held elsewhere can't be resumed."
              title="Resume past session"
            />
            {sessionSummaries.error ? (
              <p className="form-error" role="alert">
                {sessionSummaries.error}
              </p>
            ) : null}
            {summaries?.sessions.length === 0 ? (
              <p className="settings-muted">No past sessions found.</p>
            ) : null}
            {summaries === undefined || summaries.sessions.length === 0 ? null : (
              <ul className="settings-list">
                {summaries.sessions.map((session) => {
                  const updated = relativeTime(session.updatedAt);
                  return (
                    <li className="settings-row" key={session.id}>
                      <span className="settings-row-text">
                        <strong>{session.title}</strong>
                        <small>
                          <time dateTime={session.updatedAt} title={updated.title}>
                            {updated.label}
                          </time>
                          {" · "}
                          <code title={session.id}>{session.id.slice(0, 8)}</code>
                        </small>
                      </span>
                      {session.id === summaries.currentSessionId ? (
                        <Badge>Open here</Badge>
                      ) : session.held ? (
                        <Badge>Held</Badge>
                      ) : null}
                      <Button
                        disabled={session.held || sessionBusy || sessionSummaries.pending}
                        onClick={() => void onResumePastSession(session.id)}
                        size="xs"
                        type="button"
                        variant="outline"
                      >
                        Resume
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {summaries?.truncated ? (
              <p className="settings-muted" role="status">
                Showing the most recent 32 sessions.
              </p>
            ) : null}
          </section>
        )}
      </div>
    </div>
  );
}
