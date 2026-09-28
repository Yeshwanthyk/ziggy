import { Switch } from "@/components/ui/switch";
import type { ModelSettingsState } from "@/gateway";
import { PaneHeader } from "./shared";

interface ExtensionsPaneProps {
  readonly modelSettings?: ModelSettingsState;
  readonly onToggleExtension: (id: string, enabled: boolean) => Promise<void>;
}

export function ExtensionsPane({ modelSettings, onToggleExtension }: ExtensionsPaneProps) {
  const extensions = modelSettings?.extensions;
  const rows =
    extensions === undefined
      ? []
      : [
          ...extensions.available,
          ...extensions.selected
            .filter((id) => !extensions.available.some((extension) => extension.id === id))
            .map((id) => ({
              id,
              description: "Not in the current catalog",
              source: "profile" as const,
              kind: "code" as const,
            })),
        ];

  return (
    <div className="settings-pane">
      <div className="settings-pane-body">
        <PaneHeader description="Choose which extensions this Profile loads." title="Extensions" />
        {extensions?.skipped.length ? (
          <div className="form-error" role="alert">
            <strong>Some packages were skipped. Fix them, then restart the resident.</strong>
            {extensions.skipped.map((item, index) => (
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
        {extensions?.truncated ? (
          <p role="status">Extension list truncated; some entries are not shown.</p>
        ) : null}
        {modelSettings?.extensionNotice ? (
          <p role="status">{modelSettings.extensionNotice}</p>
        ) : null}
        {extensions === undefined ? (
          <p className="settings-muted">Extension list unavailable.</p>
        ) : rows.length === 0 ? (
          <p className="settings-muted">No extensions available.</p>
        ) : (
          rows.map((extension) => {
            const enabled = extensions.selected.includes(extension.id);
            return (
              <div className="settings-extension" key={extension.id}>
                <label>
                  <Switch
                    checked={enabled}
                    disabled={modelSettings?.extensionBusy !== undefined}
                    onChange={() => void onToggleExtension(extension.id, enabled)}
                  />
                  <strong>{extension.id}</strong>
                </label>
                <p className="settings-muted">
                  {extension.description} · {extension.source}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
