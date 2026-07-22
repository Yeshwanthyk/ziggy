import { BunRuntime } from "@effect/platform-bun";
import { probeBunOAuthFlows, ProfileLockCoordinator, registerBunOAuthFlows } from "@ziggy/core";
import { Console, Effect, Layer } from "effect";
import { productionDependencies, runCliExecutable } from "./cli.ts";
import { DaemonReadiness } from "./daemon.ts";

const ProductionLayer = Layer.merge(DaemonReadiness.layer, ProfileLockCoordinator.layer);

const program = Effect.gen(function* () {
  yield* Effect.sync(registerBunOAuthFlows);
  if (Bun.argv[2] === "--oauth-loader-smoke") {
    yield* probeBunOAuthFlows;
    yield* Console.log("oauth-loaders:ok");
    return;
  }
  const dependencies = yield* productionDependencies;
  yield* runCliExecutable(Bun.argv.slice(2), dependencies);
}).pipe(
  Effect.catch(() =>
    Effect.sync(() => {
      process.stderr.write("Ziggy command failed.\n");
      process.exitCode = 1;
    }),
  ),
  Effect.provide(ProductionLayer),
);

if (import.meta.main) BunRuntime.runMain(program, { disableErrorReporting: true });

export { runCli } from "./cli.ts";
export * from "./daemon.ts";
export * from "./profile-initialization.ts";
export * from "./service.ts";
