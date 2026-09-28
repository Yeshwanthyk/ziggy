import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ModelSettingsState } from "@/gateway";
import type {
  ZiggyModelThinkingLevel,
  ZiggySessionModelResult,
  ZiggySessionRef,
  ZiggySessionSummaryResult,
} from "../../../../../packages/ui-sdk/src/index";
import { Blocks, Cpu, KeyRound, MessageSquare, Plug } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ConnectionPane } from "./connection-pane";
import { ExtensionsPane } from "./extensions-pane";
import { ModelPane } from "./model-pane";
import { ProvidersPane } from "./providers-pane";
import { SessionPane } from "./session-pane";
import "./settings.css";

interface SettingsDialogProps {
  readonly connected: boolean;
  readonly connectionError?: string;
  readonly connectionPending: boolean;
  readonly modelSettings?: ModelSettingsState;
  readonly sessionModel: {
    readonly value?: ZiggySessionModelResult;
    readonly error?: string;
    readonly pending: boolean;
  };
  readonly selectedRef?: ZiggySessionRef;
  readonly sessionBusy: boolean;
  readonly sessionSummaries?: {
    readonly value?: ZiggySessionSummaryResult;
    readonly error?: string;
    readonly pending: boolean;
  };
  readonly onLoadSessionSummaries?: () => Promise<void>;
  readonly onResumePastSession?: (sessionId: string) => Promise<void>;
  readonly onLoadSessionModel: () => Promise<void>;
  readonly onChangeSessionModel: (providerId: string, modelId: string) => Promise<void>;
  readonly onChangeSessionThinking: (level: ZiggyModelThinkingLevel) => Promise<void>;
  readonly hosted?: boolean;
  readonly pairingRequired?: boolean;
  readonly open: boolean;
  readonly profileName: string;
  /** Exact `ziggy` CLI argument for the resident Profile, as sent by the server. */
  readonly cliTarget?: string | undefined;
  readonly onConnect: (url: string, token: string) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRetrySettings: () => Promise<void>;
  readonly onToggleExtension: (id: string, enabled: boolean) => Promise<void>;
  readonly onSaveModel: (
    providerId: string,
    modelId: string,
    thinking: ZiggyModelThinkingLevel,
  ) => Promise<void>;
}

type Tab = "model" | "session" | "extensions" | "providers" | "connection";

const tabs: ReadonlyArray<{ readonly id: Tab; readonly label: string; readonly icon: ReactNode }> =
  [
    { id: "model", label: "Model", icon: <Cpu aria-hidden="true" /> },
    { id: "session", label: "Session", icon: <MessageSquare aria-hidden="true" /> },
    { id: "extensions", label: "Extensions", icon: <Blocks aria-hidden="true" /> },
    { id: "providers", label: "Providers", icon: <KeyRound aria-hidden="true" /> },
    { id: "connection", label: "Connection", icon: <Plug aria-hidden="true" /> },
  ];

export function SettingsDialog({
  connected,
  connectionError,
  connectionPending,
  modelSettings,
  sessionModel,
  selectedRef,
  sessionBusy,
  sessionSummaries = { pending: false },
  onLoadSessionSummaries = async () => undefined,
  onResumePastSession = async () => undefined,
  onLoadSessionModel,
  onChangeSessionModel,
  onChangeSessionThinking,
  hosted = false,
  pairingRequired = false,
  open,
  profileName,
  cliTarget,
  onConnect,
  onOpenChange,
  onSaveModel,
  onRetrySettings,
  onToggleExtension,
}: SettingsDialogProps) {
  const baseId = useId();
  const visibleTabs = connected ? tabs : tabs.filter((tab) => tab.id === "connection");
  const [requestedTab, setRequestedTab] = useState<Tab>("model");
  const tab = visibleTabs.some((entry) => entry.id === requestedTab)
    ? requestedTab
    : (visibleTabs[0]?.id ?? "connection");
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const live = connected && selectedRef?.kind === "live";
  const liveKey = selectedRef?.kind === "live" ? selectedRef.key : undefined;

  useEffect(() => {
    if (open) setRequestedTab("model");
  }, [open]);

  useEffect(() => {
    if (open && live) void onLoadSessionModel();
  }, [open, live, liveKey, onLoadSessionModel]);

  useEffect(() => {
    if (open && live) void onLoadSessionSummaries();
  }, [open, live, liveKey, onLoadSessionSummaries]);

  const focusTab = (next: Tab): void => {
    setRequestedTab(next);
    tabRefs.current.get(next)?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = visibleTabs.findIndex((entry) => entry.id === tab);
    const last = visibleTabs.length - 1;
    const target =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;
    const next = target === undefined ? undefined : visibleTabs[target];
    if (next === undefined) return;
    event.preventDefault();
    focusTab(next.id);
  };

  const tabId = (id: Tab): string => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog">
        <DialogHeader className="settings-header">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            {connected ? profileName : `Connect to ${profileName} to change its settings.`}
          </DialogDescription>
        </DialogHeader>
        <div className="settings-layout">
          <div
            aria-label="Settings sections"
            aria-orientation="vertical"
            className="settings-tabs"
            onKeyDown={onTabKeyDown}
            role="tablist"
          >
            {visibleTabs.map((entry) => (
              <button
                aria-controls={panelId}
                aria-selected={entry.id === tab}
                className="settings-tab"
                id={tabId(entry.id)}
                key={entry.id}
                onClick={() => setRequestedTab(entry.id)}
                ref={(element) => {
                  if (element === null) tabRefs.current.delete(entry.id);
                  else tabRefs.current.set(entry.id, element);
                }}
                role="tab"
                tabIndex={entry.id === tab ? 0 : -1}
                type="button"
              >
                {entry.icon}
                {entry.label}
              </button>
            ))}
          </div>
          <div aria-labelledby={tabId(tab)} className="settings-panel" id={panelId} role="tabpanel">
            {tab === "model" ? (
              <ModelPane
                modelSettings={modelSettings}
                onRetrySettings={onRetrySettings}
                onSaveModel={onSaveModel}
              />
            ) : tab === "session" ? (
              <SessionPane
                availableModels={modelSettings?.availableModels ?? []}
                live={live}
                onChangeSessionModel={onChangeSessionModel}
                onChangeSessionThinking={onChangeSessionThinking}
                onLoadSessionSummaries={onLoadSessionSummaries}
                onResumePastSession={onResumePastSession}
                sessionBusy={sessionBusy}
                sessionModel={sessionModel}
                sessionSummaries={sessionSummaries}
              />
            ) : tab === "extensions" ? (
              <ExtensionsPane
                modelSettings={modelSettings}
                cliTarget={cliTarget}
                onToggleExtension={onToggleExtension}
              />
            ) : tab === "providers" ? (
              <ProvidersPane modelSettings={modelSettings} />
            ) : (
              <ConnectionPane
                cliTarget={cliTarget}
                connected={connected}
                connectionError={connectionError}
                connectionPending={connectionPending}
                hosted={hosted}
                onConnect={onConnect}
                pairingRequired={pairingRequired}
                profileName={profileName}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
