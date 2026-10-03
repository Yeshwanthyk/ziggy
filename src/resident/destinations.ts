import { Effect } from "effect";
import type { AutomationTarget } from "../domain/automation";

export interface AutomationDestination {
  readonly target: AutomationTarget;
  readonly label?: string;
}

/** Channel addresses the resident has seen this run, offered as automation destinations. */
export interface DestinationBook {
  readonly list: Effect.Effect<ReadonlyArray<AutomationDestination>>;
  /** A later sighting without a label keeps the label already known. */
  readonly remember: (destination: AutomationDestination) => Effect.Effect<void>;
}

export const makeDestinationBook = (): DestinationBook => {
  const destinations = new Map<string, AutomationDestination>();

  return {
    list: Effect.sync(() =>
      [...destinations.values()].sort((left, right) =>
        left.target.target.localeCompare(right.target.target),
      ),
    ),
    remember: (destination) =>
      Effect.sync(() => {
        const current = destinations.get(destination.target.target);

        if (destination.label === undefined && current?.label !== undefined) return;

        destinations.set(destination.target.target, destination);
      }),
  };
};
