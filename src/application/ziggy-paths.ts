import { Context } from "effect";
import {
  type ProfileResolutionOptions,
  type ProfileTarget,
  resolveProfilesDirectory,
  resolveProfilesRegistry,
  resolveProfileTarget,
  resolveZiggyHome,
} from "../domain/profile";

export interface ZiggyPathsApi {
  /** The user's home directory, used for `~` expansion and display. */
  readonly homedir: string;
  /** `ZIGGY_HOME`, resolved against the working directory; defaults to `~/.ziggy`. */
  readonly ziggyHome: string;
  readonly profilesDirectory: string;
  readonly profilesRegistry: string;
  /** Resolve a CLI Profile argument: a path, or a name under `profilesDirectory`. */
  readonly resolveTarget: (value: string) => ProfileTarget;
}

/** Where Ziggy's home, Profiles and registry live for this process. */
export class ZiggyPaths extends Context.Service<ZiggyPaths, ZiggyPathsApi>()("ziggy/ZiggyPaths") {
  static readonly make = (options: ProfileResolutionOptions): ZiggyPathsApi => ({
    homedir: options.homedir,
    ziggyHome: resolveZiggyHome(options),
    profilesDirectory: resolveProfilesDirectory(options),
    profilesRegistry: resolveProfilesRegistry(options),
    resolveTarget: (value) => resolveProfileTarget(value, options),
  });
}
