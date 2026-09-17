import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { BUILTIN_EXTENSION_CATALOG, isRequiredBundledExtension } from "../catalog";
import {
  ExtensionArchiveClient,
  type ExtensionArchiveClientApi,
} from "../adapters/github/extension-catalog";
import { makeExtensionInstaller } from "../adapters/fs/extension-installer";
import { makeExtensionUpdateStore } from "../adapters/fs/extension-update";
import { readExtensionPackage } from "../adapters/fs/profile-extensions";
import { inspectGatewayOwner } from "../adapters/bun/gateway-owner";
import { makeProfileExtensionPreflight } from "../adapters/pi/profile-extension-preflight";
import { withProfileUpdateLock } from "../adapters/bun/profile-runtime-lock";
import { ProfileExtensions } from "./profile-extensions";
import {
  ProfileExtensionId,
  ProfileExtensionMutationLock,
  type ProfileExtensionMutationLockApi,
  type ProfileExtensionsApi,
} from "../domain/profile-extension";
import { ExtensionUpdateError, type ExtensionUpdateResult } from "../domain/extension-update";
import type { ExtensionCatalog } from "../domain/extension-catalog";
import type { ProfileTarget } from "../domain/profile";

const decodeId = Schema.decodeUnknownEffect(ProfileExtensionId);

export const makeExtensionUpdate = (
  archiveClient: ExtensionArchiveClientApi,
  profiles: Pick<ProfileExtensionsApi, "validate">,
  lock: ProfileExtensionMutationLockApi,
  options: {
    readonly catalog?: ExtensionCatalog;
    readonly stage?: ReturnType<typeof makeExtensionInstaller>["installBundled"];
    readonly fence?: typeof withProfileUpdateLock;
    readonly inspectOwner?: typeof inspectGatewayOwner;
    readonly preflight?: ReturnType<typeof makeProfileExtensionPreflight>;
  } = {},
) => {
  const catalog = options.catalog ?? BUILTIN_EXTENSION_CATALOG;
  const stage = options.stage ?? makeExtensionInstaller(archiveClient).installBundled;
  const fence = options.fence ?? withProfileUpdateLock;
  const inspectOwner = options.inspectOwner ?? inspectGatewayOwner;
  const preflight = options.preflight ?? makeProfileExtensionPreflight();

  const update = (
    target: ProfileTarget,
    id: string,
    request: { readonly adopt?: boolean } = {},
  ) => {
    const error = (reason: ExtensionUpdateError["reason"], message: string, cause?: unknown) =>
      new ExtensionUpdateError({ profilePath: target.path, id, reason, message, cause });

    return Effect.gen(function* () {
      yield* decodeId(id).pipe(
        Effect.mapError((cause) => error("unsupported", "Invalid extension ID.", cause)),
      );
      const entry = catalog.extensions.find((item) => item.id === id);

      if (entry?.source !== "bundled") {
        return yield* error(
          "unsupported",
          "Only bundled extension copies can be updated by this command.",
        );
      }

      return yield* fence(
        target.path,
        lock.withLock(
          target.path,
          Effect.gen(function* () {
            const owner = yield* inspectOwner(target).pipe(
              Effect.mapError((cause) =>
                error("filesystem", "Could not establish whether the Profile is stopped.", cause),
              ),
            );

            if (owner._tag === "running")
              return yield* error(
                "unsupported",
                "Stop the Profile resident before updating extensions.",
              );
            const store = makeExtensionUpdateStore(target.path, id);
            const prepared = yield* store.prepare();

            return yield* Effect.gen(function* () {
              const currentPath = join(target.path, "extensions", id);
              const oldHash = yield* store.hash(currentPath);

              if (prepared.receipt === undefined && request.adopt !== true) {
                return yield* error(
                  "unmanaged",
                  "Extension origin is untracked. Use --adopt to explicitly take over these exact files; their previous origin cannot be verified.",
                );
              }

              if (prepared.receipt !== undefined && prepared.receipt.contentHash !== oldHash) {
                return yield* error(
                  "modified",
                  "Installed extension has local changes. Preserve or resolve them before updating; --adopt does not overwrite managed edits.",
                );
              }

              yield* stage(prepared.stagingProfile, entry);
              yield* store.stageContext(prepared.stagingProfile);
              yield* preflight.preflight(
                prepared.stagingProfile,
                prepared.stagingProfile,
                isRequiredBundledExtension(id) ? [] : [id],
              );
              const stagedPath = join(prepared.stagingProfile, "extensions", id);
              const contentHash = yield* store.hash(stagedPath);
              const current = yield* readExtensionPackage(target.path, id);
              const next = yield* readExtensionPackage(prepared.stagingProfile, id);

              const oldAutomations = yield* Effect.forEach(current.automations, (item) =>
                store.hash(item.path).pipe(Effect.map((hash) => `${item.id}:${hash}`)),
              );

              const newAutomations = yield* Effect.forEach(next.automations, (item) =>
                store.hash(item.path).pipe(Effect.map((hash) => `${item.id}:${hash}`)),
              );

              if (
                JSON.stringify(oldAutomations.toSorted()) !==
                JSON.stringify(newAutomations.toSorted())
              ) {
                return yield* error(
                  "automation",
                  "This update changes extension-owned automation definitions; that migration is not supported yet.",
                );
              }

              const adoptedUnknownOrigin = prepared.receipt === undefined;

              if (oldHash === contentHash) {
                yield* store.adoptCurrent(contentHash, entry.version);

                return {
                  id,
                  profilePath: target.path,
                  status: adoptedUnknownOrigin ? "adopted" : "current",
                  previousHash: oldHash,
                  contentHash,
                  adoptedUnknownOrigin,
                } satisfies ExtensionUpdateResult;
              }

              yield* store.commit({
                transactionId: prepared.transactionId,
                oldHash,
                newHash: contentHash,
                packageVersion: entry.version,
                validate: profiles.validate(target, target.path),
              });

              return {
                id,
                profilePath: target.path,
                status: "updated",
                previousHash: oldHash,
                contentHash,
                adoptedUnknownOrigin,
                backupPath: prepared.backupPath,
              } satisfies ExtensionUpdateResult;
            }).pipe(
              Effect.ensuring(
                store
                  .discard(prepared.transactionId)
                  .pipe(Effect.catch((cause) => Effect.logError(cause))),
              ),
            );
          }),
        ),
      );
    });
  };

  return { update };
};

export class ExtensionUpdate extends Context.Service<
  ExtensionUpdate,
  ReturnType<typeof makeExtensionUpdate>
>()("ziggy/ExtensionUpdate") {}

export const ExtensionUpdateLive = Layer.effect(
  ExtensionUpdate,
  Effect.gen(function* () {
    return makeExtensionUpdate(
      yield* ExtensionArchiveClient,
      yield* ProfileExtensions,
      yield* ProfileExtensionMutationLock,
    );
  }),
);
