import { Combobox } from "@/components/ui/combobox";
import type { ZiggyModelDescriptor } from "../../../../packages/ui-sdk/src/index";
import { useMemo, useState } from "react";

interface ModelPickerProps {
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  readonly disabled: boolean;
  readonly models: ReadonlyArray<ZiggyModelDescriptor>;
  readonly onSelect: (model: ZiggyModelDescriptor) => void;
  readonly selected?: ZiggyModelDescriptor;
}

interface ProviderGroup {
  readonly providerId: string;
  readonly models: ReadonlyArray<ZiggyModelDescriptor>;
}

const normalizeSearch = (value: string): string => value.trim().toLocaleLowerCase();

const providerPartName = (part: string): string => {
  const normalized = part.toLocaleLowerCase();
  if (normalized === "openai") return "OpenAI";
  if (normalized === "api") return "API";
  return `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`;
};

const displayProviderName = (providerId: string): string =>
  providerId
    .split(/[-_]/u)
    .filter((part) => part.length > 0)
    .map(providerPartName)
    .join(" ");

export function ModelPicker({
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  disabled,
  models,
  onSelect,
  selected,
}: ModelPickerProps) {
  const [query, setQuery] = useState("");

  const groups = useMemo<ReadonlyArray<ProviderGroup>>(() => {
    const normalizedQuery = normalizeSearch(query);
    const matches = models.filter((model) => {
      if (normalizedQuery.length === 0) return true;
      return `${model.name} ${model.providerId} ${model.modelId}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
    const providerIds = [...new Set(matches.map((model) => model.providerId))].sort((a, b) =>
      a.localeCompare(b),
    );
    return providerIds.map((providerId) => ({
      providerId,
      models: matches
        .filter((model) => model.providerId === providerId)
        .sort((a, b) => a.name.localeCompare(b.name) || a.modelId.localeCompare(b.modelId)),
    }));
  }, [models, query]);

  return (
    <Combobox
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      empty={
        <>
          <strong>No matching models</strong>
          <span>Try a model name, ID, or provider.</span>
        </>
      }
      groups={groups.map((group) => ({
        key: group.providerId,
        heading: displayProviderName(group.providerId),
        options: group.models.map((model) => ({
          key: `${model.providerId}/${model.modelId}`,
          value: model,
          selected: selected?.providerId === model.providerId && selected.modelId === model.modelId,
          content: (
            <>
              <span className="ui-combobox-label">{model.name}</span>
              <span className="ui-combobox-meta" data-mono="">
                {model.modelId}
              </span>
            </>
          ),
        })),
      }))}
      onClose={() => setQuery("")}
      onQueryChange={setQuery}
      onSelect={onSelect}
      popoverLabel="Choose a model"
      query={query}
      searchLabel="Search models"
      searchPlaceholder="Search models"
    >
      {selected === undefined ? (
        <span className="ui-combobox-placeholder">Choose an available model</span>
      ) : (
        <>
          <span className="ui-combobox-label">{selected.name}</span>
          <span className="ui-combobox-meta">{displayProviderName(selected.providerId)}</span>
        </>
      )}
    </Combobox>
  );
}
