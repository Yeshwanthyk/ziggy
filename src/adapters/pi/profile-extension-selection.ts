import { basename } from "node:path";
import { Effect } from "effect";
import type {
  ProfileExtensionListing,
  ProfileExtensionSetResult,
  ProfileExtensionsApi,
} from "../../domain/profile-extension";

export type {
  ProfileExtensionChoice,
  ProfileExtensionListing,
  ProfileExtensionSetResult,
} from "../../domain/profile-extension";

export interface ProfileExtensionSelectionRunner {
  readonly list: () => Promise<ProfileExtensionListing>;
  readonly setSelected: (ids: ReadonlyArray<string>) => Promise<ProfileExtensionSetResult>;
}

export const createProfileExtensionSelectionRunner = (
  profilePath: string,
  repositoryRoot: string,
  profileExtensions: ProfileExtensionsApi,
): ProfileExtensionSelectionRunner => ({
  list: () => {
    const program = profileExtensions.listForProfile(profilePath, repositoryRoot);
    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning command callback; this is the TUI adapter bridge.
    return Effect.runPromise(program);
  },
  setSelected: (ids) => {
    const program = profileExtensions.setSelected(
      { path: profilePath, name: basename(profilePath) },
      repositoryRoot,
      ids,
    );
    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning command callback; this is the TUI adapter bridge.
    return Effect.runPromise(program);
  },
});
