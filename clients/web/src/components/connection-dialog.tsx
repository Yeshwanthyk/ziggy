import { PrismArt } from "@/components/prism-art";
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
import type { ZiggyModelThinkingLevel } from "../../../../packages/ui-sdk/src/index";
import { Info } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import "./connection-dialog.css";

interface SettingsDialogProps {
  readonly connected: boolean;
  readonly connectionError?: string;
  readonly connectionPending: boolean;
  readonly modelSettings?: ModelSettingsState;
  readonly open: boolean;
  readonly profileName: string;
  readonly onConnect: (url: string, token: string) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
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
  open,
  profileName,
  onConnect,
  onOpenChange,
  onSaveModel,
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
            Manage this browser connection and the Profile default used when sessions open.
          </DialogDescription>
        </DialogHeader>

        <div className="ziggy-settings-body">
          <PrismArt />
          <section className="ziggy-settings-block" aria-labelledby="model-heading">
            <div className="ziggy-settings-block-header">
              <span className="ziggy-settings-block-title">
                <h3 id="model-heading">Default model</h3>
                <small>
                  {statusProvider && statusModel
                    ? `Current: ${statusProvider}/${statusModel} · ${statusThinking}`
                    : modelSettings?.loading
                      ? "Loading model settings…"
                      : "The runtime could not report a usable Profile default."}
                </small>
              </span>
            </div>
            <form onSubmit={(event) => void submitModel(event).catch(() => undefined)}>
              <div className="ziggy-settings-fields">
                <div className="ziggy-settings-field">
                  <span>Model</span>
                  <ModelPicker
                    disabled={!connected || modelSettings?.loading || availableModels.length === 0}
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
                  New sessions use this default. Existing chats keep their current model until the
                  resident restarts.
                </span>
              </p>
              {modelSettings?.error === undefined ? null : (
                <p className="form-error" role="alert">
                  {modelSettings.error}
                </p>
              )}
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
          </section>

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
                  variant="secondary"
                >
                  {connectionPending ? "Connecting…" : connected ? "Reconnect" : "Connect"}
                </Button>
              </DialogFooter>
            </form>
          </section>

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
            <p className="ziggy-settings-muted">
              Selected for this Profile. Existing sessions may need to restart to pick up changes.
            </p>
            {modelSettings?.extensions === undefined ? (
              <p className="ziggy-settings-muted">
                {connected ? "Extension list unavailable." : "Connect to see extensions."}
              </p>
            ) : modelSettings.extensions.selected.length === 0 ? (
              <p className="ziggy-settings-muted">No extensions selected.</p>
            ) : (
              modelSettings.extensions.selected.map((id) => {
                const extension = modelSettings.extensions?.available.find(
                  (item) => item.id === id,
                );
                return (
                  <div className="settings-extension" key={id}>
                    <strong>{id}</strong>
                    <p className="ziggy-settings-muted">{extension?.description}</p>
                  </div>
                );
              })
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
