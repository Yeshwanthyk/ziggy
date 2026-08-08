import { Effect } from "effect";
import {
  readExtensionSelection,
  scanExtensionShelf,
  setExtensionSelection,
  type ExtensionKind,
} from "../fs/profile-extensions";

export interface ProfileExtensionChoice {
  readonly id: string;
  readonly description: string;
  readonly kind: ExtensionKind;
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

export const createProfileExtensionSelectionRunner = (
  profilePath: string,
  repositoryRoot: string,
): ProfileExtensionSelectionRunner => ({
  list: () => {
    const program = Effect.all({
      shelf: scanExtensionShelf(repositoryRoot),
      selected: readExtensionSelection(profilePath),
    }).pipe(
      Effect.map(({ shelf, selected }) => ({
        available: shelf.flatMap((extension) =>
          extension.required
            ? []
            : [
                {
                  id: extension.id,
                  description: extension.description,
                  kind: extension.kind,
                },
              ],
        ),
        selected,
      })),
    );
    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning command callback; this is the TUI adapter bridge.
    return Effect.runPromise(program);
  },
  setSelected: (ids) => {
    const program = setExtensionSelection(profilePath, repositoryRoot, ids);
    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning command callback; this is the TUI adapter bridge.
    return Effect.runPromise(program);
  },
});
