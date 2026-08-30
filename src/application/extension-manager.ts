import { Effect } from "effect";
import type { ProfileExtensionsApi, ProfileExtensionListing } from "../domain/profile-extension";
import type { ProfileTarget } from "../domain/profile";
import type { TerminalInteractionFailed } from "../domain/terminal-interaction";
import type { ProfileListing, ProfilesApi } from "./profiles";

export interface ExtensionManagerChanges {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export interface ExtensionManagerInteraction {
  readonly selectProfile: (
    profiles: ReadonlyArray<ProfileListing>,
  ) => Effect.Effect<ProfileListing | undefined, TerminalInteractionFailed>;
  readonly selectExtensions: (
    profile: ProfileTarget,
    listing: ProfileExtensionListing,
  ) => Effect.Effect<ReadonlyArray<string> | undefined, TerminalInteractionFailed>;
  readonly confirmChanges: (
    profile: ProfileTarget,
    changes: ExtensionManagerChanges,
  ) => Effect.Effect<boolean | undefined, TerminalInteractionFailed>;
}

export type ExtensionManagerResult =
  | { readonly status: "empty" }
  | { readonly status: "cancelled" }
  | {
      readonly status: "unchanged";
      readonly profile: ProfileTarget;
      readonly selected: ReadonlyArray<string>;
    }
  | {
      readonly status: "changed";
      readonly profile: ProfileTarget;
      readonly selected: ReadonlyArray<string>;
      readonly added: ReadonlyArray<string>;
      readonly removed: ReadonlyArray<string>;
    };

export interface ExtensionManagerOptions {
  readonly target?: ProfileTarget;
  readonly profilesDirectory: string;
  readonly registryPath: string;
  readonly repositoryRoot: string;
}

const asTarget = (profile: ProfileListing): ProfileTarget => ({
  name: profile.name,
  path: profile.path,
});

const changesBetween = (
  current: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): ExtensionManagerChanges => {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    added: next.filter((id) => !currentSet.has(id)),
    removed: current.filter((id) => !nextSet.has(id)),
  };
};

export const manageExtensions = (
  profiles: ProfilesApi,
  extensions: ProfileExtensionsApi,
  interaction: ExtensionManagerInteraction,
  options: ExtensionManagerOptions,
) =>
  Effect.gen(function* () {
    let profile = options.target;
    if (profile === undefined) {
      const availableProfiles = yield* profiles.listProfiles(
        options.profilesDirectory,
        options.registryPath,
      );
      if (availableProfiles.length === 0) return { status: "empty" } as const;
      const choice = yield* interaction.selectProfile(availableProfiles);
      profile = choice === undefined ? undefined : asTarget(choice);
    }
    if (profile === undefined) return { status: "cancelled" } as const;

    const listing = yield* extensions.listForProfile(profile.path, options.repositoryRoot);
    const requested = yield* interaction.selectExtensions(profile, listing);
    if (requested === undefined) return { status: "cancelled" } as const;

    const changes = changesBetween(listing.selected, requested);
    if (changes.added.length === 0 && changes.removed.length === 0) {
      return { status: "unchanged", profile, selected: listing.selected } as const;
    }

    const confirmed = yield* interaction.confirmChanges(profile, changes);
    if (confirmed !== true) return { status: "cancelled" } as const;

    const result = yield* extensions.setSelected(profile, options.repositoryRoot, requested);
    if (!result.changed) {
      return { status: "unchanged", profile, selected: result.selected } as const;
    }
    return {
      status: "changed",
      profile,
      selected: result.selected,
      ...changes,
    } as const;
  });
