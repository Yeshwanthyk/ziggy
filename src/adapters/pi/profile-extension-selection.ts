import { Effect } from "effect";
import {
  readExtensionSelection,
  scanOptionalExtensionShelf,
  setExtensionSelection,
  type ExtensionKind,
} from "../fs/profile-extensions";

export interface ProfileExtensionChoice {
  readonly id: string;
  readonly description: string;
  readonly kind: ExtensionKind | "remote";
  readonly source: "bundled" | "remote-approved" | "profile";
}

export interface ProfileExtensionListing {
  readonly available: ReadonlyArray<ProfileExtensionChoice>;
  readonly selected: ReadonlyArray<string>;
}

export interface ProfileExtensionSetResult {
  readonly changed: boolean;
  readonly selected: ReadonlyArray<string>;
}

export interface ProfileExtensionSelectionRunner {
  readonly list: () => Promise<ProfileExtensionListing>;
  readonly setSelected: (ids: ReadonlyArray<string>) => Promise<ProfileExtensionSetResult>;
}

export interface ProfileExtensionCatalogOperations {
  readonly list: (repositoryRoot: string) => Effect.Effect<
    ReadonlyArray<{
      readonly id: string;
      readonly description: string;
      readonly kind: ExtensionKind | "remote";
      readonly required: boolean;
      readonly source: "bundled" | "remote-approved";
    }>,
    unknown
  >;
  readonly ensureInstalled: (
    profilePath: string,
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<string, unknown>;
  readonly deactivate: (
    profilePath: string,
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<void, unknown>;
}

export const createProfileExtensionSelectionRunner = (
  profilePath: string,
  repositoryRoot: string,
  catalog: ProfileExtensionCatalogOperations,
): ProfileExtensionSelectionRunner => ({
  list: () => {
    const program = Effect.all({
      catalogue: catalog.list(repositoryRoot),
      profileOwned: scanOptionalExtensionShelf(profilePath),
      selected: readExtensionSelection(profilePath),
    }).pipe(
      Effect.map(({ catalogue, profileOwned, selected }) => {
        const availableById = new Map<string, ProfileExtensionChoice>(
          catalogue.flatMap((extension) =>
            extension.required
              ? []
              : [
                  [
                    extension.id,
                    {
                      id: extension.id,
                      description: extension.description,
                      kind: extension.kind,
                      source: extension.source,
                    },
                  ] as const,
                ],
          ),
        );
        for (const extension of profileOwned) {
          if (!extension.required) {
            availableById.set(extension.id, { ...extension, source: "profile" as const });
          }
        }
        return {
          available: [...availableById.values()]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((extension) => ({
              id: extension.id,
              description: extension.description,
              kind: extension.kind,
              source: extension.source,
            })),
          selected,
        };
      }),
    );
    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning command callback; this is the TUI adapter bridge.
    return Effect.runPromise(program);
  },
  setSelected: (ids) => {
    const program = Effect.gen(function* () {
      const current = yield* readExtensionSelection(profilePath);
      const next = [...ids].sort();
      const added = next.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !next.includes(id));
      yield* Effect.forEach(
        added,
        (id) => catalog.ensureInstalled(profilePath, repositoryRoot, id),
        { discard: true },
      );
      yield* Effect.forEach(removed, (id) => catalog.deactivate(profilePath, repositoryRoot, id), {
        discard: true,
      });
      return yield* setExtensionSelection(profilePath, repositoryRoot, next);
    });
    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning command callback; this is the TUI adapter bridge.
    return Effect.runPromise(program);
  },
});
