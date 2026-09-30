import { homedir } from "node:os";
import { Config, Effect, Layer, Option } from "effect";
import { ZiggyPaths } from "../../application/ziggy-paths";

/** Read the working directory, home directory and `ZIGGY_HOME` once, when the layer builds. */
export const ZiggyPathsLive = Layer.effect(
  ZiggyPaths,
  Effect.gen(function* () {
    const ziggyHome = yield* Config.string("ZIGGY_HOME").pipe(Config.option);
    const host = yield* Effect.sync(() => ({ cwd: process.cwd(), homedir: homedir() }));

    return ZiggyPaths.make({ ...host, ziggyHome: Option.getOrUndefined(ziggyHome) });
  }),
);
