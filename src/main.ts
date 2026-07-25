import { homedir } from "node:os";
import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { PiAgentLive } from "./adapters/pi/pi-agent";
import { ZiggyAgent, ZiggyAgentLive } from "./application/agent";
import { Profiles, ProfilesLive, type ProfileError } from "./application/profiles";
import {
  ProfileNotInitialized,
  ProviderCallError,
  ProviderConfigError,
  type ZiggyAgentError,
} from "./domain/agent";
import {
  ProfileFileSystemError,
  ProfileTargetNotDirectory,
  resolveProfileTarget,
  resolveProfilesDirectory,
  resolveProfilesRegistry,
} from "./domain/profile";

const usage = `ziggy — a folder that is an assistant

usage:
  ziggy init <name|path>      create a profile (SOUL.md)
  ziggy <name|path>           open the profile in the TUI
  ziggy run <name|path> <prompt>   one-shot answer against the profile
  ziggy profiles              list known profiles`;

const command = process.argv[2];

const resolutionOptions = {
  cwd: process.cwd(),
  homedir: homedir(),
  ziggyHome: process.env.ZIGGY_HOME,
};

const fail = (message: string) =>
  Effect.sync(() => {
    console.error(message);
    process.exitCode = 1;
  });

const notImplemented = (name: string) =>
  Effect.sync(() => {
    console.log(`not implemented: ${name}`);
    process.exitCode = 1;
  });

const formatProfileError = (error: ProfileError): string => {
  if (error instanceof ProfileTargetNotDirectory) {
    return `profile target is not a directory: ${error.path}`;
  }

  if (error instanceof ProfileFileSystemError) {
    return `failed to ${error.operation} ${error.path}: ${error.message}`;
  }

  return "profile operation failed";
};

const formatAgentError = (error: ZiggyAgentError): string => {
  if (error instanceof ProfileNotInitialized) {
    return error.message;
  }

  if (error instanceof ProviderConfigError || error instanceof ProviderCallError) {
    return error.message;
  }

  return "provider operation failed";
};

const program = Effect.gen(function* () {
  const profiles = yield* Profiles;
  const agent = yield* ZiggyAgent;

  switch (command) {
    case "init": {
      const argument = process.argv[3];
      if (argument === undefined) {
        return yield* fail("usage: ziggy init <name|path>");
      }

      const result = yield* profiles.initProfile(resolveProfileTarget(argument, resolutionOptions));
      yield* profiles
        .registerProfile(resolveProfilesRegistry(resolutionOptions), result.path)
        .pipe(Effect.ignore);
      console.log(
        result.created
          ? `created profile at ${result.path}`
          : `profile already initialized at ${result.path}`,
      );
      return;
    }
    case "profiles": {
      const listings = yield* profiles.listProfiles(
        resolveProfilesDirectory(resolutionOptions),
        resolveProfilesRegistry(resolutionOptions),
      );
      if (listings.length === 0) {
        console.log("no profiles yet — try: ziggy init <name>");
        return;
      }

      for (const profile of listings) {
        console.log(`${profile.name}\t${profile.path}`);
      }
      return;
    }
    case "run": {
      const argument = process.argv[3];
      const prompt = process.argv.slice(4).join(" ");
      if (argument === undefined || prompt.trim().length === 0) {
        return yield* fail("usage: ziggy run <name|path> <prompt...>");
      }

      const exitCode = yield* agent.runOnce(
        resolveProfileTarget(argument, resolutionOptions),
        prompt,
      );
      process.exitCode = exitCode;
      return;
    }
    case undefined:
      console.log(usage);
      process.exitCode = 1;
      return;
    default:
      return yield* notImplemented(command);
  }
}).pipe(
  Effect.catch((error: ProfileError | ZiggyAgentError) =>
    fail(
      error instanceof ProfileFileSystemError || error instanceof ProfileTargetNotDirectory
        ? formatProfileError(error)
        : formatAgentError(error),
    ),
  ),
  Effect.provide(Layer.merge(ProfilesLive, ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)))),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
