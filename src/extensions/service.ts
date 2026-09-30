import { lstat, readFile } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer, Predicate, Schema } from "effect";
import {
  automationFileStore,
  installAutomationDefinition,
  pauseAutomationDefinition,
  removeAutomationDefinition,
  resumeAutomationDefinition,
} from "../adapters/fs/automation-files";
import {
  BUILTIN_PACKAGE_METADATA,
  bundledPackageMetadata,
  isRequiredBundledExtension,
} from "../catalog";
import { parseAutomationFile, validateAutomationId, type AutomationId } from "../domain/automation";
import type { ProfileExtensionInvalid } from "../domain/profile";
import type { ProfileFileSystemError, ProfileTarget } from "../profile";
import { requiredPackages, unpackBundled } from "./bundled";
import { checkSelection } from "./loader";
import { fsError, invalid, packageExists, readExtensionPackage, scanShelf } from "./package";
import { recoverInterruptedUpdate } from "./resources";
import {
  readSelection,
  restoreSelection,
  snapshotSelection,
  withSelectionLock,
  writeSelection,
} from "./selection";
import {
  ExtensionId,
  type ExtensionChoice,
  type ExtensionError,
  type ExtensionHealth,
  type ExtensionListing,
  type ExtensionMutation,
  type ExtensionPackage,
  type ExtensionSelection,
  type ExtensionSetResult,
  type ExtensionValidation,
} from "./types";
import { recordBundledCopy, updateBundled } from "./update";

type Invalid = ProfileExtensionInvalid | ProfileFileSystemError;

const decodeIds = Schema.decodeUnknownEffect(Schema.Array(ExtensionId));

const selectionFile = (profilePath: string) => path.join(profilePath, "extensions.json");

const notInitialized = (profilePath: string) =>
  invalid(
    profilePath,
    `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
  );

const verifyInitialized = (profilePath: string): Effect.Effect<void, Invalid> => {
  const soul = path.join(profilePath, "SOUL.md");

  return Effect.tryPromise({
    try: () => lstat(soul),
    catch: (cause) => fsError("inspect", soul, cause),
  }).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.fail(notInitialized(profilePath)),
    ),
    Effect.flatMap((status) =>
      status.isFile() && !status.isSymbolicLink()
        ? Effect.void
        : Effect.fail(notInitialized(profilePath)),
    ),
  );
};

/** A requested selection: valid ids, no duplicates, no required packages; sorted. */
const decodeRequested = (
  profilePath: string,
  ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, ProfileExtensionInvalid> =>
  decodeIds(ids).pipe(
    Effect.mapError((cause) =>
      invalid(selectionFile(profilePath), "invalid extension selection", cause),
    ),
    Effect.flatMap((decoded) => {
      const reserved = decoded.find(isRequiredBundledExtension);

      if (new Set(decoded).size !== decoded.length) {
        return Effect.fail(
          invalid(selectionFile(profilePath), "extension selection contains duplicate IDs"),
        );
      }

      return reserved === undefined
        ? Effect.succeed([...decoded].sort())
        : Effect.fail(
            invalid(
              selectionFile(profilePath),
              `required extension '${reserved}' cannot be added or removed`,
            ),
          );
    }),
  );

const bundledListings: ReadonlyArray<ExtensionListing> = BUILTIN_PACKAGE_METADATA.map(
  (metadata): ExtensionListing => ({
    id: metadata.id,
    version: metadata.version,
    description: metadata.description,
    kind: metadata.kind,
    required: metadata.required,
    source: "bundled",
    packagePath: metadata.sourcePath,
    skills: metadata.skills.map(({ name, description }) => ({ name, description })),
    extensionPaths: [...metadata.executables],
  }),
).sort((left, right) => left.id.localeCompare(right.id));

const profileListing = (item: ExtensionPackage): ExtensionListing => ({
  id: item.id,
  version: "profile-local",
  description: item.description,
  kind: item.kind,
  required: item.required,
  source: "profile",
  packagePath: item.packagePath,
  skills: item.skills,
  extensionPaths: item.extensionPaths,
});

/** The package on the Profile shelf; a bundled one missing there is unpacked first. */
const shelfPackage = (profilePath: string, id: string): Effect.Effect<ExtensionPackage, Invalid> =>
  Effect.gen(function* () {
    yield* recoverInterruptedUpdate(profilePath, id);

    if (yield* packageExists(profilePath, id)) return yield* readExtensionPackage(profilePath, id);

    if (bundledPackageMetadata(id) === undefined) {
      return yield* invalid(
        path.join(profilePath, "extensions", id),
        `unknown extension '${id}'; it is neither approved nor Profile-local`,
      );
    }

    const unpacked = yield* unpackBundled(profilePath, id);
    yield* recordBundledCopy(profilePath, id).pipe(
      Effect.catch((failure) =>
        Effect.logWarning("unpacked a bundled extension without an update receipt", { failure }),
      ),
    );

    return unpacked;
  });

const presentPackage = (profilePath: string, id: string) =>
  Effect.flatMap(packageExists(profilePath, id), (exists) =>
    exists ? readExtensionPackage(profilePath, id) : Effect.succeed(undefined),
  );

// A package's declared automations are Profile files it owns: selecting the package
// installs or resumes them, deselecting pauses them. A same-id automation that anyone else
// owns, or that was edited by hand, blocks the change before anything is written.

const target = (profilePath: string): ProfileTarget => ({
  name: path.basename(profilePath),
  path: profilePath,
});

interface OwnedAutomation {
  readonly id: AutomationId;
  readonly source: string;
  readonly lifecycle: "active" | "paused" | undefined;
}

const isInvalid = (cause: unknown): cause is ProfileExtensionInvalid =>
  Predicate.isTagged(cause, "ProfileExtensionInvalid");

const isFileSystemError = (cause: unknown): cause is ProfileFileSystemError =>
  Predicate.isTagged(cause, "ProfileFileSystemError");

const ownedAutomations = (
  profilePath: string,
  item: ExtensionPackage,
): Effect.Effect<ReadonlyArray<OwnedAutomation>, ProfileExtensionInvalid> =>
  Effect.forEach(item.automations, (declared) => {
    const failure = (message: string, cause?: unknown) => invalid(declared.path, message, cause);
    const owner = `extension:${item.id}`;

    return Effect.gen(function* () {
      const id = yield* validateAutomationId(declared.id);

      const source = yield* Effect.tryPromise({
        try: () => readFile(declared.path, "utf8"),
        catch: (cause) => fsError("read", declared.path, cause),
      });

      const expected = yield* parseAutomationFile(id, declared.path, source);

      if (expected.owner !== owner) {
        return yield* failure(`automation ${id} must declare owner: ${owner}`);
      }

      const existing = yield* automationFileStore
        .readDefinition(target(profilePath), id, true)
        .pipe(Effect.catchTag("AutomationNotFound", () => Effect.succeed(undefined)));

      if (existing !== undefined && existing.source !== source) {
        return yield* failure(
          `automation ${id} already exists and is not the exact ${owner} definition`,
        );
      }

      return { id, source, lifecycle: existing?.lifecycle };
    }).pipe(
      Effect.mapError((cause) =>
        isInvalid(cause)
          ? cause
          : failure(
              `could not validate extension automation '${declared.id}' without changing Profile state`,
              cause,
            ),
      ),
    );
  });

/** Two selected packages may not declare the same automation id. */
const checkOwnership = (packages: ReadonlyArray<ExtensionPackage>) => {
  const owners = new Map<string, string>();

  for (const item of packages) {
    for (const declared of item.automations) {
      const previous = owners.get(declared.id);

      if (previous !== undefined && previous !== item.id) {
        return Effect.fail(
          invalid(
            declared.path,
            `automation ${declared.id} is declared by both ${previous} and ${item.id}`,
          ),
        );
      }

      owners.set(declared.id, item.id);
    }
  }

  return Effect.void;
};

/** One step that changed Profile files, and how to take it back. */
type Undo = Effect.Effect<void, unknown>;

const remember = (undo: Undo[], step: Effect.Effect<unknown, unknown>) =>
  Effect.sync(() => {
    undo.push(Effect.asVoid(step));
  });

const activate = (profilePath: string, owned: ReadonlyArray<OwnedAutomation>, undo: Undo[]) =>
  Effect.forEach(
    owned,
    (automation) => {
      if (automation.lifecycle === undefined) {
        return installAutomationDefinition(
          target(profilePath),
          automation.id,
          automation.source,
        ).pipe(
          Effect.tap(() =>
            remember(
              undo,
              removeAutomationDefinition(target(profilePath), automation.id, automation.source),
            ),
          ),
        );
      }

      if (automation.lifecycle === "paused") {
        return resumeAutomationDefinition(target(profilePath), automation.id).pipe(
          Effect.tap(() =>
            remember(undo, pauseAutomationDefinition(target(profilePath), automation.id)),
          ),
        );
      }

      return Effect.void;
    },
    { discard: true },
  );

const deactivate = (profilePath: string, owned: ReadonlyArray<OwnedAutomation>, undo: Undo[]) =>
  Effect.forEach(
    owned.filter((automation) => automation.lifecycle === "active"),
    (automation) =>
      pauseAutomationDefinition(target(profilePath), automation.id).pipe(
        Effect.tap(() =>
          remember(undo, resumeAutomationDefinition(target(profilePath), automation.id)),
        ),
      ),
    { discard: true },
  );

/**
 * Move the Profile from its current selection to `next`. Everything is checked first: the
 * packages, their automations, and a Pi load that refuses any added package it cannot load.
 * Then the selection is written and automations follow it; if a step fails, the steps
 * already taken are undone in reverse. Returns the automations that followed the change.
 */
const apply = (profilePath: string, next: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const snapshot = yield* snapshotSelection(profilePath);
    const current = new Set(snapshot.selected);
    const wanted = new Set(next);
    const nextPackages = yield* Effect.forEach(next, (id) => shelfPackage(profilePath, id));
    yield* checkOwnership([...nextPackages, ...(yield* requiredPackages)]);

    const added = nextPackages.filter((item) => !current.has(item.id));

    const removed = (yield* Effect.forEach(
      snapshot.selected.filter((id) => !wanted.has(id)),
      (id) => presentPackage(profilePath, id),
    )).filter((item) => item !== undefined);

    const adding = yield* Effect.forEach(added, (item) => ownedAutomations(profilePath, item));
    const removing = yield* Effect.forEach(removed, (item) => ownedAutomations(profilePath, item));
    yield* checkSelection(
      profilePath,
      next,
      added.map((item) => item.id),
    );

    const undo: Undo[] = [restoreSelection(profilePath, snapshot)];

    const change = Effect.gen(function* () {
      yield* Effect.forEach(removing, (owned) => deactivate(profilePath, owned, undo), {
        discard: true,
      });
      yield* writeSelection(profilePath, next);
      yield* Effect.forEach(adding, (owned) => activate(profilePath, owned, undo), {
        discard: true,
      });
    });

    yield* change.pipe(
      Effect.mapError((cause) =>
        isInvalid(cause) || isFileSystemError(cause)
          ? cause
          : invalid(selectionFile(profilePath), "could not update extension automations", cause),
      ),
      Effect.tapError(() =>
        Effect.forEach(
          [...undo].reverse(),
          (step) =>
            step.pipe(
              Effect.catch((cause) =>
                Effect.logWarning("could not undo a Profile extension change", {
                  profilePath,
                  cause,
                }),
              ),
            ),
          { discard: true },
        ),
      ),
      // An aborted tool call never stops between a change and its undo.
      Effect.uninterruptible,
    );

    return [...adding, ...removing].flat().map((automation) => automation.id);
  });

const choice = (item: {
  readonly id: string;
  readonly description: string;
  readonly kind: ExtensionChoice["kind"];
}): ExtensionChoice => ({
  id: item.id,
  description: item.description,
  kind: item.kind,
  source: "bundled",
});

const listForProfile = (profilePath: string): Effect.Effect<ExtensionSelection, ExtensionError> =>
  Effect.gen(function* () {
    yield* verifyInitialized(profilePath);

    // Writers replace `extensions.json` and shelf folders by rename, so reads need no lock.
    const shelf = yield* scanShelf(profilePath);
    const selected = yield* readSelection(profilePath);

    const available = new Map<string, ExtensionChoice>();

    for (const item of bundledListings) {
      if (!item.required) available.set(item.id, choice(item));
    }

    for (const item of shelf) {
      if (!item.required) available.set(item.id, { ...choice(item), source: "profile" });
    }

    return {
      available: [...available.values()].sort((left, right) => left.id.localeCompare(right.id)),
      selected,
      required: bundledListings.filter((item) => item.required).map((item) => item.id),
    };
  });

const mutation = (profilePath: string, id: string, selected: boolean) =>
  Effect.gen(function* () {
    yield* verifyInitialized(profilePath);

    return yield* withSelectionLock(
      profilePath,
      Effect.gen(function* () {
        const [requested] = yield* decodeRequested(profilePath, [id]);
        const current = yield* readSelection(profilePath);

        if (requested === undefined || current.includes(requested) === selected) {
          return {
            id,
            profilePath,
            changed: false,
            selected,
            automations: [],
          } satisfies ExtensionMutation;
        }

        const automations = yield* apply(
          profilePath,
          selected ? [...current, requested].sort() : current.filter((item) => item !== requested),
        );

        return {
          id: requested,
          profilePath,
          changed: true,
          selected,
          automations,
        } satisfies ExtensionMutation;
      }),
    );
  });

const setSelected = (
  profile: ProfileTarget,
  ids: ReadonlyArray<string>,
): Effect.Effect<ExtensionSetResult, ExtensionError> =>
  Effect.gen(function* () {
    yield* verifyInitialized(profile.path);

    return yield* withSelectionLock(
      profile.path,
      Effect.gen(function* () {
        const current = yield* readSelection(profile.path);
        const next = yield* decodeRequested(profile.path, ids);

        if (current.length === next.length && current.every((id, index) => id === next[index])) {
          return { changed: false, selected: current };
        }

        yield* apply(profile.path, next);

        return { changed: true, selected: next };
      }),
    );
  });

/** Load the Profile's selection through Pi without changing anything. */
const validate = (profile: ProfileTarget): Effect.Effect<ExtensionValidation, ExtensionError> =>
  Effect.gen(function* () {
    yield* verifyInitialized(profile.path);

    const before = yield* snapshotSelection(profile.path);
    const check = yield* checkSelection(profile.path, before.selected, before.selected);
    const after = yield* snapshotSelection(profile.path);

    if (before.exists !== after.exists || before.text !== after.text) {
      return yield* invalid(
        selectionFile(profile.path),
        "read-only Profile extension validation changed extensions.json",
      );
    }

    return {
      selected: before.selected,
      preflight: {
        extensionPathCount: check.extensionPathCount,
        skillPathCount: check.skillPathCount,
        extensionFactoryCount: check.extensionFactoryCount,
      },
    };
  });

/** The Profile's selection plus the selected packages Pi would skip when a session opens. */
const health = (profilePath: string): Effect.Effect<ExtensionHealth, ExtensionError> =>
  Effect.gen(function* () {
    const listing = yield* listForProfile(profilePath);
    const check = yield* checkSelection(profilePath, listing.selected);

    return { listing, skipped: check.skipped };
  });

const show = (
  id: string,
  profilePath?: string,
): Effect.Effect<ExtensionListing, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    if (profilePath !== undefined) {
      yield* verifyInitialized(profilePath);

      const local = (yield* scanShelf(profilePath)).find((item) => item.id === id);

      if (local !== undefined) return profileListing(local);
    }

    const found = bundledListings.find((item) => item.id === id);

    if (found === undefined) return yield* invalid(id, `unknown extension '${id}'`);

    return found;
  });

const make = {
  list: (): Effect.Effect<ReadonlyArray<ExtensionListing>> => Effect.succeed(bundledListings),
  show,
  listForProfile,
  add: (profile: ProfileTarget, id: string) => mutation(profile.path, id, true),
  remove: (profile: ProfileTarget, id: string) => mutation(profile.path, id, false),
  setSelected,
  validate,
  health,
  update: (profile: ProfileTarget, id: string, options: { readonly adopt: boolean }) =>
    Effect.flatMap(verifyInitialized(profile.path), () => updateBundled(profile, id, options)),
} as const;

/** What a Profile has selected, and the changes that keep its files and automations in step. */
export class Extensions extends Context.Service<Extensions>()("ziggy/Extensions", {
  make: Effect.succeed(make),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export type ExtensionsApi = typeof make;
