/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun async tests own disposable Effect execution */
/* oxlint-disable ziggy-effect/no-effect-escape-hatch -- unreachable fake methods fail tests immediately */
import { Effect, Exit } from "effect";
import { expect, test } from "bun:test";
import type { AuthApi } from "ziggy/application/auth";
import type { DoctorApi } from "ziggy/application/doctor";
import type { ModelsApi } from "ziggy/application/models";
import type { ProfilesApi } from "ziggy/application/profiles";
import { makeSetup, type SetupInteraction } from "ziggy/application/setup";
import type { DoctorReport } from "ziggy/domain/doctor";
import { ProfileFileSystemError } from "ziggy/domain/profile";

const target = { path: "/profile", name: "Profile" };
const report: DoctorReport = {
  profilePath: target.path,
  checks: [{ id: "profile", severity: "ok", message: "valid" }],
  hasErrors: false,
};

const profiles = (events: string[], registerFails = false): ProfilesApi => ({
  initProfile: (_target, options) => {
    events.push(`init:${options?.createStarterDirectories === true}`);
    return Effect.succeed({
      path: target.path,
      created: false,
      createdDirectories: [],
    });
  },
  registerProfile: () => {
    events.push("register");
    return registerFails
      ? Effect.fail(
          new ProfileFileSystemError({
            operation: "append",
            path: "/registry",
            message: "registry unavailable",
            code: "EACCES",
            cause: "registry unavailable",
          }),
        )
      : Effect.void;
  },
  listProfiles: () => Effect.die("unused"),
  addExtension: () => Effect.die("unused"),
  removeExtension: () => Effect.die("unused"),
});

const auth = (events: string[], configured = true): AuthApi => ({
  status: () => {
    events.push("auth-status");
    return Effect.succeed([
      {
        id: "anthropic",
        name: "Anthropic",
        supportsApiKeyLogin: true,
        ambientOnly: false,
        supportsOauth: true,
        configured: configured ? { type: "api_key" } : undefined,
      },
    ]);
  },
  readOnlyStatus: () => {
    events.push("auth-read-only-status");
    return Effect.succeed([
      {
        id: "anthropic",
        name: "Anthropic",
        supportsApiKeyLogin: true,
        ambientOnly: false,
        supportsOauth: true,
        configured: configured ? { type: "api_key" } : undefined,
      },
    ]);
  },
  login: () => {
    events.push("login");
    return Effect.succeed({ providerId: "anthropic", type: "api_key", source: undefined });
  },
});

const models = (
  events: string[],
  current: { providerId: string | undefined; modelId: string | undefined; thinking: string },
): ModelsApi => ({
  status: () => {
    events.push("model-status");
    return Effect.succeed({ ...current, authConfigured: current.providerId !== undefined });
  },
  readOnlyStatus: () => {
    events.push("model-read-only-status");
    return Effect.succeed({ ...current, authConfigured: current.providerId !== undefined });
  },
  list: (_target, providerId) => {
    events.push(`models-list:${providerId ?? "all"}`);
    return Effect.succeed([
      {
        providerId: "anthropic",
        modelId: "claude",
        name: "Claude",
        thinkingLevels: ["off", "high"],
      },
    ]);
  },
  set: (_target, providerId, modelId, thinking) => {
    events.push(`models-set:${providerId}/${modelId}:${thinking ?? "unchanged"}`);
    current.providerId = providerId;
    current.modelId = modelId;
    current.thinking = thinking ?? current.thinking;
    return Effect.succeed({ providerId, modelId, thinking });
  },
});

const doctor = (events: string[]): DoctorApi => ({
  check: () => {
    events.push("doctor");
    return Effect.succeed(report);
  },
});

const interaction = (events: string[]): SetupInteraction => ({
  select: () => {
    events.push("prompt");
    return Effect.die("unexpected prompt");
  },
  auth: {
    prompt: async () => {
      events.push("auth-prompt");
      return "secret-never-printed";
    },
    notify: () => undefined,
  },
});

test("existing guided setup resumes configured auth and model without resetting or prompting", async () => {
  const events: string[] = [];
  const current = {
    providerId: "anthropic",
    modelId: "claude",
    thinking: "high",
  } satisfies Parameters<typeof models>[1];
  const setup = makeSetup(profiles(events), auth(events), models(events, current), doctor(events));

  const result = await Effect.runPromise(
    setup.initialize(
      target,
      "/registry",
      "/repository",
      { minimal: false, interactive: true },
      interaction(events),
    ),
  );

  expect(result.modelStatus).toMatchObject({
    providerId: "anthropic",
    modelId: "claude",
    thinking: "high",
  });
  expect(events).toEqual([
    "init:true",
    "register",
    "model-status",
    "auth-status",
    "models-list:anthropic",
    "model-status",
    "doctor",
  ]);
});

test("explicit non-interactive setup selects through Models without prompting", async () => {
  const events: string[] = [];
  const current = {
    providerId: undefined,
    modelId: undefined,
    thinking: "medium",
  } satisfies Parameters<typeof models>[1];
  const setup = makeSetup(profiles(events), auth(events), models(events, current), doctor(events));

  await Effect.runPromise(
    setup.initialize(
      target,
      "/registry",
      "/repository",
      {
        minimal: false,
        interactive: false,
        providerId: "anthropic",
        modelId: "claude",
        thinking: "high",
      },
      interaction(events),
    ),
  );

  expect(events).toContain("models-set:anthropic/claude:high");
  expect(events).not.toContain("prompt");
  expect(events).not.toContain("login");
});

test("non-interactive setup fails rather than prompting and registry failures remain visible", async () => {
  const missingEvents: string[] = [];
  const current = {
    providerId: undefined,
    modelId: undefined,
    thinking: "medium",
  } satisfies Parameters<typeof models>[1];
  const missing = makeSetup(
    profiles(missingEvents),
    auth(missingEvents),
    models(missingEvents, current),
    doctor(missingEvents),
  );
  const missingExit = await Effect.runPromiseExit(
    missing.initialize(
      target,
      "/registry",
      "/repository",
      { minimal: false, interactive: false },
      interaction(missingEvents),
    ),
  );
  expect(Exit.isFailure(missingExit)).toBeTrue();
  expect(missingEvents).not.toContain("prompt");

  const registryEvents: string[] = [];
  const registry = makeSetup(
    profiles(registryEvents, true),
    auth(registryEvents),
    models(registryEvents, current),
    doctor(registryEvents),
  );
  const registryExit = await Effect.runPromiseExit(
    registry.initialize(
      target,
      "/registry",
      "/repository",
      { minimal: true, interactive: false },
      interaction(registryEvents),
    ),
  );
  expect(Exit.isFailure(registryExit)).toBeTrue();
  expect(registryEvents).toEqual(["init:false", "register"]);
});
