import { homedir } from "node:os";
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Runtime } from "effect";
import { PiAgentLive } from "./adapters/pi/pi-agent";
import { TelegramApiError } from "./adapters/telegram/api";
import { ZiggyAgent, ZiggyAgentLive } from "./application/agent";
import { Automations, AutomationsLive, type AutomationError } from "./application/automations";
import { Gateway, GatewayLive, loadGatewayConfig } from "./application/gateway";
import { Profiles, ProfilesLive, type ProfileError } from "./application/profiles";
import {
  AutomationFileSystemError,
  AutomationInvalid,
  AutomationNotFound,
} from "./domain/automation";
import {
  ProfileNotInitialized,
  ProviderCallError,
  ProviderConfigError,
  type ZiggyAgentError,
} from "./domain/agent";
import { MemoryIdInvalid } from "./domain/memory";
import {
  ProfileFileSystemError,
  ProfileTargetNotDirectory,
  resolveProfileTarget,
  resolveProfilesDirectory,
  resolveProfilesRegistry,
} from "./domain/profile";
import { GatewayConfigError } from "./domain/telegram";

const usage = `ziggy — a folder that is an assistant

usage:
  ziggy init <name|path>      create a profile (SOUL.md)
  ziggy <name|path>           open the profile in the TUI
  ziggy run [-c] <name|path> <prompt>   one-shot answer against the profile
  ziggy wake <name|path> <automation-id>   manually wake an automation
  ziggy gateway <name|path>   run the resident Telegram gateway
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

  if (error instanceof MemoryIdInvalid) {
    return error.message;
  }

  return "provider operation failed";
};

const formatGatewayError = (error: GatewayConfigError | TelegramApiError): string => error.message;

const formatAutomationError = (error: AutomationError): string => {
  if (
    error instanceof AutomationInvalid ||
    error instanceof AutomationNotFound ||
    error instanceof AutomationFileSystemError
  ) {
    return error.message;
  }

  return error instanceof TelegramApiError ? formatGatewayError(error) : formatAgentError(error);
};

const program = Effect.gen(function* () {
  const profiles = yield* Profiles;
  const agent = yield* ZiggyAgent;
  const automations = yield* Automations;
  const gateway = yield* Gateway;

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
      const runArguments = process.argv.slice(3);
      const continueSession = runArguments[0] === "-c" || runArguments[0] === "--continue";
      const argument = runArguments[continueSession ? 1 : 0];
      const prompt = runArguments.slice(continueSession ? 2 : 1).join(" ");
      if (argument === undefined || prompt.trim().length === 0) {
        return yield* fail("usage: ziggy run [-c] <name|path> <prompt...>");
      }

      const exitCode = yield* agent.runOnce(
        resolveProfileTarget(argument, resolutionOptions),
        prompt,
        continueSession,
        { kind: "local" },
      );
      process.exitCode = exitCode;
      return;
    }
    case "wake": {
      const argument = process.argv[3];
      const automationId = process.argv[4];
      if (argument === undefined || automationId === undefined) {
        return yield* fail("usage: ziggy wake <name|path> <automation-id>");
      }

      yield* automations.wake(resolveProfileTarget(argument, resolutionOptions), automationId);
      return;
    }
    case "gateway": {
      const argument = process.argv[3];
      if (argument === undefined) {
        return yield* fail("usage: ziggy gateway <name|path>");
      }

      const target = resolveProfileTarget(argument, resolutionOptions);
      const config = yield* loadGatewayConfig(target);
      return yield* gateway.runLoop(target, config);
    }
    case undefined:
      console.log(usage);
      process.exitCode = 1;
      return;
    default:
      process.exitCode = yield* agent.openTui(resolveProfileTarget(command, resolutionOptions), {
        kind: "local",
      });
      return;
  }
}).pipe(
  Effect.catch(
    (
      error:
        | ProfileError
        | ZiggyAgentError
        | GatewayConfigError
        | TelegramApiError
        | AutomationError,
    ) =>
      fail(
        error instanceof ProfileFileSystemError || error instanceof ProfileTargetNotDirectory
          ? formatProfileError(error)
          : error instanceof AutomationInvalid ||
              error instanceof AutomationNotFound ||
              error instanceof AutomationFileSystemError
            ? formatAutomationError(error)
            : error instanceof GatewayConfigError || error instanceof TelegramApiError
              ? formatGatewayError(error)
              : formatAgentError(error),
      ),
  ),
  Effect.provide(
    Layer.merge(
      ProfilesLive,
      Layer.merge(
        ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)),
        Layer.merge(
          GatewayLive.pipe(Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)))),
          AutomationsLive.pipe(Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)))),
        ),
      ),
    ),
  ),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
  ...(command === "gateway"
    ? {
        teardown: (exit, onExit) => {
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
            onExit(0);
          } else {
            Runtime.defaultTeardown(exit, onExit);
          }
        },
      }
    : {}),
});
