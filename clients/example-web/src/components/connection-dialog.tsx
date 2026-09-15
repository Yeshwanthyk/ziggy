import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEffect, useState, type FormEvent } from "react";

interface ConnectionDialogProps {
  readonly error?: string;
  readonly open: boolean;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConnect: (url: string, token: string) => Promise<void>;
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

export function ConnectionDialog({
  error,
  open,
  pending,
  onOpenChange,
  onConnect,
}: ConnectionDialogProps) {
  const [url, setUrl] = useState("ws://127.0.0.1:8787/ws");
  const [token, setToken] = useState("");

  useEffect(() => {
    const saved = readSavedConnection();
    setUrl(saved?.url ?? localStorage.getItem(endpointKey) ?? "ws://127.0.0.1:8787/ws");
    setToken(saved?.token ?? "");
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const endpoint = url.trim();
    const credential = token.trim();
    if (endpoint.length === 0 || credential.length === 0) return;
    localStorage.setItem(endpointKey, endpoint);
    sessionStorage.setItem(tokenKey, credential);
    await onConnect(endpoint, credential);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="connection-dialog sm:max-w-[420px]">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Connect to Squarey</DialogTitle>
            <DialogDescription>
              Use the endpoint and runtime token from the local Ziggy host. The token stays in this
              browser tab. After restarting Ziggy, use its new endpoint and token.
            </DialogDescription>
          </DialogHeader>
          <div className="connection-fields">
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
            {error === undefined ? null : (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              disabled={pending || url.trim().length === 0 || token.trim().length === 0}
              type="submit"
            >
              {pending ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
