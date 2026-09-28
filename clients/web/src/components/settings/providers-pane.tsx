import { Badge } from "@/components/ui/badge";
import type { ModelSettingsState } from "@/gateway";
import { ChevronRight } from "lucide-react";
import { PaneHeader } from "./shared";

export function ProvidersPane({ modelSettings }: { readonly modelSettings?: ModelSettingsState }) {
  const providers = modelSettings?.providers ?? [];
  const configured = providers.filter((provider) => provider.configured);
  const others = providers.filter((provider) => !provider.configured);

  return (
    <div className="settings-pane">
      <div className="settings-pane-body">
        <PaneHeader
          description="Credentials are managed on the Ziggy host, never in the browser."
          title="Providers"
        />
        {modelSettings?.loading && providers.length === 0 ? (
          <p className="settings-muted">Loading providers…</p>
        ) : providers.length === 0 ? (
          <p className="settings-muted">No providers reported.</p>
        ) : (
          <>
            {configured.length === 0 ? (
              <p className="settings-muted">No provider has a credential yet.</p>
            ) : (
              <ul className="settings-list">
                {configured.map((provider) => (
                  <li className="settings-row" key={provider.id}>
                    <span className="settings-row-text">
                      <strong>{provider.name}</strong>
                      <small>{provider.type === "oauth" ? "OAuth" : "API key"}</small>
                    </span>
                    <Badge variant="success">Ready</Badge>
                  </li>
                ))}
              </ul>
            )}
            {others.length === 0 ? null : (
              <details className="settings-disclosure">
                <summary>
                  <ChevronRight aria-hidden="true" />
                  Other providers
                  <span>{others.length}</span>
                </summary>
                <ul className="settings-list">
                  {others.map((provider) => (
                    <li className="settings-row" key={provider.id}>
                      <span className="settings-row-text">
                        <strong>{provider.name}</strong>
                        <small>No credential</small>
                      </span>
                      <Badge variant="outline">Not configured</Badge>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
