/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun async tests own their disposable Effect execution */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  manageExtensions,
  type ExtensionManagerInteraction,
} from "ziggy/application/extension-manager";
import type { ProfilesApi } from "ziggy/application/profiles";
import type { ProfileExtensionsApi } from "ziggy/domain/profile-extension";

const unused = () => Effect.never;

const profiles = (available: ReadonlyArray<{ readonly name: string; readonly path: string }>) =>
  ({
    initProfile: unused,
    registerProfile: unused,
    listProfiles: () => Effect.succeed(available),
  }) satisfies ProfilesApi;

const extensionService = (selected: ReadonlyArray<string>, calls: Array<ReadonlyArray<string>>) =>
  ({
    list: unused,
    show: unused,
    listForProfile: () =>
      Effect.succeed({
        available: [
          { id: "alpha", description: "Alpha", kind: "skill", source: "bundled" },
          { id: "beta", description: "Beta", kind: "code", source: "bundled" },
        ],
        selected,
      }),
    add: unused,
    remove: unused,
    setSelected: (_target, _repositoryRoot, ids) => {
      calls.push(ids);
      return Effect.succeed({ changed: true, selected: [...ids].sort() });
    },
    validate: unused,
    prepareRuntime: unused,
    activateRuntime: unused,
  }) satisfies ProfileExtensionsApi;

const options = {
  profilesDirectory: "/profiles",
  registryPath: "/profiles.txt",
  repositoryRoot: "/repository",
};

test("reviews one complete extension selection before one transactional mutation", async () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const events: Array<string> = [];
  const interaction: ExtensionManagerInteraction = {
    selectProfile: ([profile]) => Effect.succeed(profile),
    selectExtensions: (_profile, listing) => {
      events.push(`selected:${listing.selected.join(",")}`);
      return Effect.succeed(["beta"]);
    },
    confirmChanges: (_profile, changes) => {
      events.push(`review:+${changes.added.join(",")};-${changes.removed.join(",")}`);
      return Effect.succeed(true);
    },
  };

  const result = await Effect.runPromise(
    manageExtensions(
      profiles([{ name: "buddy", path: "/profiles/buddy" }]),
      extensionService(["alpha"], calls),
      interaction,
      options,
    ),
  );

  expect(events).toEqual(["selected:alpha", "review:+beta;-alpha"]);
  expect(calls).toEqual([["beta"]]);
  expect(result).toEqual({
    status: "changed",
    profile: { name: "buddy", path: "/profiles/buddy" },
    selected: ["beta"],
    added: ["beta"],
    removed: ["alpha"],
  });
});

test("cancellation and an empty Profile shelf never mutate extension state", async () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const interaction: ExtensionManagerInteraction = {
    selectProfile: ([profile]) => Effect.succeed(profile),
    selectExtensions: () => Effect.succeed(undefined),
    confirmChanges: () => Effect.never,
  };

  const cancelled = await Effect.runPromise(
    manageExtensions(
      profiles([{ name: "buddy", path: "/profiles/buddy" }]),
      extensionService([], calls),
      interaction,
      options,
    ),
  );
  const empty = await Effect.runPromise(
    manageExtensions(profiles([]), extensionService([], calls), interaction, options),
  );

  expect(cancelled).toEqual({ status: "cancelled" });
  expect(empty).toEqual({ status: "empty" });
  expect(calls).toEqual([]);
});
