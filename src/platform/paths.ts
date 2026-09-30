import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Config, Context, Effect, Layer, Option } from "effect";

export interface ZiggyPathsApi {
  /** The working directory relative CLI paths resolve against. */
  readonly cwd: string;
  /** The user's home directory, used for `~` expansion and display. */
  readonly homedir: string;
  /** `ZIGGY_HOME`, resolved against the working directory; defaults to `~/.ziggy`. */
  readonly ziggyHome: string;
  readonly profilesDirectory: string;
  readonly profilesRegistry: string;
}

/** Where Ziggy's home, Profiles and registry live for this process. */
export class ZiggyPaths extends Context.Service<ZiggyPaths, ZiggyPathsApi>()("ziggy/ZiggyPaths") {
  static readonly make = (options: {
    readonly cwd: string;
    readonly homedir: string;
    readonly ziggyHome?: string | undefined;
  }): ZiggyPathsApi => {
    const ziggyHome = resolve(options.cwd, options.ziggyHome ?? join(options.homedir, ".ziggy"));

    return {
      cwd: options.cwd,
      homedir: options.homedir,
      ziggyHome,
      profilesDirectory: join(ziggyHome, "profiles"),
      profilesRegistry: join(ziggyHome, "profiles.list"),
    };
  };
}

/** Read the working directory, home directory and `ZIGGY_HOME` once, when the layer builds. */
export const ZiggyPathsLive = Layer.effect(
  ZiggyPaths,
  Effect.gen(function* () {
    const ziggyHome = yield* Config.string("ZIGGY_HOME").pipe(Config.option);
    const host = yield* Effect.sync(() => ({ cwd: process.cwd(), homedir: homedir() }));

    return ZiggyPaths.make({ ...host, ziggyHome: Option.getOrUndefined(ziggyHome) });
  }),
);
