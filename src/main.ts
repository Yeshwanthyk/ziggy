import { homedir } from "node:os";
import * as path from "node:path";
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Runtime } from "effect";
import { PiAgentLive } from "./adapters/pi/pi-agent";
import { terminalAuthInteraction } from "./adapters/terminal/auth-interaction";
import { ZiggyAgent, ZiggyAgentLive } from "./application/agent";
import { Auth, AuthLive } from "./application/auth";
import { Automations, AutomationsLive } from "./application/automations";
import {
  DiscordGateway,
  DiscordGatewayLive,
  loadDiscordGatewayConfig,
} from "./application/discord-gateway";
import { Gateway, GatewayLive, loadGatewayConfig } from "./application/gateway";
import { Profiles, ProfilesLive } from "./application/profiles";
import {
  loadSlackGatewayConfig,
  SlackGateway,
  SlackGatewayLive,
} from "./application/slack-gateway";
import {
  resolveProfileTarget,
  resolveProfilesDirectory,
  resolveProfilesRegistry,
} from "./domain/profile";

const command = process.argv[2];

const resolutionOptions = {
  cwd: process.cwd(),
  homedir: homedir(),
  ziggyHome: process.env.ZIGGY_HOME,
};

const merlinRoot =
  process.env.ZIGGY_MERLIN_ROOT ?? path.resolve(import.meta.dir, "..", "..", "merlin");

const fail = (message: string) =>
  Effect.sync(() => {
    console.error(message);
    process.exitCode = 1;
  });

const program = Effect.gen(function* () {
  const profiles = yield* Profiles;
  const agent = yield* ZiggyAgent;
  const auth = yield* Auth;
  const automations = yield* Automations;
  const gateway = yield* Gateway;
  const discordGateway = yield* DiscordGateway;
  const slackGateway = yield* SlackGateway;

  switch (command) {
    case "init": {
      const argument = process.argv[3];
      if (argument === undefined) {
        return yield* fail("usage: ziggy init <name|path>");
      }

      const result = yield* profiles.initProfile(resolveProfileTarget(argument, resolutionOptions));
      yield* profiles
        .registerProfile(resolveProfilesRegistry(resolutionOptions), result.path)
        .pipe(Effect.catch(() => Effect.void));
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
    case "skills": {
      const action = process.argv[3];
      const argument = process.argv[4];
      if (action === "list") {
        if (argument === undefined || process.argv.length !== 5) {
          return yield* fail("usage: ziggy skills list <name|path>");
        }
        const listing = yield* profiles.listSkills(
          resolveProfileTarget(argument, resolutionOptions),
          merlinRoot,
        );
        console.log("installed:");
        if (listing.installed.length === 0) {
          console.log("(none)");
        } else {
          for (const skill of listing.installed) {
            console.log(skill.id);
          }
        }
        console.log("available:");
        if (listing.available.length === 0) {
          console.log("(none)");
        } else {
          for (const skill of listing.available) {
            console.log(skill.id);
          }
        }
        return;
      }
      if (action === "add") {
        const source = process.argv[5];
        const addArguments = process.argv.slice(6);
        const force = addArguments.length === 1 && addArguments[0] === "--force";
        if (argument === undefined || source === undefined || (addArguments.length > 0 && !force)) {
          return yield* fail("usage: ziggy skills add <name|path> <id|path> [--force]");
        }
        const installed = yield* profiles.addSkill(
          resolveProfileTarget(argument, resolutionOptions),
          merlinRoot,
          source,
          resolutionOptions.cwd,
          force,
        );
        console.log(
          `${installed.replaced ? "replaced" : "installed"} ${installed.id} at ${installed.destinationPath}`,
        );
        return;
      }
      return yield* fail(`usage:
  ziggy skills list <name|path>
  ziggy skills add <name|path> <id|path> [--force]`);
    }
    case "auth": {
      const argument = process.argv[3];
      const providerId = process.argv[4];
      const authArguments = process.argv.slice(5);
      if (argument === undefined) {
        return yield* fail("usage: ziggy auth <name|path> [provider] [--type api_key|oauth]");
      }
      if (providerId === undefined && authArguments.length > 0) {
        return yield* fail("usage: ziggy auth <name|path> [provider] [--type api_key|oauth]");
      }

      const target = resolveProfileTarget(argument, resolutionOptions);
      if (providerId === undefined) {
        const statuses = yield* auth.status(target);
        const sorted = [...statuses].sort(
          (left, right) =>
            Number(right.configured !== undefined) - Number(left.configured !== undefined) ||
            left.id.localeCompare(right.id),
        );
        for (const provider of sorted) {
          const configured =
            provider.configured === undefined
              ? "not configured"
              : `configured: ${provider.configured.type}${provider.configured.source === undefined ? "" : ` via ${provider.configured.source}`}`;
          const loginTypes = [
            ...(provider.supportsApiKeyLogin ? ["api_key"] : []),
            ...(provider.supportsOauth ? ["oauth"] : []),
          ];
          const login =
            loginTypes.length === 0 && provider.ambientOnly
              ? "ambient env only"
              : loginTypes.join(", ");
          console.log(`${provider.id}\t${configured}\tlogin: ${login}`);
        }
        return;
      }

      let type: "api_key" | "oauth" | undefined;
      if (authArguments.length > 0) {
        if (
          authArguments.length !== 2 ||
          authArguments[0] !== "--type" ||
          (authArguments[1] !== "api_key" && authArguments[1] !== "oauth")
        ) {
          return yield* fail("usage: ziggy auth <name|path> <provider> [--type api_key|oauth]");
        }
        type = authArguments[1];
      }

      const result = yield* auth.login(target, providerId, type, terminalAuthInteraction());
      console.log(
        `logged in to ${result.providerId} (${result.type})${result.source === undefined ? "" : ` via ${result.source}`}`,
      );
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
    case "discord": {
      const argument = process.argv[3];
      if (argument === undefined) {
        return yield* fail("usage: ziggy discord <name|path>");
      }

      const target = resolveProfileTarget(argument, resolutionOptions);
      const config = yield* loadDiscordGatewayConfig(target);
      return yield* discordGateway.runLoop(target, config);
    }
    case "slack": {
      const argument = process.argv[3];
      if (argument === undefined) {
        return yield* fail("usage: ziggy slack <name|path>");
      }

      const target = resolveProfileTarget(argument, resolutionOptions);
      const config = yield* loadSlackGatewayConfig(target);
      return yield* slackGateway.runLoop(target, config);
    }
    case undefined:
      process.exitCode = yield* agent.openTui(resolveProfileTarget(".", resolutionOptions), {
        kind: "local",
      });
      return;
    default:
      process.exitCode = yield* agent.openTui(resolveProfileTarget(command, resolutionOptions), {
        kind: "local",
      });
      return;
  }
}).pipe(
  Effect.catchTags({
    ProfileTargetNotDirectory: (failure) =>
      fail(`profile target is not a directory: ${failure.path}`),
    ProfileFileSystemError: (failure) =>
      fail(`failed to ${failure.operation} ${failure.path}: ${failure.message}`),
    ProfileSkillInvalid: (failure) => fail(failure.message),
    ProfileSkillNotFound: (failure) => fail(failure.message),
    ProfileSkillExists: (failure) => fail(failure.message),
    ProfileNotInitialized: (failure) => fail(failure.message),
    ProviderConfigError: (failure) => fail(failure.message),
    ProviderCallError: (failure) => fail(failure.message),
    AuthProviderUnknown: (failure) => fail(failure.message),
    AuthTypeUnsupported: (failure) => fail(failure.message),
    AuthFlowFailed: (failure) => fail(failure.message),
    MemoryIdInvalid: (failure) => fail(failure.message),
    AutomationInvalid: (failure) => fail(failure.message),
    AutomationNotFound: (failure) => fail(failure.message),
    AutomationFileSystemError: (failure) => fail(failure.message),
    GatewayConfigError: (failure) => fail(failure.message),
    TelegramApiError: (failure) => fail(failure.message),
    DiscordApiError: (failure) => fail(failure.message),
    SlackApiError: (failure) => fail(failure.message),
  }),
  Effect.provide(
    Layer.merge(
      ProfilesLive,
      Layer.merge(
        AuthLive,
        Layer.merge(
          ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)),
          Layer.merge(
            GatewayLive.pipe(Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)))),
            Layer.merge(
              DiscordGatewayLive.pipe(
                Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive))),
              ),
              Layer.merge(
                SlackGatewayLive.pipe(
                  Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive))),
                ),
                AutomationsLive.pipe(
                  Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive))),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
  ...(command === "gateway" || command === "discord" || command === "slack"
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
