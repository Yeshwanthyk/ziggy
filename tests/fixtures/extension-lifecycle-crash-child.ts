import { Effect } from "effect";
import { ExtensionLifecycle } from "../../packages/core/src/index.ts";
import type { ExtensionLifecycleNodeCheckpoint } from "../../packages/core/src/extensions/lifecycle-node-adapter.ts";
import { runEffect } from "../testkit/effect.ts";

const profilePath = process.env.ZIGGY_CRASH_PROFILE;
const sourcePath = process.env.ZIGGY_CRASH_SOURCE;
const target = process.env.ZIGGY_CRASH_CHECKPOINT;

if (profilePath === undefined || sourcePath === undefined || target === undefined) {
  process.stderr.write("missing crash fixture input\n");
  process.exit(2);
}

await runEffect(
  Effect.gen(function* () {
    const lifecycle = yield* ExtensionLifecycle;
    yield* lifecycle.install({ sourcePath, approvals: [] });
  }).pipe(
    Effect.provide(
      ExtensionLifecycle.layer({
        profilePath,
        nodeHooks: {
          checkpoint(point: ExtensionLifecycleNodeCheckpoint) {
            if (point !== target) return Promise.resolve();
            process.stdout.write("READY\n");
            return Promise.withResolvers<void>().promise;
          },
        },
      }),
    ),
  ),
);
