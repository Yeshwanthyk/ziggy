import { join } from "node:path";
import { Context, Effect, Layer, Schema, type Result } from "effect";
import { BUILTIN_EXTENSION_CATALOG, isRequiredBundledExtension } from "../catalog";
import { installBundledPackage } from "../adapters/fs/extension-installer";
import {
  classifyBundledCopy,
  hasPendingExtensionUpdates,
  makeExtensionUpdateStore,
} from "../adapters/fs/extension-update";
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
import type { BundledExtensionCatalogEntry } from "../domain/extension-catalog";
import type { ProfileTarget } from "../domain/profile";
import { ResidentService, type ResidentServiceApi } from "./resident-service";
import type {
  ResidentServiceDefinitionState,
  ResidentServiceError,
} from "../domain/resident-service";

const decodeId = Schema.decodeUnknownEffect(ProfileExtensionId);

/** Refresh only tracked, unchanged required copies before the resident acquires ownership. */
export const refreshRequiredExtensions = (
  target: ProfileTarget,
  update: (target: ProfileTarget, id: string) => Effect.Effect<ExtensionUpdateResult, unknown>,
) =>
  Effect.forEach(
    [...BUILTIN_EXTENSION_CATALOG.extensions].filter(
      (entry): entry is BundledExtensionCatalogEntry =>
        isRequiredBundledExtension(entry.id) && entry.source === "bundled",
    ),
    (entry) =>
      Effect.gen(function* () {
        const copy = yield* classifyBundledCopy(target.path, entry);

        if (copy.state !== "tracked-behind") return;
        const result = yield* update(target, entry.id);

        yield* Effect.logInfo(
          `Refreshed required extension ${entry.id}${result.backupPath === undefined ? "" : `; backup: ${result.backupPath}`}`,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Required extension ${entry.id} was not refreshed`, { cause }),
        ),
      ),
    { concurrency: 1 },
  );

export const makeExtensionUpdate = (
  profiles: Pick<ProfileExtensionsApi, "validate">,
  lock: ProfileExtensionMutationLockApi,
  options: {
    readonly catalog?: ExtensionCatalog;
    readonly stage?: typeof installBundledPackage;
    readonly fence?: typeof withProfileUpdateLock;
    readonly pending?: typeof hasPendingExtensionUpdates;
    readonly inspectOwner?: typeof inspectGatewayOwner;
    readonly preflight?: ReturnType<typeof makeProfileExtensionPreflight>;
    readonly resident?: {
      readonly status: (target: ProfileTarget) => Effect.Effect<{
        readonly managed: Result.Result<ResidentServiceDefinitionState, ResidentServiceError>;
      }>;
      readonly stop: ResidentServiceApi["stop"];
      readonly start: ResidentServiceApi["start"];
    };
  } = {},
) => {
  const catalog = options.catalog ?? BUILTIN_EXTENSION_CATALOG;
  const stage = options.stage ?? installBundledPackage;
  const fence = options.fence ?? withProfileUpdateLock;
  const pendingUpdates = options.pending ?? hasPendingExtensionUpdates;
  const inspectOwner = options.inspectOwner ?? inspectGatewayOwner;
  const preflight = options.preflight ?? makeProfileExtensionPreflight();

  const update = (
    target: ProfileTarget,
    id: string,
    request: { readonly adopt?: boolean; readonly restart?: boolean } = {},
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

      return yield* lock.withLock(
        target.path,
        Effect.gen(function* () {
          const owner = yield* inspectOwner(target).pipe(
            Effect.mapError((cause) =>
              error("filesystem", "Could not establish whether the Profile is stopped.", cause),
            ),
          );

          if (owner._tag === "running") {
            if (!request.restart)
              return yield* error(
                "unsupported",
                "Stop the Profile resident before updating extensions, or use --restart.",
              );

            if (options.resident === undefined)
              return yield* error("unsupported", "--restart requires a managed resident.");

            const service = yield* options.resident.status(target);

            if (
              service.managed._tag !== "Success" ||
              service.managed.success._tag === "not-installed"
            )
              return yield* error(
                "unsupported",
                "--restart requires an installed managed resident.",
              );
          }

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

            const apply = Effect.gen(function* () {
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
                validate: profiles.validate(target),
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
            });

            if (owner._tag !== "running") {
              const applied = yield* oldHash === contentHash ? apply : fence(target.path, apply);

              if (!request.restart || options.resident === undefined)
                return { ...applied, residentStopped: true };

              const service = yield* options.resident.status(target);

              if (
                service.managed._tag !== "Success" ||
                service.managed.success._tag === "not-installed"
              )
                return { ...applied, residentStopped: true };

              const started = yield* options.resident.start(target).pipe(Effect.result);

              if (started._tag === "Failure" || started.success.ready !== true)
                return yield* error(
                  "resident",
                  "Update applied; resident not running; use ziggy serve start.",
                  started._tag === "Failure" ? started.failure : started.success,
                );

              return applied;
            }

            if (oldHash === contentHash) return yield* apply;

            const resident = options.resident;

            if (resident === undefined)
              return yield* error("unsupported", "--restart requires a managed resident.");

            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const stopped = yield* resident.stop(target).pipe(Effect.result);
                const stoppedOwner = yield* inspectOwner(target).pipe(Effect.result);

                const stoppedCleanly =
                  stopped._tag === "Success" &&
                  stopped.success.ready === true &&
                  stoppedOwner._tag === "Success" &&
                  stoppedOwner.success._tag !== "running";

                if (!stoppedCleanly) {
                  const running =
                    stoppedOwner._tag === "Success" && stoppedOwner.success._tag === "running";

                  const restart =
                    stoppedOwner._tag === "Success" && !running
                      ? yield* resident.start(target).pipe(Effect.result)
                      : undefined;

                  const restored =
                    restart !== undefined &&
                    restart._tag === "Success" &&
                    restart.success.ready === true;

                  const state =
                    running || restored
                      ? "running"
                      : restart === undefined
                        ? "state unknown or not running"
                        : "not running";

                  return yield* error(
                    "resident",
                    `Resident did not stop cleanly; update not applied; resident ${state}.`,
                    restart?._tag === "Failure"
                      ? restart.failure
                      : stopped._tag === "Failure"
                        ? stopped.failure
                        : stoppedOwner._tag === "Failure"
                          ? stoppedOwner.failure
                          : stopped.success,
                  );
                }

                const applied = yield* fence(target.path, apply).pipe(Effect.result);

                if (applied._tag === "Failure") {
                  const pending = yield* pendingUpdates(target.path).pipe(Effect.result);

                  if (pending._tag === "Failure" || pending.success) {
                    const quoted = JSON.stringify(target.path);

                    return yield* error(
                      "recovery",
                      `Update failed; recovery needed; rerun \`ziggy extensions update ${quoted} ${id}${request.adopt ? " --adopt" : ""}\`, then \`ziggy serve start ${quoted}\`; resident not running.`,
                      applied.failure,
                    );
                  }
                }

                const started = yield* resident.start(target).pipe(Effect.result);
                const running = started._tag === "Success" && started.success.ready === true;

                if (applied._tag === "Failure")
                  return yield* error(
                    "filesystem",
                    `Update failed; old or new version applied; resident ${running ? "running" : "not running"}.`,
                    applied.failure,
                  );

                if (!running)
                  return yield* error(
                    "resident",
                    "Update applied; resident not running; use ziggy serve start.",
                    started._tag === "Failure" ? started.failure : started.success,
                  );

                return applied.success;
              }),
            );
          }).pipe(
            Effect.ensuring(
              store
                .discard(prepared.transactionId)
                .pipe(Effect.catch((cause) => Effect.logError(cause))),
            ),
          );
        }),
      );
    }).pipe(Effect.map((result): ExtensionUpdateResult => result));
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
    return makeExtensionUpdate(yield* ProfileExtensions, yield* ProfileExtensionMutationLock, {
      resident: yield* ResidentService,
    });
  }),
);
