import { Context, Effect, Layer } from "effect";
import { installSelfUpdate, type SelfUpdateInstaller } from "../adapters/fs/self-update";
import { ZiggyReleaseClient, type ZiggyReleaseClientShape } from "../adapters/github/self-update";
import { ZiggyUpdateUnavailable } from "../domain/extension-catalog";

export interface SelfUpdateResult {
  readonly path: string;
  readonly version: string;
}

export interface SelfUpdateShape {
  readonly update: () => Effect.Effect<SelfUpdateResult, ZiggyUpdateUnavailable>;
}

export class SelfUpdate extends Context.Service<SelfUpdate, SelfUpdateShape>()(
  "ziggy/SelfUpdate",
) {}

export interface SelfUpdateRuntime {
  readonly standalone: boolean;
  readonly executablePath: string;
}

const liveRuntime: SelfUpdateRuntime = {
  standalone:
    Bun.main === undefined || Bun.main === process.execPath || Bun.main.startsWith("/$bunfs/"),
  executablePath: process.execPath,
};

export const makeSelfUpdate = (
  client: ZiggyReleaseClientShape,
  runtime: SelfUpdateRuntime = liveRuntime,
  installer: SelfUpdateInstaller = installSelfUpdate,
): SelfUpdateShape => ({
  update: () =>
    Effect.gen(function* () {
      if (!runtime.standalone) {
        return yield* Effect.fail(
          new ZiggyUpdateUnavailable({
            message: "self-update is available only from a standalone Ziggy executable",
            cause: undefined,
          }),
        );
      }
      const release = yield* client.downloadLatest();
      yield* installer(runtime.executablePath, release.executable, release.sha256);
      return { path: runtime.executablePath, version: release.version };
    }),
});

export const SelfUpdateLive = Layer.effect(
  SelfUpdate,
  Effect.gen(function* () {
    return makeSelfUpdate(yield* ZiggyReleaseClient);
  }),
);
