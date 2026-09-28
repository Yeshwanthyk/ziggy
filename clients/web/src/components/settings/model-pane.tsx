import { ModelPicker } from "@/components/model-picker";
import { Button } from "@/components/ui/button";
import { StepSlider } from "@/components/ui/step-slider";
import type { ModelSettingsState } from "@/gateway";
import type {
  ZiggyModelDescriptor,
  ZiggyModelThinkingLevel,
} from "../../../../../packages/ui-sdk/src/index";
import { LoaderCircle } from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Field, PaneHeader, isThinkingLevel, modelKey, thinkingSteps } from "./shared";

interface ModelPaneProps {
  readonly modelSettings?: ModelSettingsState;
  readonly onRetrySettings: () => Promise<void>;
  readonly onSaveModel: (
    providerId: string,
    modelId: string,
    thinking: ZiggyModelThinkingLevel,
  ) => Promise<void>;
}

export function ModelPane({ modelSettings, onRetrySettings, onSaveModel }: ModelPaneProps) {
  const modelLabelId = useId();
  const statusProvider = modelSettings?.status?.providerId ?? undefined;
  const statusModel = modelSettings?.status?.modelId ?? undefined;
  const statusThinking = modelSettings?.status?.thinking;
  const savedModelKey =
    statusProvider === undefined || statusModel === undefined
      ? ""
      : modelKey(statusProvider, statusModel);
  const [selectedModelKey, setSelectedModelKey] = useState(savedModelKey);
  const [thinking, setThinking] = useState<ZiggyModelThinkingLevel | "">("");

  useEffect(() => {
    setSelectedModelKey(savedModelKey);
    setThinking(
      statusThinking !== undefined && isThinkingLevel(statusThinking) ? statusThinking : "",
    );
  }, [savedModelKey, statusThinking]);

  const availableModels = modelSettings?.availableModels ?? [];
  const selectedModel = useMemo(
    () =>
      availableModels.find(
        (model) => modelKey(model.providerId, model.modelId) === selectedModelKey,
      ),
    [availableModels, selectedModelKey],
  );
  const steps = thinkingSteps(selectedModel?.thinkingLevels ?? []);
  const dirty = selectedModelKey !== savedModelKey || thinking !== statusThinking;
  // Settings that have never loaded are pending, not failed: the first load starts once the
  // connection and Profile are ready.
  const loading = modelSettings === undefined || modelSettings.loading;
  const saving = modelSettings?.saving === true;

  const selectModel = (next: ZiggyModelDescriptor): void => {
    setSelectedModelKey(modelKey(next.providerId, next.modelId));
    const levels = next.thinkingLevels.filter(isThinkingLevel);
    setThinking((current) =>
      current !== "" && levels.includes(current) ? current : (levels[0] ?? ""),
    );
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (selectedModel === undefined || thinking === "") return;
    await onSaveModel(selectedModel.providerId, selectedModel.modelId, thinking);
  };

  const unavailable = !loading && (modelSettings?.status === undefined || modelSettings.error);

  return (
    <form className="settings-pane" onSubmit={(event) => void submit(event).catch(() => undefined)}>
      <div className="settings-pane-body">
        <PaneHeader
          description="New sessions start with this model. Open chats keep theirs until the resident restarts."
          title="Default model"
        />
        {loading ? (
          <p className="settings-muted" role="status">
            Loading model settings…
          </p>
        ) : null}
        {modelSettings?.error ? (
          <p className="form-error" role="alert">
            {modelSettings.error}
          </p>
        ) : null}
        {unavailable ? (
          <div className="settings-empty">
            <p>
              {modelSettings?.status === undefined
                ? "Model settings could not be loaded."
                : "Model settings may be out of date."}
            </p>
            <Button
              onClick={() => void onRetrySettings().catch(() => undefined)}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry loading settings
            </Button>
          </div>
        ) : null}
        {!loading && modelSettings?.status !== undefined ? (
          <div className="settings-fields">
            <Field
              hint={
                availableModels.length === 0
                  ? "No models are available. Configure a provider on the Ziggy host."
                  : undefined
              }
              label="Model"
              labelId={modelLabelId}
            >
              <ModelPicker
                aria-labelledby={modelLabelId}
                disabled={availableModels.length === 0 || saving}
                models={availableModels}
                onSelect={selectModel}
                selected={selectedModel}
              />
            </Field>
            {selectedModel === undefined ? (
              <p className="settings-muted">Choose a model to see its thinking levels.</p>
            ) : (
              <StepSlider
                disabled={saving}
                endLabel="Smarter"
                label="Thinking"
                onValueChange={setThinking}
                startLabel="Faster"
                steps={steps}
                value={thinking === "" ? undefined : thinking}
              />
            )}
          </div>
        ) : null}
      </div>
      {!loading && modelSettings?.status !== undefined ? (
        <div className="settings-pane-footer">
          <span className="settings-footer-note" aria-live="polite">
            {dirty ? "Unsaved changes" : ""}
          </span>
          <Button
            disabled={saving || selectedModel === undefined || thinking === "" || !dirty}
            size="sm"
            type="submit"
          >
            {saving ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
            Save model
          </Button>
        </div>
      ) : null}
    </form>
  );
}
