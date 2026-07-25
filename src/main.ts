import { homedir } from "node:os";
import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import {
  ProfileFileSystemError,
  ProfileTargetNotDirectory,
  resolveProfileTarget,
  resolveProfilesDirectory,
} from "./domain/profile";
import { Profiles, ProfilesLive, type ProfileError } from "./application/profiles";

const usage = `ziggy — a folder that is an assistant

usage:
  ziggy init <name|path>      create a profile (SOUL.md)
  ziggy <name|path>           open the profile in the TUI
  ziggy run <name|path> <prompt>   one-shot answer against the profile
  ziggy profiles              list profiles in ~/.ziggy/profiles`;

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

const program = Effect.gen(function* () {
  const profiles = yield* Profiles;

  switch (command) {
    case "init": {
      const argument = process.argv[3];
      if (argument === undefined) {
        return yield* fail("usage: ziggy init <name|path>");
      }

      const result = yield* profiles.initProfile(resolveProfileTarget(argument, resolutionOptions));
      console.log(
        result.created
          ? `created profile at ${result.path}`
          : `profile already initialized at ${result.path}`,
      );
      return;
    }
    case "profiles": {
      const listings = yield* profiles.listProfiles(resolveProfilesDirectory(resolutionOptions));
      if (listings.length === 0) {
        console.log("no profiles yet — try: ziggy init <name>");
        return;
      }

      for (const profile of listings) {
        console.log(`${profile.name}\t${profile.path}`);
      }
      return;
    }
    case "run":
      return yield* notImplemented(command);
    case undefined:
      console.log(usage);
      process.exitCode = 1;
      return;
    default:
      return yield* notImplemented(command);
  }
}).pipe(
  Effect.catch((error: ProfileError) => fail(formatProfileError(error))),
  Effect.provide(ProfilesLive),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
