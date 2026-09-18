import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AutomationDestinationOption } from "@/gateway";
import { Bot, Check, ChevronDown, Hash, MessageCircle, Pin, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

type DestinationFilter = "all" | "pinned" | "agent" | "session" | "slack" | "discord" | "telegram";

interface DestinationGroup {
  readonly id: Exclude<DestinationFilter, "all">;
  readonly label: string;
  readonly entries: ReadonlyArray<AutomationDestinationOption>;
}

interface AutomationDestinationPickerProps {
  readonly destinations: ReadonlyArray<AutomationDestinationOption>;
  readonly disabled: boolean;
  readonly onSelect: (destination: AutomationDestinationOption) => void;
  readonly selected?: AutomationDestinationOption;
}

const filters: ReadonlyArray<{ readonly id: DestinationFilter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "pinned", label: "Pinned" },
  { id: "agent", label: "Agents" },
  { id: "session", label: "Sessions" },
  { id: "slack", label: "Slack" },
  { id: "discord", label: "Discord" },
  { id: "telegram", label: "Telegram" },
];

const groupLabels = {
  pinned: "Pinned",
  agent: "Agents",
  session: "Sessions",
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
} as const satisfies Record<Exclude<DestinationFilter, "all">, string>;

const normalized = (value: string): string => value.trim().toLocaleLowerCase();

const labelFor = (destination: AutomationDestinationOption): string =>
  destination.label ?? destination.agentId ?? destination.target;

const contextFor = (destination: AutomationDestinationOption): string => {
  if (destination.category === "agent") {
    return destination.agentId === undefined
      ? "Agent conversation"
      : `Agent · ${destination.agentId}`;
  }
  if (destination.category === "session") return "Conversation history";
  const address = destination.target.split(":").slice(2).join(":");
  return `${groupLabels[destination.category]} · ${address}`;
};

const activityFor = (
  destination: AutomationDestinationOption,
): { readonly label: string; readonly title: string } | undefined => {
  if (destination.activityAt === undefined) return undefined;
  const value = new Date(destination.activityAt);
  if (!Number.isFinite(value.getTime())) return undefined;
  return {
    label: new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: value.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    }).format(value),
    title: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(value),
  };
};

const DestinationContext = ({
  destination,
}: {
  readonly destination: AutomationDestinationOption;
}) => {
  const activity = activityFor(destination);
  return (
    <small>
      {contextFor(destination)}
      {activity === undefined ? null : (
        <>
          {" · "}
          <time dateTime={destination.activityAt} title={activity.title}>
            {activity.label}
          </time>
        </>
      )}
    </small>
  );
};

const activityTime = (destination: AutomationDestinationOption): number => {
  if (destination.activityAt === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(destination.activityAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const compareDestinations = (
  left: AutomationDestinationOption,
  right: AutomationDestinationOption,
): number =>
  activityTime(right) - activityTime(left) ||
  labelFor(left).localeCompare(labelFor(right)) ||
  left.target.localeCompare(right.target);

const iconFor = (group: DestinationGroup["id"]): ReactNode => {
  if (group === "pinned") return <Pin aria-hidden="true" />;
  if (group === "agent") return <Bot aria-hidden="true" />;
  if (group === "session") return <MessageCircle aria-hidden="true" />;
  return <Hash aria-hidden="true" />;
};

export function AutomationDestinationPicker({
  destinations,
  disabled,
  onSelect,
  selected,
}: AutomationDestinationPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DestinationFilter>("all");

  const groups = useMemo<ReadonlyArray<DestinationGroup>>(() => {
    const search = normalized(query);
    const matches = destinations.filter((destination) => {
      if (search.length === 0) return true;
      const searchable = normalized(
        `${labelFor(destination)} ${contextFor(destination)} ${destination.target}`,
      );
      return search.split(/\s+/u).every((term) => searchable.includes(term));
    });

    const visible =
      filter === "all"
        ? matches
        : filter === "pinned"
          ? matches.filter((destination) => destination.pinned)
          : matches.filter((destination) => destination.category === filter);
    const order: ReadonlyArray<Exclude<DestinationFilter, "all">> =
      filter === "all" ? ["pinned", "agent", "session", "slack", "discord", "telegram"] : [filter];

    return order.flatMap((id): ReadonlyArray<DestinationGroup> => {
      const entries = visible
        .filter((destination) => {
          if (id === "pinned") return destination.pinned;
          if (filter === "all" && destination.pinned) return false;
          return destination.category === id;
        })
        .sort(compareDestinations);
      return entries.length === 0 ? [] : [{ id, label: groupLabels[id], entries }];
    });
  }, [destinations, filter, query]);

  const choose = (destination: AutomationDestinationOption): void => {
    onSelect(destination);
    setOpen(false);
    setQuery("");
    setFilter("all");
  };

  return (
    <>
      <Button
        aria-haspopup="dialog"
        className="automation-destination-picker-trigger"
        disabled={disabled}
        onClick={() => setOpen(true)}
        type="button"
        variant="outline"
      >
        <span>
          {selected === undefined ? (
            <span className="automation-destination-picker-placeholder">Select a destination</span>
          ) : (
            <>
              <strong>{labelFor(selected)}</strong>
              <DestinationContext destination={selected} />
            </>
          )}
        </span>
        <ChevronDown aria-hidden="true" />
      </Button>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setQuery("");
            setFilter("all");
          }
        }}
      >
        <DialogContent className="automation-destination-picker-dialog sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>Choose a destination</DialogTitle>
            <DialogDescription>
              Send results to a conversation or a connected channel.
            </DialogDescription>
          </DialogHeader>

          <label className="automation-destination-picker-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Search destinations</span>
            <input
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search conversations, agents, or channels"
              type="search"
              value={query}
            />
          </label>

          <div
            aria-label="Destination types"
            className="automation-destination-filters"
            role="group"
          >
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

          <ScrollArea className="automation-destination-picker-scroll">
            {groups.length === 0 ? (
              <div className="automation-destination-picker-empty">
                <Search aria-hidden="true" />
                <strong>No matching destinations</strong>
                <span>Try another name, agent, channel, or filter.</span>
              </div>
            ) : (
              <div className="automation-destination-groups">
                {groups.map((group) => (
                  <section aria-labelledby={`destination-group-${group.id}`} key={group.id}>
                    <div className="automation-destination-group-heading">
                      <span>
                        {iconFor(group.id)}
                        <h3 id={`destination-group-${group.id}`}>{group.label}</h3>
                      </span>
                      <small>{group.entries.length}</small>
                    </div>
                    <div className="automation-destination-options">
                      {group.entries.map((destination) => {
                        const isSelected = selected?.target === destination.target;
                        return (
                          <button
                            aria-pressed={isSelected}
                            className="automation-destination-option"
                            key={destination.target}
                            onClick={() => choose(destination)}
                            type="button"
                          >
                            <span>
                              <strong>{labelFor(destination)}</strong>
                              <DestinationContext destination={destination} />
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
