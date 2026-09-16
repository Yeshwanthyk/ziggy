import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  parseDefinitionSource,
  updateDefinitionSource,
  agentFieldKeys,
  automationFieldKeys,
  type DefinitionFieldKey,
  type DefinitionFields,
} from "@/lib/definition-source";

interface DefinitionEditorProps {
  readonly kind?: "agent" | "automation";
  readonly onCancel: () => void;
  readonly onSave: (source: string, expectedSource: string) => Promise<void>;
  readonly source: string;
}

const automationFieldLabels: ReadonlyArray<{
  readonly key: DefinitionFieldKey;
  readonly label: string;
  readonly placeholder?: string;
  readonly required?: boolean;
}> = [
  { key: "version", label: "Version", required: true },
  { key: "cron", label: "Cron schedule", placeholder: "0 8 * * *", required: true },
  { key: "timezone", label: "Timezone", placeholder: "America/Toronto", required: true },
  { key: "gate", label: "Gate", placeholder: "true" },
  { key: "broadcast", label: "Broadcast", placeholder: "none", required: true },
  { key: "origin", label: "Origin" },
  { key: "owner", label: "Owner" },
  { key: "provider", label: "Provider" },
  { key: "model", label: "Model" },
  { key: "thinking", label: "Thinking", placeholder: "medium" },
];

const agentFieldLabels: ReadonlyArray<{
  readonly key: DefinitionFieldKey;
  readonly label: string;
  readonly placeholder?: string;
  readonly required?: boolean;
}> = [
  { key: "version", label: "Version", required: true },
  { key: "description", label: "Description", required: true },
  { key: "provider", label: "Provider" },
  { key: "model", label: "Model" },
  { key: "thinking", label: "Thinking", placeholder: "medium" },
  { key: "tools", label: "Tools", placeholder: "read, bash" },
];

export function DefinitionEditor({
  kind = "automation",
  onCancel,
  onSave,
  source,
}: DefinitionEditorProps) {
  const fieldKeys = kind === "agent" ? agentFieldKeys : automationFieldKeys;
  const fieldLabels = kind === "agent" ? agentFieldLabels : automationFieldLabels;
  const parsed = parseDefinitionSource(source, fieldKeys);
  const [mode, setMode] = useState<"fields" | "source">(parsed.structured ? "fields" : "source");
  const [fields, setFields] = useState<DefinitionFields>(parsed.fields);
  const [task, setTask] = useState(parsed.task);
  const [structuredBase, setStructuredBase] = useState(source);
  const [fullSource, setFullSource] = useState(source);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const setField = (key: DefinitionFieldKey, value: string): void => {
    setFields((current) => ({ ...current, [key]: value }));
  };

  const switchMode = (next: "fields" | "source"): void => {
    if (next === mode) return;
    setError(undefined);
    if (next === "source") {
      setFullSource(updateDefinitionSource(structuredBase, fields, task, fieldKeys));
      setMode(next);
      return;
    }
    const nextParsed = parseDefinitionSource(fullSource, fieldKeys);
    if (!nextParsed.structured) {
      setError("Add valid opening and closing --- lines before using field mode.");
      return;
    }
    setFields(nextParsed.fields);
    setTask(nextParsed.task);
    setStructuredBase(fullSource);
    setMode(next);
  };

  const save = async (): Promise<void> => {
    const nextSource =
      mode === "source"
        ? fullSource
        : updateDefinitionSource(structuredBase, fields, task, fieldKeys);
    if (mode === "fields") {
      if (
        fields.version.trim() !== "1" ||
        (kind === "automation" &&
          (fields.cron.trim().length === 0 ||
            fields.timezone.trim().length === 0 ||
            fields.broadcast.trim().length === 0)) ||
        (kind === "agent" && fields.description.trim().length === 0) ||
        task.trim().length === 0
      ) {
        setError(
          kind === "agent"
            ? "Version 1, description, and instructions are required."
            : "Version 1, cron, timezone, broadcast, and task are required.",
        );
        return;
      }
      if ((fields.provider.trim().length === 0) !== (fields.model.trim().length === 0)) {
        setError("Provider and model must be set together.");
        return;
      }
    }
    setSaving(true);
    setError(undefined);
    try {
      await onSave(nextSource, source);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The definition could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="definition-editor">
      <div className="editor-mode" role="group" aria-label="Definition editor mode">
        <Button
          disabled={saving}
          onClick={() => switchMode("fields")}
          size="sm"
          type="button"
          variant={mode === "fields" ? "secondary" : "ghost"}
        >
          Fields
        </Button>
        <Button
          disabled={saving}
          onClick={() => switchMode("source")}
          size="sm"
          type="button"
          variant={mode === "source" ? "secondary" : "ghost"}
        >
          Full source
        </Button>
      </div>
      {mode === "source" ? (
        <Textarea
          aria-label="Full automation definition"
          className="source-editor"
          disabled={saving}
          onChange={(event) => setFullSource(event.target.value)}
          spellCheck={false}
          value={fullSource}
        />
      ) : (
        <div className="definition-fields">
          {fieldLabels.map((field) => (
            <label className="field-label" key={field.key}>
              <span>{field.label}</span>
              <input
                disabled={saving || field.key === "version"}
                onChange={(event) => setField(field.key, event.target.value)}
                placeholder={field.placeholder}
                required={field.required}
                value={fields[field.key]}
              />
            </label>
          ))}
          <label className="field-label definition-task">
            <span>{kind === "agent" ? "Instructions" : "Task"}</span>
            <Textarea
              disabled={saving}
              onChange={(event) => setTask(event.target.value)}
              placeholder={
                kind === "agent"
                  ? "Describe how this agent should work."
                  : "Describe what this automation should do."
              }
              required
              value={task}
            />
          </label>
        </div>
      )}
      {error === undefined ? null : (
        <p className="detail-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-actions">
        <Button disabled={saving} onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={saving} onClick={() => void save()} type="button">
          {saving ? "Saving…" : "Save definition"}
        </Button>
      </div>
    </div>
  );
}
