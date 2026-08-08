/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Fiber } from "effect";
import {
  listAuthStatusReadOnly,
  makePiAuth,
  type AuthInteraction,
  type PiAuthRuntime,
  type ProviderAuthType,
} from "./auth";
import {
  AuthFlowFailed,
  AuthProviderUnknown,
  AuthTypeUnsupported,
  ProfileNotInitialized,
  ProviderConfigError,
} from "../../domain/agent";

const temporaryPaths: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const profile = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-auth-"));
  temporaryPaths.push(path);
  await writeFile(join(path, "SOUL.md"), "# Soul\n", "utf8");
  return path;
};

type RuntimeProviderAuth = ReturnType<PiAuthRuntime["getProviders"]>[number]["auth"];

const provider = (id: string, auth: RuntimeProviderAuth) => ({ id, name: id, auth });

const runtime = (
  options: {
    readonly providers?: ReturnType<PiAuthRuntime["getProviders"]>;
    readonly checkAuth?: PiAuthRuntime["checkAuth"];
    readonly login?: PiAuthRuntime["login"];
  } = {},
): PiAuthRuntime => ({
  getProviders: () => options.providers ?? [],
  checkAuth: options.checkAuth ?? (() => Promise.resolve(undefined)),
  login: options.login ?? (() => Promise.resolve(undefined)),
});

const interaction: AuthInteraction = {
  prompt: () => Promise.resolve("credential"),
  notify: () => undefined,
};

describe("Pi auth Effect boundary", () => {
  test("read-only status does not create credential or model-store files", async () => {
    const profilePath = await profile();
    const before = await readdir(profilePath);

    await Effect.runPromise(listAuthStatusReadOnly(profilePath));

    expect(await readdir(profilePath)).toEqual(before);
  });
  test("fails before runtime creation when the Profile is not initialized", async () => {
    const path = await mkdtemp(join(tmpdir(), "ziggy-auth-missing-"));
    temporaryPaths.push(path);
    let createCalls = 0;
    const auth = makePiAuth(() => {
      createCalls += 1;
      return Promise.resolve(runtime());
    });

    const exit = await Effect.runPromiseExit(auth.listAuthStatus(path));

    expect(exit).toEqual(
      Exit.fail(
        new ProfileNotInitialized({
          profilePath: path,
          message: `profile is not initialized at ${path}; run 'ziggy init <name|path>'`,
        }),
      ),
    );
    expect(createCalls).toBe(0);
  });

  test("returns the exact unknown-provider failure", async () => {
    const path = await profile();
    const auth = makePiAuth(() =>
      Promise.resolve(runtime({ providers: [provider("known", { apiKey: { login: true } })] })),
    );

    const exit = await Effect.runPromiseExit(
      auth.loginProvider(path, "missing", "api_key", interaction),
    );

    expect(exit).toEqual(
      Exit.fail(
        new AuthProviderUnknown({
          profilePath: path,
          providerId: "missing",
          message: "unknown auth provider missing",
        }),
      ),
    );
  });

  test("returns the exact unsupported-type failure", async () => {
    const path = await profile();
    const auth = makePiAuth(() =>
      Promise.resolve(runtime({ providers: [provider("ambient", { apiKey: {} })] })),
    );

    const exit = await Effect.runPromiseExit(
      auth.loginProvider(path, "ambient", "api_key", interaction),
    );

    expect(exit).toEqual(
      Exit.fail(
        new AuthTypeUnsupported({
          providerId: "ambient",
          requested: "api_key",
          message:
            "provider ambient does not support api_key login; ambient only — set the provider env var",
        }),
      ),
    );
  });

  test("preserves runtime creation failure as provider configuration cause", async () => {
    const path = await profile();
    const cause = { reason: "runtime unavailable" };
    const auth = makePiAuth(() => Promise.reject(cause));

    const exit = await Effect.runPromiseExit(auth.listAuthStatus(path));

    expect(exit).toEqual(
      Exit.fail(
        new ProviderConfigError({
          profilePath: path,
          operation: "load provider auth",
          message: `could not load provider auth for ${path}`,
          cause,
        }),
      ),
    );
  });

  test("preserves provider-check rejection as the provider configuration cause", async () => {
    const path = await profile();
    const cause = { reason: "credential store unavailable" };
    const auth = makePiAuth(() =>
      Promise.resolve(
        runtime({
          providers: [provider("provider", { oauth: true })],
          checkAuth: () => Promise.reject(cause),
        }),
      ),
    );

    const exit = await Effect.runPromiseExit(auth.listAuthStatus(path));

    expect(exit).toEqual(
      Exit.fail(
        new ProviderConfigError({
          profilePath: path,
          operation: "check provider auth",
          message: "could not check provider auth for provider",
          cause,
        }),
      ),
    );
  });

  test("preserves login rejection as the authentication failure cause", async () => {
    const path = await profile();
    const cause = { reason: "credential refused" };
    const auth = makePiAuth(() =>
      Promise.resolve(
        runtime({
          providers: [provider("provider", { apiKey: { login: true } })],
          login: () => Promise.reject(cause),
        }),
      ),
    );

    const exit = await Effect.runPromiseExit(
      auth.loginProvider(path, "provider", "api_key", interaction),
    );

    expect(exit).toEqual(
      Exit.fail(
        new AuthFlowFailed({
          providerId: "provider",
          message: "authentication failed for provider",
          cause,
        }),
      ),
    );
  });

  test("interrupting login aborts the signal supplied to Pi", async () => {
    const path = await profile();
    let started: ((signal: AbortSignal) => void) | undefined;
    const loginStarted = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    let aborts = 0;
    const auth = makePiAuth(() =>
      Promise.resolve(
        runtime({
          providers: [provider("provider", { apiKey: { login: true } })],
          login: (_providerId, _type: ProviderAuthType, loginInteraction) =>
            new Promise((_resolve, reject) => {
              const signal = loginInteraction.signal;
              if (signal === undefined) {
                reject(new Error("missing login signal"));
                return;
              }
              started?.(signal);
              signal.addEventListener(
                "abort",
                () => {
                  aborts += 1;
                  reject(new Error("login aborted"));
                },
                { once: true },
              );
            }),
        }),
      ),
    );
    const fiber = Effect.runFork(auth.loginProvider(path, "provider", "api_key", interaction));
    const signal = await loginStarted;

    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));

    expect({
      exitIsFailure: Exit.isFailure(exit),
      interruptsOnly: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
      signalAborted: signal.aborted,
      aborts,
    }).toEqual({
      exitIsFailure: true,
      interruptsOnly: true,
      signalAborted: true,
      aborts: 1,
    });
  });
});
