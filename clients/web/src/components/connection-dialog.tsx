import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/model-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ModelSettingsState } from "@/gateway";
import type {
  ZiggyModelThinkingLevel,
  ZiggySessionModelResult,
  ZiggySessionSummaryResult,
  ZiggySessionRef,
} from "../../../../packages/ui-sdk/src/index";
import { Info } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import "./connection-dialog.css";

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

const endpointKey = "ziggy.web.endpoint";
const tokenKey = "ziggy.web.session-token";

export interface SavedConnection {
  readonly url: string;
  readonly token: string;
}

export const readSavedConnection = (): SavedConnection | undefined => {
  const url = localStorage.getItem(endpointKey)?.trim();
  const token = sessionStorage.getItem(tokenKey);
  return url === undefined || url.length === 0 || token === null || token.length === 0
    ? undefined
    : { url, token };
};

const thinkingLevels: ReadonlyArray<ZiggyModelThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const isThinkingLevel = (value: string): value is ZiggyModelThinkingLevel =>
  thinkingLevels.some((level) => level === value);

const modelKey = (providerId: string, modelId: string): string =>
  JSON.stringify([providerId, modelId]);

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
  onConnect,
  onOpenChange,
  onSaveModel,
  onRetrySettings,
  onToggleExtension,
}: SettingsDialogProps) {
  const [url, setUrl] = useState("ws://127.0.0.1:8787/ws");
  const [token, setToken] = useState("");
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [thinking, setThinking] = useState<ZiggyModelThinkingLevel | "">("");

  useEffect(() => {
    if (!open) return;
    const saved = readSavedConnection();
    setUrl(saved?.url ?? localStorage.getItem(endpointKey) ?? "ws://127.0.0.1:8787/ws");
    setToken(saved?.token ?? "");
  }, [open]);

  const statusProvider = modelSettings?.status?.providerId;
  const statusModel = modelSettings?.status?.modelId;
  const statusThinking = modelSettings?.status?.thinking;

  useEffect(() => {
    if (!open) return;
    setSelectedModelKey(
      statusProvider === null ||
        statusProvider === undefined ||
        statusModel === null ||
        statusModel === undefined
        ? ""
        : modelKey(statusProvider, statusModel),
    );
    setThinking(
      statusThinking !== undefined && isThinkingLevel(statusThinking) ? statusThinking : "",
    );
  }, [open, statusModel, statusProvider, statusThinking]);

  useEffect(() => {
    if (open && connected && selectedRef?.kind === "live") void onLoadSessionModel();
  }, [
    open,
    connected,
    selectedRef?.kind,
    selectedRef?.kind === "live" ? selectedRef.key : undefined,
    onLoadSessionModel,
  ]);

  useEffect(() => {
    if (open && connected && selectedRef?.kind === "live") void onLoadSessionSummaries();
  }, [
    open,
    connected,
    selectedRef?.kind,
    selectedRef?.kind === "live" ? selectedRef.key : undefined,
    onLoadSessionSummaries,
  ]);
  const availableModels = modelSettings?.availableModels ?? [];
  const configuredProviders = (modelSettings?.providers ?? []).filter(
    (provider) => provider.configured,
  );
  const otherProviders = (modelSettings?.providers ?? []).filter(
    (provider) => !provider.configured,
  );
  const selectedModel = useMemo(
    () =>
      availableModels.find(
        (model) => modelKey(model.providerId, model.modelId) === selectedModelKey,
      ),
    [availableModels, selectedModelKey],
  );
  const supportedThinking = (selectedModel?.thinkingLevels ?? []).filter(isThinkingLevel);
  const savedModelKey =
    statusProvider === null ||
    statusProvider === undefined ||
    statusModel === null ||
    statusModel === undefined
      ? ""
      : modelKey(statusProvider, statusModel);
  const modelChanged = selectedModelKey !== savedModelKey || thinking !== statusThinking;

  const submitConnection = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const endpoint = url.trim();
    const credential = token.trim();
    if (endpoint.length === 0 || credential.length === 0) return;
    localStorage.setItem(endpointKey, endpoint);
    sessionStorage.setItem(tokenKey, credential);
    await onConnect(endpoint, credential);
  };

  const submitModel = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (selectedModel === undefined || thinking === "") return;
    await onSaveModel(selectedModel.providerId, selectedModel.modelId, thinking);
  };

  const selectModel = (nextModel: (typeof availableModels)[number]): void => {
    setSelectedModelKey(modelKey(nextModel.providerId, nextModel.modelId));
    const levels = nextModel.thinkingLevels.filter(isThinkingLevel);
    setThinking((current) =>
      current !== "" && levels.includes(current) ? current : (levels[0] ?? ""),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ziggy-settings-dialog sm:max-w-[680px]">
        <DialogHeader className="ziggy-settings-header">
          <DialogTitle>{profileName} settings</DialogTitle>
          <DialogDescription>
            {connected
              ? "Manage this browser connection and the Profile default used when sessions open."
              : `Connect to ${profileName} to open your conversations. Model and provider settings will appear once connected.`}
          </DialogDescription>
        </DialogHeader>

        <div className="ziggy-settings-body">
          {connected ? (
            <section className="ziggy-settings-block" aria-labelledby="model-heading">
              <div className="ziggy-settings-block-header">
                <span className="ziggy-settings-block-title">
                  <h3 id="model-heading">Default model</h3>
                  <small>
                    {statusProvider && statusModel
                      ? `Current: ${statusProvider}/${statusModel} · ${statusThinking}`
                      : modelSettings?.loading
                        ? "Loading model settings…"
                        : modelSettings?.status === undefined
                          ? "Model settings could not be loaded."
                          : "No default model selected."}
                  </small>
                </span>
              </div>
              {modelSettings?.loading ? <p role="status">Loading settings…</p> : null}
              {modelSettings?.error ? (
                <p className="form-error" role="alert">
                  {modelSettings.error}
                </p>
              ) : null}
              {!modelSettings?.loading &&
              (modelSettings?.status === undefined || modelSettings?.error) ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void onRetrySettings().catch(() => undefined)}
                >
                  Retry loading settings
                </Button>
              ) : null}
              {!modelSettings?.loading && modelSettings?.status !== undefined ? (
                <form onSubmit={(event) => void submitModel(event).catch(() => undefined)}>
                  <div className="ziggy-settings-fields">
                    <div className="ziggy-settings-field">
                      <span>Model</span>
                      <ModelPicker
                        disabled={
                          !connected || modelSettings?.loading || availableModels.length === 0
                        }
                        models={availableModels}
                        onSelect={selectModel}
                        selected={selectedModel}
                      />
                    </div>
                    <fieldset className="thinking-fieldset">
                      <legend>Thinking</legend>
                      <div className="thinking-options">
                        {selectedModel === undefined ? (
                          <p className="ziggy-settings-muted">
                            Choose an available model to see its thinking options.
                          </p>
                        ) : null}
                        {supportedThinking.map((level) => (
                          <label className="thinking-option" key={level}>
                            <input
                              checked={thinking === level}
                              disabled={!connected || selectedModel === undefined}
                              name="model-thinking"
                              onChange={() => setThinking(level)}
                              type="radio"
                              value={level}
                            />
                            <span>{level}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                  <p className="ziggy-settings-note">
                    <Info aria-hidden="true" />
                    <span>
                      New sessions use this default. Existing chats keep their current model until
                      the resident restarts.
                    </span>
                  </p>
                  <DialogFooter className="ziggy-settings-actions">
                    <Button
                      disabled={
                        !connected ||
                        modelSettings?.loading ||
                        modelSettings?.saving ||
                        selectedModel === undefined ||
                        thinking === "" ||
                        !modelChanged
                      }
                      type="submit"
                    >
                      {modelSettings?.saving ? "Saving…" : "Save model"}
                    </Button>
                  </DialogFooter>
                </form>
              ) : null}
            </section>
          ) : null}

          {connected && selectedRef?.kind === "live" ? (
            <section className="ziggy-settings-block" aria-label="Current session model">
              <h3>Current session</h3>
              <p className="ziggy-settings-muted">
                Changes here affect only this open session, not the Profile default.
              </p>
              {sessionBusy ? (
                <p role="status">Wait for the current turn to finish before switching.</p>
              ) : null}
              {sessionModel.error ? (
                <p className="form-error" role="alert">
                  {sessionModel.error}
                </p>
              ) : null}
              {sessionModel.value ? (
                <>
                  <p>
                    Current: {sessionModel.value.providerId ?? "No model"}/
                    {sessionModel.value.modelId ?? "—"} · {sessionModel.value.thinking}
                  </p>
                  <label>
                    Session model
                    <select
                      aria-label="Session model"
                      disabled={sessionBusy || sessionModel.pending}
                      value={modelKey(
                        sessionModel.value.providerId ?? "",
                        sessionModel.value.modelId ?? "",
                      )}
                      onChange={(event) => {
                        const model = availableModels.find(
                          (item) => modelKey(item.providerId, item.modelId) === event.target.value,
                        );
                        if (model) void onChangeSessionModel(model.providerId, model.modelId);
                      }}
                    >
                      {!availableModels.some(
                        (item) =>
                          modelKey(item.providerId, item.modelId) ===
                          modelKey(
                            sessionModel.value?.providerId ?? "",
                            sessionModel.value?.modelId ?? "",
                          ),
                      ) ? (
                        <option
                          value={modelKey(
                            sessionModel.value.providerId ?? "",
                            sessionModel.value.modelId ?? "",
                          )}
                        >
                          Current model
                        </option>
                      ) : null}
                      {availableModels.map((model) => (
                        <option
                          key={modelKey(model.providerId, model.modelId)}
                          value={modelKey(model.providerId, model.modelId)}
                        >
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Session thinking
                    <select
                      aria-label="Session thinking"
                      disabled={sessionBusy || sessionModel.pending}
                      value={sessionModel.value.thinking}
                      onChange={(event) => {
                        if (isThinkingLevel(event.target.value))
                          void onChangeSessionThinking(event.target.value);
                      }}
                    >
                      {thinkingLevels.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : sessionModel.pending ? (
                <p role="status">Loading session model…</p>
              ) : null}
            </section>
          ) : null}

          {connected &&
          selectedRef?.kind === "live" &&
          sessionSummaries.value?.canResume !== false ? (
            <section className="ziggy-settings-block" aria-label="Resume past session">
              <h3>Resume past session</h3>
              <p className="ziggy-settings-muted">
                Resume into this open conversation. A session held elsewhere cannot be resumed.
              </p>
              {sessionSummaries.error ? (
                <p className="form-error" role="alert">
                  {sessionSummaries.error}
                </p>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                disabled={sessionSummaries.pending}
                onClick={() => void onLoadSessionSummaries()}
              >
                Refresh sessions
              </Button>
              {sessionSummaries.value?.truncated ? (
                <p role="status">Showing the most recent 32 sessions.</p>
              ) : null}
              {sessionSummaries.value?.sessions.length === 0 ? (
                <p className="ziggy-settings-muted">No past sessions found.</p>
              ) : null}
              <div className="provider-list">
                {sessionSummaries.value?.sessions.map((session) => (
                  <div className="provider-row" key={session.id}>
                    <span>
                      <strong>{session.title}</strong>
                      <small>
                        {session.updatedAt} · {session.id}
                      </small>
                    </span>
                    {session.id === sessionSummaries.value?.currentSessionId ? (
                      <span className="settings-status">Open here</span>
                    ) : session.held ? (
                      <span className="settings-status">Held</span>
                    ) : null}
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={session.held || sessionBusy || sessionSummaries.pending}
                      onClick={() => void onResumePastSession(session.id)}
                    >
                      Resume
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="ziggy-settings-block" aria-labelledby="connection-heading">
            <div className="ziggy-settings-block-header">
              <span className="ziggy-settings-block-title">
                <h3 id="connection-heading">Connection</h3>
                <small>
                  {connected ? "Connected to the local resident" : "Connection required"}
                </small>
              </span>
              <span className={`settings-status ${connected ? "is-ready" : ""}`}>
                {connected ? "Connected" : "Offline"}
              </span>
            </div>
            {hosted ? (
              <div className="ziggy-connection-fields">
                <p className={pairingRequired ? "form-error" : "ziggy-settings-muted"}>
                  {pairingRequired
                    ? "This browser needs pairing. Open a fresh link from `ziggy web pair <profile>`."
                    : "This browser is paired with the local Ziggy resident."}
                </p>
              </div>
            ) : (
              <form onSubmit={(event) => void submitConnection(event)}>
                <div className="ziggy-connection-fields">
                  <label>
                    <span>WebSocket endpoint</span>
                    <input
                      autoComplete="url"
                      inputMode="url"
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="ws://127.0.0.1:8787/ws"
                      required
                      value={url}
                    />
                  </label>
                  <label>
                    <span>Runtime token</span>
                    <input
                      autoComplete="off"
                      onChange={(event) => setToken(event.target.value)}
                      placeholder="Paste token"
                      required
                      type="password"
                      value={token}
                    />
                  </label>
                  {connectionError === undefined ? null : (
                    <p className="form-error" role="alert">
                      {connectionError}
                    </p>
                  )}
                </div>
                <DialogFooter>
                  <Button
                    disabled={
                      connectionPending || url.trim().length === 0 || token.trim().length === 0
                    }
                    type="submit"
                    variant={connected ? "secondary" : "default"}
                  >
                    {connectionPending ? "Connecting…" : connected ? "Reconnect" : "Connect"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </section>

          {connected ? (
            <>
              <section className="ziggy-settings-block" aria-labelledby="providers-heading">
                <div className="ziggy-settings-block-header">
                  <span className="ziggy-settings-block-title">
                    <h3 id="providers-heading">Providers</h3>
                    <small>Credentials are managed on the Ziggy host.</small>
                  </span>
                </div>
                {!connected ? (
                  <p className="ziggy-settings-muted">Connect to inspect provider credentials.</p>
                ) : modelSettings?.loading && modelSettings.providers.length === 0 ? (
                  <p className="ziggy-settings-muted">Loading providers…</p>
                ) : configuredProviders.length > 0 || otherProviders.length > 0 ? (
                  <div className="provider-list">
                    {configuredProviders.map((provider) => (
                      <div className="provider-row" key={provider.id}>
                        <span>
                          <strong>{provider.name}</strong>
                          <small>{provider.type === "oauth" ? "OAuth" : "API key"}</small>
                        </span>
                        <span className="settings-status is-ready">Ready</span>
                      </div>
                    ))}
                    {otherProviders.length === 0 ? null : (
                      <details className="other-providers">
                        <summary>Other reported providers ({otherProviders.length})</summary>
                        {otherProviders.map((provider) => (
                          <div className="provider-row" key={provider.id}>
                            <span>
                              <strong>{provider.name}</strong>
                              <small>No credential</small>
                            </span>
                            <span className="settings-status">Not configured</span>
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                ) : (
                  <p className="ziggy-settings-muted">No providers reported.</p>
                )}
              </section>
              <section className="ziggy-settings-block" aria-label="Extensions">
                <h3>Extensions</h3>
                <p className="ziggy-settings-muted">Select Profile extensions.</p>
                {modelSettings?.extensions?.skipped.length ? (
                  <div role="alert" className="form-error">
                    <strong>
                      Some packages were skipped. Fix them, then restart the resident.
                    </strong>
                    {modelSettings.extensions.skipped.map((item, index) => (
                      <div key={`${item.id}-${index}`}>
                        <strong>{item.id}</strong>
                        {item.diagnostics.map((diagnostic, index) => (
                          <p key={`${item.id}-${index}`}>
                            {diagnostic.source}: {diagnostic.message}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
                {modelSettings?.restartRequired ? (
                  <p role="status">Restart the resident to apply extension changes.</p>
                ) : null}
                {modelSettings?.extensions?.truncated ? (
                  <p role="status">Extension list truncated; some entries are not shown.</p>
                ) : null}
                {modelSettings?.extensionNotice ? (
                  <p role="status">{modelSettings.extensionNotice}</p>
                ) : null}
                {modelSettings?.extensions === undefined ? (
                  <p className="ziggy-settings-muted">
                    {connected ? "Extension list unavailable." : "Connect to see extensions."}
                  </p>
                ) : modelSettings.extensions.available.length === 0 &&
                  modelSettings.extensions.selected.length === 0 ? (
                  <p className="ziggy-settings-muted">No extensions available.</p>
                ) : (
                  [
                    ...modelSettings.extensions.available,
                    ...modelSettings.extensions.selected
                      .filter(
                        (id) =>
                          !modelSettings.extensions?.available.some(
                            (extension) => extension.id === id,
                          ),
                      )
                      .map((id) => ({
                        id,
                        description: "Not in the current catalog",
                        source: "profile" as const,
                        kind: "code" as const,
                      })),
                  ].map((extension) => {
                    const enabled =
                      modelSettings.extensions?.selected.includes(extension.id) ?? false;
                    return (
                      <div className="settings-extension" key={extension.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={enabled}
                            disabled={modelSettings.extensionBusy !== undefined}
                            onChange={() => void onToggleExtension(extension.id, enabled)}
                          />
                          <strong>{extension.id}</strong>
                        </label>
                        <p className="ziggy-settings-muted">
                          {extension.description} · {extension.source}
                        </p>
                      </div>
                    );
                  })
                )}
              </section>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
