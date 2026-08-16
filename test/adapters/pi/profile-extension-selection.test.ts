import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type {
  ProfileExtensionListing,
  ProfileExtensionSetResult,
  ProfileExtensionsApi,
} from "ziggy/domain/profile-extension";
import { ProfileExtensionInvalid } from "ziggy/domain/profile";
import { createProfileExtensionSelectionRunner } from "ziggy/adapters/pi/profile-extension-selection";

const unused = (): Effect.Effect<never, ProfileExtensionInvalid> =>
  Effect.fail(
    new ProfileExtensionInvalid({
      path: "/unused",
      message: "unused test operation",
      cause: undefined,
    }),
  );

test("the TUI selection runner delegates one full-set operation to ProfileExtensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-extension-runner-"));
  const repositoryRoot = join(root, "repository");
  const profilePath = join(root, "profile");
  try {
    await mkdir(profilePath, { recursive: true });
    const listing: ProfileExtensionListing = {
      available: [
        { id: "alpha", description: "Profile-owned Alpha", kind: "skill", source: "profile" },
        { id: "gamma", description: "Profile-owned extension", kind: "skill", source: "profile" },
        {
          id: "remote",
          description: "Remote approved extension",
          kind: "remote",
          source: "remote-approved",
        },
        { id: "weather", description: "Weather extension", kind: "skill", source: "bundled" },
      ],
      selected: ["alpha"],
    };
    const selectedCalls: Array<{
      readonly profilePath: string;
      readonly repositoryRoot: string;
      readonly ids: ReadonlyArray<string>;
    }> = [];
    let listCalls = 0;
    const profileExtensions: ProfileExtensionsApi = {
      list: unused,
      show: unused,
      listForProfile: (_profilePath, _repositoryRoot) => {
        listCalls += 1;
        return Effect.succeed(listing);
      },
      add: unused,
      remove: unused,
      setSelected: (target, repository, ids): Effect.Effect<ProfileExtensionSetResult, never> => {
        selectedCalls.push({ profilePath: target.path, repositoryRoot: repository, ids: [...ids] });
        return Effect.succeed({ changed: true, selected: [...ids].sort() });
      },
      validate: unused,
      prepareRuntime: unused,
      activateRuntime: unused,
    };

    const runner = createProfileExtensionSelectionRunner(
      profilePath,
      repositoryRoot,
      profileExtensions,
    );

    expect(await runner.list()).toEqual(listing);
    expect(await runner.setSelected(["weather", "gamma", "remote"])).toEqual({
      changed: true,
      selected: ["gamma", "remote", "weather"],
    });
    expect(listCalls).toBe(1);
    expect(selectedCalls).toEqual([
      {
        profilePath,
        repositoryRoot,
        ids: ["weather", "gamma", "remote"],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
