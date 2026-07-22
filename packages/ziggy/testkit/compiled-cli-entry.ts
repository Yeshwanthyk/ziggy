/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: compiled test adapter coordinates host process barriers and pi-ai's Promise callback */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: compiled test adapter normalizes Node filesystem existence checks */
import { watch } from "node:fs";
import { access, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BunRuntime } from "@effect/platform-bun";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createAttachServer,
  createDaemonKernel,
  createFilesystemWorld,
  createProviderRuntimeComposition,
  ProfileLockCoordinator,
  ProviderRuntimeError,
  registerBunOAuthFlows,
} from "@ziggy/core";
import { Effect, Layer } from "effect";
import { productionDependencies, runCliExecutable, type ServeRequest } from "../src/cli.ts";
import { runProductionAsk, type CliDaemonSetup } from "../src/cli-client.ts";
import {
  DaemonReadiness,
  ensureProductionDaemonReady,
  probeDaemon,
  DaemonControlError,
  type DaemonProbeResult,
} from "../src/daemon.ts";
import { loadProfileConfig } from "../src/profile-config.ts";

const INITIAL_ABSENT_BARRIER = "ZIGGY_TEST_INITIAL_ABSENT_BARRIER";
const INITIAL_ABSENT_RELEASE = "ZIGGY_TEST_INITIAL_ABSENT_RELEASE";
const PROCESS_TRACE = "ZIGGY_TEST_PROCESS_TRACE";
const PROVIDER_REQUESTED = "ZIGGY_TEST_PROVIDER_REQUESTED";
const PROVIDER_RELEASE = "ZIGGY_TEST_PROVIDER_RELEASE";

const FixtureLayer = Layer.merge(DaemonReadiness.layer, ProfileLockCoordinator.layer);

const program = Effect.gen(function* () {
  yield* Effect.sync(registerBunOAuthFlows);
  const production = yield* productionDependencies;
  const setup: CliDaemonSetup<DaemonReadiness> = {
    probe: probeWithInitialAbsentBarrier,
    startAbsent: (profilePath) =>
      appendTrace("start-absent").pipe(
        Effect.andThen(ensureProductionDaemonReady(profilePath)),
        Effect.tap((result) =>
          result.status === "ready" ? appendTrace("protocol-ready") : Effect.void,
        ),
      ),
  };
  const dependencies = {
    ...production,
    serve: serveFixtureDaemon,
    ask: (profilePath: string, prompt: string) =>
      runProductionAsk(profilePath, prompt, setup, (text) =>
        Effect.sync(() => {
          process.stdout.write(text);
        }),
      ),
  };
  yield* runCliExecutable(Bun.argv.slice(2), dependencies);
}).pipe(
  Effect.catch(() =>
    Effect.sync(() => {
      process.stderr.write("Ziggy command failed.\n");
      process.exitCode = 1;
    }),
  ),
  Effect.provide(FixtureLayer),
);

if (import.meta.main) BunRuntime.runMain(program, { disableErrorReporting: true });

function probeWithInitialAbsentBarrier(
  profilePath: string,
): Effect.Effect<DaemonProbeResult, DaemonControlError> {
  return probeDaemon({ profilePath }).pipe(
    Effect.tap((result) => {
      if (result.status !== "unavailable" || result.socketState !== "absent") {
        return Effect.void;
      }
      const barrier = process.env[INITIAL_ABSENT_BARRIER];
      const release = process.env[INITIAL_ABSENT_RELEASE];
      if (barrier === undefined || release === undefined) {
        return appendTrace("initial-absent");
      }
      return appendTrace("initial-absent").pipe(
        Effect.andThen(writeMarker(barrier, "observed\n")),
        Effect.andThen(awaitMarker(release)),
      );
    }),
  );
}

function serveFixtureDaemon(request: ServeRequest) {
  return Effect.scoped(
    Effect.gen(function* () {
      const config = yield* loadProfileConfig(request.profilePath);
      const faux = fauxProvider();
      faux.setResponses([
        async () => {
          const requested = process.env[PROVIDER_REQUESTED];
          if (requested !== undefined) await writeMarkerPromise(requested, "requested\n");
          const release = process.env[PROVIDER_RELEASE];
          if (release !== undefined) await awaitMarkerPromise(release);
          return fauxAssistantMessage("accepted text\n\n", { timestamp: 1 });
        },
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const composition = yield* createProviderRuntimeComposition({
        profilePath: request.profilePath,
        config,
        loadConfig: () =>
          loadProfileConfig(request.profilePath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeError({
                  message: "Failed to reload fixture Profile config",
                  cause,
                }),
            ),
          ),
        models,
      });
      return yield* Effect.acquireUseRelease(
        createDaemonKernel({
          profilePath: request.profilePath,
          createWorld: (profilePath) => createFilesystemWorld({ profilePath }),
          createRuntime: composition.createRuntime,
        }),
        (kernel) =>
          Effect.acquireUseRelease(
            createAttachServer({ kernel, auth: composition.auth }),
            () => waitForAbort(request.signal),
            (server) => server.close,
          ),
        (kernel) => kernel.close,
      );
    }),
  );
}

function appendTrace(event: string): Effect.Effect<void, DaemonControlError> {
  const path = process.env[PROCESS_TRACE];
  return path === undefined ? Effect.void : writeMarker(path, `${event}\n`, true);
}

function writeMarker(
  path: string,
  contents: string,
  append = false,
): Effect.Effect<void, DaemonControlError> {
  return Effect.tryPromise({
    try: () => writeMarkerPromise(path, contents, append),
    catch: (cause) =>
      new DaemonControlError({
        operation: "compiled-test-barrier-write",
        message: "Failed to write a compiled test barrier",
        cause,
      }),
  });
}

async function writeMarkerPromise(path: string, contents: string, append = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (append) {
    await appendFile(path, contents);
    return;
  }
  await Bun.write(path, contents);
}

function awaitMarker(path: string): Effect.Effect<void, DaemonControlError> {
  return Effect.tryPromise({
    try: () => awaitMarkerPromise(path),
    catch: (cause) =>
      new DaemonControlError({
        operation: "compiled-test-barrier-await",
        message: "Failed to await a compiled test barrier",
        cause,
      }),
  });
}

async function awaitMarkerPromise(path: string): Promise<void> {
  if (await exists(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), check);
    function finish(): void {
      watcher.close();
      resolve();
    }
    function check(): void {
      void exists(path).then((present) => {
        if (present) finish();
      }, reject);
    }
    watcher.once("error", reject);
    check();
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function waitForAbort(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = (): void => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}
