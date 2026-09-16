import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ZiggyModelDescriptor } from "../../../../packages/ui-sdk/src/index";
import { Check, ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";

interface ModelPickerProps {
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

export function ModelPicker({ disabled, models, onSelect, selected }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
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

  const chooseModel = (model: ZiggyModelDescriptor): void => {
    onSelect(model);
    setOpen(false);
    setQuery("");
  };

  return (
    <>
      <Button
        aria-haspopup="dialog"
        className="model-picker-trigger"
        disabled={disabled}
        onClick={() => setOpen(true)}
        type="button"
        variant="outline"
      >
        <span className="model-picker-trigger-copy">
          {selected === undefined ? (
            <span className="model-picker-placeholder">Choose an available model</span>
          ) : (
            <>
              <strong>{selected.name}</strong>
              <small>
                {selected.providerId}/{selected.modelId}
              </small>
            </>
          )}
        </span>
        <ChevronDown aria-hidden="true" />
      </Button>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setQuery("");
        }}
      >
        <DialogContent className="model-picker-dialog sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>Choose a model</DialogTitle>
            <DialogDescription>
              Search the models available through this Ziggy resident.
            </DialogDescription>
          </DialogHeader>

          <label className="model-picker-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Search models</span>
            <input
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by model or provider"
              type="search"
              value={query}
            />
            {query.length === 0 ? null : <kbd>Esc</kbd>}
          </label>

          <ScrollArea className="model-picker-scroll">
            {groups.length === 0 ? (
              <div className="model-picker-empty">
                <Search aria-hidden="true" />
                <strong>No matching models</strong>
                <span>Try a model name, ID, or provider.</span>
              </div>
            ) : (
              <div className="model-picker-groups">
                {groups.map((group) => (
                  <section aria-labelledby={`provider-${group.providerId}`} key={group.providerId}>
                    <div className="model-picker-provider-heading">
                      <h3 id={`provider-${group.providerId}`}>
                        {displayProviderName(group.providerId)}
                      </h3>
                      <span>{group.models.length}</span>
                    </div>
                    <div className="model-picker-options">
                      {group.models.map((model) => {
                        const isSelected =
                          selected?.providerId === model.providerId &&
                          selected.modelId === model.modelId;
                        return (
                          <button
                            aria-pressed={isSelected}
                            className="model-picker-option"
                            key={`${model.providerId}/${model.modelId}`}
                            onClick={() => chooseModel(model)}
                            type="button"
                          >
                            <span>
                              <strong>{model.name}</strong>
                              <small>{model.modelId}</small>
                            </span>
                            {isSelected ? <Check aria-hidden="true" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
