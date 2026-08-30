/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute filesystem Effects */
import { expect, test } from "bun:test";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Predicate, Result } from "effect";
import {
  makeUiGroupStore,
  makeUiPinStore,
  uiGroupStatePath,
  uiPinStatePath,
} from "ziggy/adapters/fs/ui-state";
import { stableProfileId } from "ziggy/application/profile-directory";
import type { ProfileId } from "ziggy/domain/profile-directory";
import { UI_GROUP_LIMIT, UI_PIN_LIMIT } from "ziggy/domain/ui-state";
import type {
  UiGroupRecord as UiGroupRecordValue,
  UiPin as UiPinValue,
} from "ziggy/domain/ui-gateway";

const profile = async (): Promise<{ readonly root: string; readonly path: string }> => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-ui-state-"));
  const path = join(root, "profile");
  await mkdir(path, { recursive: true });
  return { root, path };
};

const pinFor = (profileId: ProfileId): UiPinValue => ({
  id: "main",
  ref: { profileId, kind: "live", key: "local/main" },
  label: "Main",
  order: 0,
});

test("pins persist in Profile-local machine state with revision and command idempotency", async () => {
  const fixture = await profile();
  try {
    const profileId = stableProfileId(fixture.path);
    const pins = makeUiPinStore();
    const pin = pinFor(profileId);

    expect(await Effect.runPromise(pins.read(fixture.path))).toEqual({
      version: 1,
      revision: 0,
      pins: [],
      commands: [],
    });
    const first = await Effect.runPromise(pins.set(fixture.path, pin, 0, "pin-command"));
    expect(first.revision).toBe(1);
    expect(first.pins).toEqual([pin]);
    expect(await readFile(uiPinStatePath(fixture.path), "utf8")).toContain('"revision":1');
    expect(uiPinStatePath(fixture.path)).not.toContain(".runtime");

    const replay = await Effect.runPromise(pins.set(fixture.path, pin, 0, "pin-command"));
    expect(replay.revision).toBe(first.revision);
    expect(replay.pins).toEqual(first.pins);

    const changedPin: UiPinValue = { ...pin, label: "Changed" };
    const commandConflict = await Effect.runPromise(
      pins.set(fixture.path, changedPin, 0, "pin-command").pipe(Effect.result),
    );
    expect(
      Result.match(commandConflict, {
        onFailure: (error) => Predicate.isTagged(error, "UiStateCommandConflict"),
        onSuccess: () => false,
      }),
    ).toBe(true);

    const revisionConflict = await Effect.runPromise(
      pins.set(fixture.path, changedPin, 0, "new-command").pipe(Effect.result),
    );
    expect(
      Result.match(revisionConflict, {
        onFailure: (error) =>
          Predicate.isTagged(error, "UiStateConflict") &&
          error.expectedRevision === 0 &&
          error.actualRevision === 1,
        onSuccess: () => false,
      }),
    ).toBe(true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("groups persist the host Profile and reject stale revisions", async () => {
  const fixture = await profile();
  try {
    const profileId = stableProfileId(fixture.path);
    const groups = makeUiGroupStore();
    const group: UiGroupRecordValue = {
      groupId: "research",
      conversationId: "ui/group-research",
      hostProfileId: profileId,
      memberAgentIds: ["analyst"],
      defaultRecipient: { kind: "host" },
      revision: 0,
    };
    const first = await Effect.runPromise(groups.upsert(fixture.path, group, 0, "group-command"));
    expect(first.groups).toEqual([{ ...group, revision: 1 }]);
    expect(await readFile(uiGroupStatePath(fixture.path), "utf8")).toContain(
      '"groupId":"research"',
    );

    const replay = await Effect.runPromise(groups.upsert(fixture.path, group, 0, "group-command"));
    expect(replay).toEqual(first);

    const stale = await Effect.runPromise(
      groups
        .upsert(fixture.path, { ...group, memberAgentIds: ["writer"] }, 0, "new-group-command")
        .pipe(Effect.result),
    );
    expect(
      Result.match(stale, {
        onFailure: (error) =>
          Predicate.isTagged(error, "UiStateConflict") &&
          error.expectedRevision === 0 &&
          error.actualRevision === 1,
        onSuccess: () => false,
      }),
    ).toBe(true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pin and group writers retain schema-decodable item bounds", async () => {
  const fixture = await profile();
  try {
    const profileId = stableProfileId(fixture.path);
    const pins = makeUiPinStore();
    let pinRevision = 0;
    for (let index = 0; index <= UI_PIN_LIMIT; index += 1) {
      const id = `pin-${index.toString().padStart(3, "0")}`;
      const result = await Effect.runPromise(
        pins.set(
          fixture.path,
          { ...pinFor(profileId), id, label: id, order: index },
          pinRevision,
          `set-${id}`,
        ),
      );
      pinRevision = result.revision;
    }
    expect((await Effect.runPromise(pins.read(fixture.path))).pins).toHaveLength(UI_PIN_LIMIT);

    const groups = makeUiGroupStore();
    for (let index = 0; index <= UI_GROUP_LIMIT; index += 1) {
      const groupId = `group-${index.toString().padStart(3, "0")}`;
      await Effect.runPromise(
        groups.upsert(
          fixture.path,
          {
            groupId,
            conversationId: `ui/${groupId}`,
            hostProfileId: profileId,
            memberAgentIds: [],
            defaultRecipient: { kind: "host" },
            revision: 0,
          },
          0,
          `set-${groupId}`,
        ),
      );
    }
    expect((await Effect.runPromise(groups.read(fixture.path))).groups).toHaveLength(
      UI_GROUP_LIMIT,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
