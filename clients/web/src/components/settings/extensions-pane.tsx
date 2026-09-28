import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ModelSettingsState } from "@/gateway";
import type { ZiggyExtensionChoice } from "../../../../../packages/ui-sdk/src/index";
import { AlertTriangle, Check, Copy, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PaneHeader, profileCommandArgument } from "./shared";

interface ExtensionsPaneProps {
  readonly modelSettings?: ModelSettingsState;
  readonly cliTarget?: string | undefined;
  readonly onToggleExtension: (id: string, enabled: boolean) => Promise<void>;
}

type Filter = "all" | "enabled" | ZiggyExtensionChoice["source"];

const sourceLabels: Readonly<Record<ZiggyExtensionChoice["source"], string>> = {
  bundled: "Bundled",
  profile: "Profile",
  "remote-approved": "Remote",
};

interface Row {
  readonly id: string;
  readonly description: string;
  readonly source: ZiggyExtensionChoice["source"];
  readonly problem?: string;
}

export function ExtensionsPane({
  modelSettings,
  cliTarget,
  onToggleExtension,
}: ExtensionsPaneProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const extensions = modelSettings?.extensions;
  const skipped = new Set(extensions?.skipped.map((item) => item.id));

  const rows: ReadonlyArray<Row> =
    extensions === undefined
      ? []
      : [
          ...extensions.available.map((extension) => ({
            id: extension.id,
            description: extension.description,
            source: extension.source,
            ...(skipped.has(extension.id) ? { problem: "Skipped at load; see above." } : {}),
          })),
          ...extensions.selected
            .filter((id) => !extensions.available.some((extension) => extension.id === id))
            .map((id) => ({
              id,
              description: "",
              // Selected ids outside the catalog come from the Profile's own extension list.
              source: "profile" as const,
              problem: skipped.has(id)
                ? "Skipped at load; see above."
                : "Not in the current catalog",
            })),
        ];

  const sources = [...new Set(rows.map((row) => row.source))];
  const filters: ReadonlyArray<{ readonly id: Filter; readonly label: string }> = [
    { id: "all", label: "All" },
    { id: "enabled", label: "Enabled" },
    ...(sources.length > 1
      ? sources.map((source) => ({ id: source, label: sourceLabels[source] }))
      : []),
  ];
  const needle = query.trim().toLocaleLowerCase();
  const visible = rows.filter(
    (row) =>
      (filter === "all" ||
        (filter === "enabled" ? extensions?.selected.includes(row.id) : row.source === filter)) &&
      (needle.length === 0 ||
        row.id.toLocaleLowerCase().includes(needle) ||
        row.description.toLocaleLowerCase().includes(needle)),
  );
  const busy = modelSettings?.extensionBusy !== undefined;

  return (
    <div className="settings-pane">
      <div className="settings-pane-body">
        <PaneHeader
          description="Choose which extensions this Profile loads. Changes save right away and take effect after a restart."
          title="Extensions"
        />
        {extensions?.skipped.length ? (
          <div className="settings-callout" data-tone="warning" role="alert">
            <p className="settings-callout-title">
              <AlertTriangle aria-hidden="true" />
              <strong>Some packages were skipped. Fix them, then restart the resident.</strong>
            </p>
            {extensions.skipped.map((item, index) => (
              <div className="settings-callout-item" key={`${item.id}-${index}`}>
                <strong>{item.id}</strong>
                {item.diagnostics.map((diagnostic, index) => (
                  <p key={`${item.id}-${index}`}>
                    <code>{diagnostic.source}</code>: {diagnostic.message}
                  </p>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        {extensions === undefined ? (
          <p className="settings-muted">Extension list unavailable.</p>
        ) : rows.length === 0 ? (
          <p className="settings-muted">No extensions available.</p>
        ) : (
          <div className="settings-extensions">
            <div className="settings-toolbar">
              <label className="settings-search">
                <Search aria-hidden="true" />
                <input
                  aria-label="Filter extensions"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter extensions"
                  type="search"
                  value={query}
                />
              </label>
              <div aria-label="Show" className="chip-group" role="group">
                {filters.map((entry) => (
                  <button
                    aria-pressed={filter === entry.id}
                    key={entry.id}
                    onClick={() => setFilter(entry.id)}
                    type="button"
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
            {visible.length === 0 ? (
              <p className="settings-muted settings-extensions-empty">No matching extensions.</p>
            ) : (
              <ul className="settings-list">
                {visible.map((row) => {
                  const enabled = extensions.selected.includes(row.id);
                  return (
                    <li className="settings-row settings-extension" key={row.id}>
                      <span className="settings-row-text">
                        <span className="settings-extension-name">
                          <strong>{row.id}</strong>
                          <Badge>{sourceLabels[row.source]}</Badge>
                        </span>
                        {row.problem === undefined ? (
                          <small title={row.description}>{row.description}</small>
                        ) : (
                          <small className="settings-extension-problem">
                            <AlertTriangle aria-hidden="true" />
                            {row.problem}
                          </small>
                        )}
                      </span>
                      <Switch
                        aria-label={row.id}
                        checked={enabled}
                        disabled={busy}
                        onChange={() => void onToggleExtension(row.id, enabled)}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {extensions?.truncated ? (
          <p className="settings-muted" role="status">
            Extension list truncated; some entries are not shown.
          </p>
        ) : null}
      </div>
      {modelSettings?.restartRequired ? (
        <RestartBar cliTarget={cliTarget} />
      ) : modelSettings?.extensionNotice ? (
        <div className="settings-pane-footer">
          <p className="settings-footer-note" role="status">
            {modelSettings.extensionNotice}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function RestartBar({ cliTarget }: { readonly cliTarget: string | undefined }) {
  const command = `ziggy serve restart ${profileCommandArgument(cliTarget)}`;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const codeRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Without clipboard access, select the command so the person can copy it themselves.
  const selectCommand = (): void => {
    const code = codeRef.current;
    const selection = window.getSelection();
    if (code === null || selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const copy = async (): Promise<void> => {
    clearTimeout(timer.current);
    try {
      if (navigator.clipboard === undefined) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
      timer.current = setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      selectCommand();
      setCopyState("manual");
    }
  };

  const copied = copyState === "copied";

  return (
    <div className="settings-pane-footer settings-restart">
      <div className="settings-restart-text">
        <p role="status">Restart the resident to apply extension changes.</p>
        <code ref={codeRef} title={command}>
          {command}
        </code>
        {copyState === "manual" ? (
          <small className="settings-muted" role="status">
            Select and copy
          </small>
        ) : null}
      </div>
      <Button
        aria-label={copied ? "Copied restart command" : "Copy restart command"}
        onClick={() => void copy()}
        size="sm"
        type="button"
        variant="outline"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
