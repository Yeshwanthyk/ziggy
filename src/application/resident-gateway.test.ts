/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- test fixtures own disposable filesystem and process state */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Predicate, Result, Scope } from "effect";
import { DiscordApiError } from "../adapters/discord/api";
import { AutomationSchedulerError } from "../domain/automation";
import type { ProfileTarget } from "../domain/profile";
import type { AutomationSchedulerShape } from "./automation-scheduler";
import type { DiscordGatewayShape } from "./discord-gateway";
import type { GatewayShape } from "./gateway";
import {
  loadResidentGatewayConfig,
  makeResidentGateway,
  type ResidentGatewayConfig,
  type ResidentGatewayRuntime,
} from "./resident-gateway";
import type { SlackGatewayShape } from "./slack-gateway";

const paths: Array<string> = [];
const telegram = { botToken: "telegram-token", ownerUserId: 7 };
const discord = { botToken: "discord-token", ownerUserId: "7" };
const slack = { botToken: "xoxb-token", appToken: "xapp-token", ownerUserId: "U123" };
const allConfig: ResidentGatewayConfig = { telegram, discord, slack };
const profile = async (configs: ReadonlyArray<"telegram" | "discord" | "slack"> = []) => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-resident-"));
  paths.push(path);
  await writeFile(join(path, "SOUL.md"), "# Test\n");
  await mkdir(join(path, "automations"));
  if (configs.includes("telegram"))
    await writeFile(join(path, "telegram.json"), JSON.stringify(telegram));
  if (configs.includes("discord"))
    await writeFile(join(path, "discord.json"), JSON.stringify(discord));
  if (configs.includes("slack")) await writeFile(join(path, "slack.json"), JSON.stringify(slack));
  return { path, name: "Test" } satisfies ProfileTarget;
};
const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    while (!predicate()) yield* Effect.promise<void>(() => new Promise(setImmediate));
  });
const exists = (path: string) => Bun.file(path).exists();
const isGatewayConfigError = Predicate.isTagged("GatewayConfigError");
const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));
const scheduler = (run: AutomationSchedulerShape["run"]): AutomationSchedulerShape => ({
  run,
  status: () => Effect.never,
  runs: () => Effect.never,
});
const loops = (run: (name: string) => Effect.Effect<never, never>) => ({
  telegram: { runLoop: () => run("telegram") } satisfies GatewayShape,
  discord: { runLoop: () => run("discord") } satisfies DiscordGatewayShape,
  slack: { runLoop: () => run("slack") } satisfies SlackGatewayShape,
});
const runtime = (config: ResidentGatewayConfig, events: Array<string>): ResidentGatewayRuntime => ({
  loadConfig: () => Effect.succeed(config),
  inspectOwner: () => Effect.succeed({ _tag: "stopped", path: "/owner" }),
  acquireOwner: () =>
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push("owner:enter");
        return {
          path: "/owner",
          ownerId: "owner",
          pid: 4242,
          acquiredAt: "2026-01-01T00:00:00.000Z",
        };
      }),
      () => Effect.sync(() => events.push("owner:exit")),
    ),
  logError: (message) => Effect.sync(() => events.push(message)),
});
const scopedLoop = <E = never>(
  events: Array<string>,
  name: string,
  body: Effect.Effect<never, E> = Effect.never,
): Effect.Effect<never, E> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => events.push(`${name}:enter`)),
      () => Effect.sync(() => events.push(`${name}:exit`)),
    ).pipe(Effect.andThen(body)),
  );

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("resident gateway preflight", () => {
  test("loads zero, each single, and all channel configurations", async () => {
    const cases = [
      [] as const,
      ["telegram"] as const,
      ["discord"] as const,
      ["slack"] as const,
      ["telegram", "discord", "slack"] as const,
    ];
    for (const enabled of cases) {
      const target = await profile(enabled);
      const loaded = await Effect.runPromise(loadResidentGatewayConfig(target));
      expect(
        Object.entries(loaded)
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key),
      ).toEqual([...enabled]);
    }
  });

  test("rejects every malformed present config and non-ENOENT read failures", async () => {
    for (const channel of ["telegram", "discord", "slack"] as const) {
      const target = await profile([channel]);
      await writeFile(join(target.path, `${channel}.json`), "{}");
      const result = await Effect.runPromise(loadResidentGatewayConfig(target).pipe(Effect.result));
      expect(Result.isFailure(result) && isGatewayConfigError(result.failure)).toBe(true);
    }
    const target = await profile();
    await mkdir(join(target.path, "telegram.json"));
    const unreadable = await Effect.runPromise(
      loadResidentGatewayConfig(target).pipe(Effect.result),
    );
    expect(Result.isFailure(unreadable) && isGatewayConfigError(unreadable.failure)).toBe(true);
  });

  test("a dangling config symlink fails before owner, scheduler, or channel work", async () => {
    const target = await profile();
    await symlink("missing-config.json", join(target.path, "telegram.json"));
    const events: Array<string> = [];
    const channels = loops((name) =>
      Effect.sync(() => events.push(name)).pipe(Effect.andThen(Effect.never)),
    );
    const host = makeResidentGateway(
      scheduler(() =>
        Effect.sync(() => events.push("scheduler")).pipe(Effect.andThen(Effect.never)),
      ),
      channels.telegram,
      channels.discord,
      channels.slack,
      { ...runtime(allConfig, events), loadConfig: loadResidentGatewayConfig },
    );
    const result = await Effect.runPromise(host.run(target).pipe(Effect.result));
    expect(Result.isFailure(result) && isGatewayConfigError(result.failure)).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("resident gateway supervision", () => {
  test("automation-only enters one scheduler and no channel loops", async () => {
    const target = await profile();
    const events: Array<string> = [];
    const channelLoops = loops((name) =>
      Effect.sync(() => events.push(name)).pipe(Effect.andThen(Effect.never)),
    );
    const host = makeResidentGateway(
      scheduler(() => scopedLoop(events, "scheduler")),
      channelLoops.telegram,
      channelLoops.discord,
      channelLoops.slack,
      runtime({ telegram: undefined, discord: undefined, slack: undefined }, events),
    );
    await runScoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(host.run(target));
        yield* waitFor(() => events.includes("scheduler:enter"));
        expect(events).toEqual(["owner:enter", "scheduler:enter"]);
      }),
    );
  });

  test("isolates one typed channel failure while scheduler and healthy channels stay live", async () => {
    const target = await profile();
    const events: Array<string> = [];
    const progress = await Effect.runPromise(Deferred.make<void>());
    const healthyLoops = loops((name) => scopedLoop(events, name));
    const channelLoops = {
      ...healthyLoops,
      discord: {
        runLoop: () =>
          scopedLoop(
            events,
            "discord",
            Effect.fail(
              new DiscordApiError({
                operation: "gateway",
                reason: "gateway",
                retriable: false,
                message: "socket ended",
                cause: "socket ended",
              }),
            ),
          ),
      } satisfies DiscordGatewayShape,
    };
    const host = makeResidentGateway(
      scheduler(() =>
        scopedLoop(
          events,
          "scheduler",
          Deferred.await(progress).pipe(
            Effect.andThen(Effect.sync(() => events.push("scheduler:progress"))),
            Effect.andThen(Effect.never),
          ),
        ),
      ),
      channelLoops.telegram,
      channelLoops.discord,
      channelLoops.slack,
      runtime(allConfig, events),
    );
    await runScoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(host.run(target));
        yield* waitFor(() => events.includes("discord:exit") && events.includes("slack:enter"));
        expect(events.filter((event) => event.includes("Discord stopped"))).toEqual([
          "[gateway] Discord stopped: socket ended",
        ]);
        yield* Deferred.succeed(progress, undefined);
        yield* waitFor(() => events.includes("scheduler:progress"));
        expect(events).toContain("telegram:enter");
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(events.at(-1)).toBe("owner:exit");
    for (const name of ["scheduler", "telegram", "discord", "slack"])
      expect(events.filter((event) => event === `${name}:exit`)).toHaveLength(1);
  });

  test("scheduler failure interrupts channel siblings before owner release", async () => {
    const target = await profile();
    const events: Array<string> = [];
    const failScheduler = await Effect.runPromise(Deferred.make<void>());
    const channelLoops = loops((name) => scopedLoop(events, name));
    const host = makeResidentGateway(
      scheduler(() =>
        scopedLoop(
          events,
          "scheduler",
          Deferred.await(failScheduler).pipe(
            Effect.andThen(
              Effect.fail(
                new AutomationSchedulerError({
                  operation: "run",
                  message: "scheduler stopped",
                  cause: "database",
                }),
              ),
            ),
          ),
        ),
      ),
      channelLoops.telegram,
      channelLoops.discord,
      channelLoops.slack,
      runtime(allConfig, events),
    );
    await runScoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(host.run(target));
        yield* waitFor(() =>
          ["telegram", "discord", "slack"].every((name) => events.includes(`${name}:enter`)),
        );
        yield* Deferred.succeed(failScheduler, undefined);
        const result = yield* Fiber.join(fiber).pipe(Effect.result);
        expect(Result.isFailure(result) && result.failure.message).toBe("scheduler stopped");
      }),
    );
    expect(events.at(-1)).toBe("owner:exit");
    expect(events.filter((event) => event.endsWith(":exit"))).toHaveLength(5);
  });
});

describe("gateway CLI", () => {
  const invoke = (...args: ReadonlyArray<string>) =>
    Bun.spawnSync([process.execPath, "src/main.ts", ...args], { stdout: "pipe", stderr: "pipe" });

  test("enforces exact arity and keeps legacy resident words as tombstones", () => {
    for (const args of [["serve"], ["serve", "test", "extra"]]) {
      const result = invoke(...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString().trim()).toBe(
        [
          "usage:",
          "  ziggy serve <name|path>",
          "  ziggy serve install <name|path> [--force] [--no-start]",
          "  ziggy serve start <name|path>",
          "  ziggy serve stop <name|path>",
          "  ziggy serve restart <name|path>",
          "  ziggy serve status <name|path>",
          "  ziggy serve logs <name|path> [--follow]",
          "  ziggy serve uninstall <name|path>",
        ].join("\n"),
      );
    }
    for (const args of [["gateway"], ["gateway", "test", "extra"]]) {
      const result = invoke(...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString().trim()).toBe("usage: ziggy gateway <name|path>");
    }
    for (const command of ["discord", "slack"] as const) {
      const result = invoke(command, "ignored");
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString().trim()).toBe(
        `ziggy ${command} is no longer a resident command; use: ziggy serve <name|path>`,
      );
    }
  });

  test("serve status reports a stopped process without creating runtime state", async () => {
    const target = await profile();
    const result = invoke("serve", "status", target.path);
    expect(result.exitCode).toBe(1);
    const output = result.stdout.toString().trim();
    expect(output).toContain(`profile: ${target.path}`);
    expect(output).toContain("managed service: not-installed");
    expect(output).toContain("supervisor: unknown");
    expect(output).toContain("process: stopped\npid: -\nacquired at: -");
    expect(output).toContain("scheduler: unknown");
    expect(await exists(join(target.path, ".runtime"))).toBe(false);
  });

  test("a hard crash leaves only a stale projection and the next serve replaces it", async () => {
    const target = await profile();
    const lockPath = join(target.path, ".runtime", "gateway-owner.lock");
    const spawn = () =>
      Bun.spawn([process.execPath, "src/main.ts", "serve", target.path], {
        stdout: "ignore",
        stderr: "ignore",
      });
    const first = spawn();
    for (let attempt = 0; attempt < 200 && !(await exists(lockPath)); attempt += 1)
      await Bun.sleep(10);
    const firstProjection = await readFile(lockPath, "utf8");
    first.kill("SIGKILL");
    await first.exited;
    expect(await exists(lockPath)).toBe(true);

    const second = spawn();
    let secondProjection = firstProjection;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      secondProjection = await readFile(lockPath, "utf8");
      if (secondProjection !== firstProjection) break;
      await Bun.sleep(10);
    }
    expect(secondProjection).not.toBe(firstProjection);
    second.kill("SIGINT");
    expect(await second.exited).toBe(0);
    expect(await exists(lockPath)).toBe(false);
  });

  test("interrupt-only serve and gateway shutdowns exit zero and release ownership", async () => {
    for (const command of ["serve", "gateway"] as const) {
      const target = await profile();
      const child = Bun.spawn([process.execPath, "src/main.ts", command, target.path], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const lockPath = join(target.path, ".runtime", "gateway-owner.lock");
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await exists(lockPath)) break;
        await Bun.sleep(10);
      }
      expect(await exists(lockPath)).toBe(true);
      child.kill("SIGINT");
      expect(await child.exited).toBe(0);
      expect(await exists(lockPath)).toBe(false);
    }
  });
});
