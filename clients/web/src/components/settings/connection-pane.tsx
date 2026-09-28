import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Field, PaneHeader, profileCommandArgument } from "./shared";

const endpointKey = "ziggy.web.endpoint";
const tokenKey = "ziggy.web.session-token";
const defaultEndpoint = "ws://127.0.0.1:8787/ws";

interface SavedConnection {
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

interface ConnectionPaneProps {
  readonly connected: boolean;
  readonly connectionError?: string;
  readonly connectionPending: boolean;
  readonly hosted: boolean;
  readonly pairingRequired: boolean;
  readonly profileName: string;
  readonly cliTarget?: string | undefined;
  readonly onConnect: (url: string, token: string) => Promise<void>;
}

export function ConnectionPane({
  connected,
  connectionError,
  connectionPending,
  hosted,
  pairingRequired,
  profileName,
  cliTarget,
  onConnect,
}: ConnectionPaneProps) {
  const [url, setUrl] = useState(
    () => readSavedConnection()?.url ?? localStorage.getItem(endpointKey) ?? defaultEndpoint,
  );
  const [token, setToken] = useState(() => readSavedConnection()?.token ?? "");
  const ready = url.trim().length > 0 && token.trim().length > 0;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const endpoint = url.trim();
    const credential = token.trim();
    if (endpoint.length === 0 || credential.length === 0) return;
    localStorage.setItem(endpointKey, endpoint);
    sessionStorage.setItem(tokenKey, credential);
    await onConnect(endpoint, credential);
  };

  const header = (
    <PaneHeader
      aside={
        <Badge variant={connected ? "success" : "outline"}>
          {connected ? "Connected" : "Offline"}
        </Badge>
      }
      description={
        connected
          ? `This browser is connected to the ${profileName} resident.`
          : `Connect to ${profileName} to open your conversations.`
      }
      title="Connection"
    />
  );

  if (hosted) {
    return (
      <div className="settings-pane">
        <div className="settings-pane-body">
          {header}
          {pairingRequired ? (
            <div className="settings-callout" data-tone="danger">
              <p>This browser needs pairing. Open a fresh link from:</p>
              <code>ziggy web pair {profileCommandArgument(cliTarget)}</code>
            </div>
          ) : (
            <p className="settings-muted">This browser is paired with the local Ziggy resident.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <form className="settings-pane" onSubmit={(event) => void submit(event)}>
      <div className="settings-pane-body">
        {header}
        <div className="settings-fields">
          <Field label="WebSocket endpoint">
            <input
              aria-label="WebSocket endpoint"
              autoComplete="url"
              className="settings-input"
              inputMode="url"
              onChange={(event) => setUrl(event.target.value)}
              placeholder={defaultEndpoint}
              required
              value={url}
            />
          </Field>
          <Field hint="Kept for this browser tab only." label="Runtime token">
            <input
              aria-label="Runtime token"
              autoComplete="off"
              className="settings-input"
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste token"
              required
              type="password"
              value={token}
            />
          </Field>
          {connectionError === undefined ? null : (
            <p className="form-error" role="alert">
              {connectionError}
            </p>
          )}
        </div>
      </div>
      <div className="settings-pane-footer">
        <span />
        <Button
          disabled={connectionPending || !ready}
          size="sm"
          type="submit"
          variant={connected ? "outline" : "default"}
        >
          {connectionPending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
          {connected ? "Reconnect" : "Connect"}
        </Button>
      </div>
    </form>
  );
}
