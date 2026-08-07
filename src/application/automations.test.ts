/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixtures exercise the Node filesystem adapter */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, Option } from "effect";
import {
  automationRunStore,
  commitScheduleTick,
  makeAutomationRunStore,
  readAutomationRuns,
  recoverAutomationRuns,
  type AutomationRunStore,
  type RunTerminal,
} from "../adapters/bun/automation-sqlite";
import { automationFileStore } from "../adapters/fs/automation-files";
import { TelegramApiError } from "../adapters/telegram/api";
import { ProviderCallError } from "../domain/agent";
import { AutomationDatabaseError, type AutomationTargetOutcome } from "../domain/automation";
import type { ProfileTarget } from "../domain/profile";
import type { ZiggyAgentShape } from "./agent";
import { type AutomationCapabilities, makeAutomations } from "./automations";

const paths: Array<string> = [];
const definition = (broadcast: string, extras: ReadonlyArray<string> = []) =>
  [
    "---",
    "version: 1",
    "cron: 0 9 * * *",
    "timezone: America/New_York",
    ...extras,
    `broadcast: ${broadcast}`,
    "---",
    "Write the daily note.",
    "",
  ].join("\n");

const profile = async (broadcast: string, extras: ReadonlyArray<string> = []) => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-automations-"));
  paths.push(path);
  await mkdir(join(path, "automations"));
  await writeFile(join(path, "SOUL.md"), "# Test\n");
  await writeFile(join(path, "automations", "daily-note.md"), definition(broadcast, extras));
  return { path, name: "Test" } satisfies ProfileTarget;
};

const harness = (
  events: Array<string>,
  options: {
    readonly gateExit?: number;
    readonly telegramFailure?: TelegramApiError;
    readonly promptFailure?: ProviderCallError;
    readonly promptEffect?: Effect.Effect<string, ProviderCallError>;
    readonly store?: AutomationRunStore;
  } = {},
) => {
  const agent: ZiggyAgentShape = {
    runOnce: () => Effect.succeed(0),
    openTui: () => Effect.succeed(0),
    openChat: (target, context, sessionPath, mode) =>
      Effect.sync(() => {
        events.push(`open:${target.path}:${context.kind}:${sessionPath}:${mode}`);
        return {
          prompt: (prompt) =>
            Effect.sync(() => events.push(`prompt:${prompt}`)).pipe(
              Effect.andThen(
                options.promptEffect ??
                  (options.promptFailure === undefined
                    ? Effect.succeed("local reply")
                    : Effect.fail(options.promptFailure)),
              ),
            ),
          dispose: Effect.sync(() => {
            events.push("dispose");
          }),
        };
      }),
  };
  const capabilities: AutomationCapabilities = {
    gate: {
      run: (_path, _id, command) =>
        Effect.sync(() => {
          events.push(`gate:${command}`);
          return options.gateExit === undefined || options.gateExit === 0
            ? { kind: "passed" as const }
            : { kind: "declined" as const, exitCode: options.gateExit };
        }),
    },
    files: automationFileStore,
    printReply: (reply) =>
      Effect.sync(() => {
        events.push(`reply:${reply}`);
      }),
    loadTelegramConfig: () =>
      Effect.sync(() => {
        events.push("config:telegram");
        return { botToken: "t", ownerUserId: 1 };
      }),
    loadDiscordConfig: () =>
      Effect.sync(() => {
        events.push("config:discord");
        return { botToken: "d", ownerUserId: "1" };
      }),
    loadSlackConfig: () =>
      Effect.sync(() => {
        events.push("config:slack");
        return { botToken: "s", appToken: "a", ownerUserId: "U" };
      }),
    sendTelegram: (_token, id, text) =>
      Effect.gen(function* () {
        events.push(`send:telegram:${id}:${text}`);
        if (options.telegramFailure !== undefined) return yield* options.telegramFailure;
      }),
    sendDiscord: (_token, id, text) =>
      Effect.sync(() => {
        events.push(`send:discord:${id}:${text}`);
      }),
    sendSlack: (_token, id, text, thread) =>
      Effect.sync(() => {
        events.push(`send:slack:${id}:${thread ?? "-"}:${text}`);
      }),
  };
  return makeAutomations(agent, capabilities, {
    store: options.store ?? automationRunStore,
    now: Effect.succeed(1_000),
    makeManualRunId: () => "manual:00000000-0000-4000-8000-000000000001",
  });
};

const run = (service: ReturnType<typeof harness>, target: ProfileTarget) =>
  Effect.runPromise(service.run(target, "daily-note", { kind: "manual-force" }));

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("automation run", () => {
  test("an absent gate opens one exact fresh session, prompts once, prints once, and records the manual run", async () => {
    const events: Array<string> = [];
    const target = await profile("none");
    const bytes = await readFile(join(target.path, "automations", "daily-note.md"), "utf8");
    const outcome = await run(harness(events), target);
    expect(outcome).toEqual({ kind: "executed", delivery: { kind: "resolved", targets: [] } });
    expect(events).toEqual([
      `open:${target.path}:local:${join(target.path, "sessions", "automations", "daily-note")}:fresh`,
      "prompt:Write the daily note.",
      "dispose",
      "reply:local reply",
    ]);
    expect(await readFile(join(target.path, "automations", "daily-note.md"), "utf8")).toBe(bytes);
    const runs = await Effect.runPromise(readAutomationRuns(target.path));
    expect(runs).toEqual([
      {
        runId: "manual:00000000-0000-4000-8000-000000000001",
        automationId: "daily-note",
        trigger: "manual-force",
        state: "completed",
        scheduleFingerprint: null,
        scheduledForMs: null,
        missedThroughMs: null,
        recordedAtMs: 1_000,
        startedAtMs: 1_000,
        finishedAtMs: 1_000,
        localCompleted: true,
        failureCategory: null,
        gateExitCode: null,
        targets: [],
      },
    ]);
  });

  test("recovers a dead owner before manual admission", async () => {
    const events: Array<string> = [];
    const target = await profile("none");
    const child = Bun.spawn([process.execPath, "-e", ""], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadStore = makeAutomationRunStore(child.pid);
    await child.exited;
    const orphanId = "manual:00000000-0000-4000-8000-000000000002";
    await Effect.runPromise(deadStore.admitManual(target.path, "daily-note", orphanId, 100));
    await Effect.runPromise(deadStore.start(target.path, orphanId, 110, null));

    const liveId = "manual:00000000-0000-4000-8000-000000000003";
    const liveStore = makeAutomationRunStore(process.pid);
    await Effect.runPromise(liveStore.admitManual(target.path, "live", liveId, 200));

    expect(await run(harness(events), target)).toEqual({
      kind: "executed",
      delivery: { kind: "resolved", targets: [] },
    });
    const persisted = Object.fromEntries(
      (await Effect.runPromise(readAutomationRuns(target.path))).map((item) => [
        item.runId,
        { state: item.state, failureCategory: item.failureCategory },
      ]),
    );
    expect(persisted).toMatchObject({
      [orphanId]: { state: "unknown", failureCategory: "process-start" },
      [liveId]: { state: "claimed", failureCategory: null },
      "manual:00000000-0000-4000-8000-000000000001": {
        state: "completed",
        failureCategory: null,
      },
    });
  });

  test("a nonzero gate declines before Pi", async () => {
    const events: Array<string> = [];
    const target = await profile("none", ["gate: exit 7"]);
    expect(await run(harness(events, { gateExit: 7 }), target)).toEqual({
      kind: "declined",
      reason: "gate-nonzero",
      exitCode: 7,
    });
    expect(events).toEqual(["gate:exit 7"]);
  });

  test("a scheduled definition without a gate records skipped-gate before Pi", async () => {
    const events: Array<string> = [];
    const target = await profile("none");
    const fingerprint = "a".repeat(64);
    const initial = {
      automationId: "daily-note",
      definitionState: "valid" as const,
      scheduleFingerprint: fingerprint,
      nextScheduledAtMs: 1_000,
      definitionObservedAtMs: 0,
      definitionError: null,
    };
    await Effect.runPromise(
      commitScheduleTick(target.path, 0, [{ expected: null, next: initial }]),
    );
    await Effect.runPromise(
      commitScheduleTick(target.path, 1_000, [
        {
          expected: initial,
          next: { ...initial, nextScheduledAtMs: 2_000, definitionObservedAtMs: 1_000 },
          occurrence: {
            kind: "due",
            runId: "scheduled:daily-note:1970-01-01T00:00:01.000Z",
            scheduledForMs: 1_000,
            missedThroughMs: null,
            scheduleFingerprint: fingerprint,
          },
        },
      ]),
    );
    expect(
      await Effect.runPromise(
        harness(events).run(target, "daily-note", {
          kind: "scheduled",
          scheduledFor: "1970-01-01T00:00:01.000Z",
          scheduleFingerprint: fingerprint,
        }),
      ),
    ).toEqual({ kind: "declined", reason: "gate-nonzero", exitCode: 1 });
    expect(events).toEqual([]);
    const persisted = (await Effect.runPromise(readAutomationRuns(target.path)))[0];
    expect([persisted?.state, persisted?.failureCategory]).toEqual([
      "skipped-gate",
      "gate-missing",
    ]);
  });

  test("prints before resolution and malformed broadcasts sends nothing", async () => {
    const events: Array<string> = [];
    const target = await profile("all");
    await writeFile(join(target.path, "broadcasts.json"), '{"targets":[42]}');
    expect(await run(harness(events), target)).toEqual({
      kind: "executed",
      delivery: { kind: "resolution-failed", category: "broadcasts-invalid" },
    });
    expect(events).toEqual([
      `open:${target.path}:local:${join(target.path, "sessions", "automations", "daily-note")}:fresh`,
      "prompt:Write the daily note.",
      "dispose",
      "reply:local reply",
    ]);
  });

  test("resolves origin, all, explicit targets, and first-seen deduplication", async () => {
    const events: Array<string> = [];
    const target = await profile("origin,all,telegram:chat:2,origin", [
      "origin: slack:channel:C0123ABCDE",
    ]);
    await writeFile(
      join(target.path, "broadcasts.json"),
      JSON.stringify({ targets: ["telegram:chat:2", "discord:channel:3", "telegram:chat:2"] }),
    );
    expect(await run(harness(events), target)).toEqual({
      kind: "executed",
      delivery: {
        kind: "resolved",
        targets: [
          { target: "slack:channel:C0123ABCDE", status: "delivered" },
          { target: "telegram:chat:2", status: "delivered" },
          { target: "discord:channel:3", status: "delivered" },
        ],
      },
    });
    expect(events.slice(-6)).toEqual([
      "config:slack",
      "send:slack:C0123ABCDE:-:local reply",
      "config:telegram",
      "send:telegram:2:local reply",
      "config:discord",
      "send:discord:3:local reply",
    ]);
  });

  test("only reads all when requested and reports an empty all after stdout", async () => {
    const explicitEvents: Array<string> = [];
    const explicit = await profile("telegram:chat:2");
    await writeFile(join(explicit.path, "broadcasts.json"), "invalid");
    expect(await run(harness(explicitEvents), explicit)).toEqual({
      kind: "executed",
      delivery: { kind: "resolved", targets: [{ target: "telegram:chat:2", status: "delivered" }] },
    });
    const allEvents: Array<string> = [];
    const all = await profile("all");
    expect(await run(harness(allEvents), all)).toEqual({
      kind: "executed",
      delivery: { kind: "resolution-failed", category: "all-empty" },
    });
    expect(allEvents.at(-1)).toBe("reply:local reply");
  });

  test("a truthful terminal database failure is attempted once and is not fabricated", async () => {
    const events: Array<string> = [];
    const target = await profile("discord:channel:1,telegram:chat:2");
    const failure = new AutomationDatabaseError({
      operation: "finish run",
      path: target.path,
      message: "injected terminal write failure",
      cause: "fixture",
    });
    let finishCalls = 0;
    let terminal: RunTerminal | undefined;
    let targets: ReadonlyArray<AutomationTargetOutcome> = [];
    const store: AutomationRunStore = {
      ...automationRunStore,
      finish: (profilePath, runId, nextTerminal, nextTargets) => {
        finishCalls += 1;
        terminal = nextTerminal;
        targets = nextTargets;
        return finishCalls === 1
          ? Effect.fail(failure)
          : automationRunStore.finish(profilePath, runId, nextTerminal, nextTargets);
      },
    };

    const result = await Effect.runPromise(
      harness(events, { store })
        .run(target, "daily-note", { kind: "manual-force" })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: (outcome) => outcome,
          }),
        ),
    );
    expect(result).toBe(failure);
    expect(finishCalls).toBe(1);
    expect(terminal).toEqual({
      state: "completed",
      atMs: 1_000,
      localCompleted: true,
      failureCategory: null,
      gateExitCode: null,
    });
    expect(targets).toEqual([
      { target: "discord:channel:1", status: "delivered" },
      { target: "telegram:chat:2", status: "delivered" },
    ]);
    expect((await Effect.runPromise(readAutomationRuns(target.path)))[0]).toMatchObject({
      state: "running",
      localCompleted: false,
      failureCategory: null,
      finishedAtMs: null,
      targets: [],
    });

    await Effect.runPromise(recoverAutomationRuns(target.path, 2_000, () => false));
    expect((await Effect.runPromise(readAutomationRuns(target.path)))[0]).toMatchObject({
      state: "unknown",
      localCompleted: false,
      failureCategory: "process-start",
      finishedAtMs: 2_000,
      targets: [],
    });
  });

  test("surfaces terminal database failure over the execution failure", async () => {
    const events: Array<string> = [];
    const target = await profile("none");
    const providerFailure = new ProviderCallError({
      profilePath: target.path,
      operation: "prompt",
      message: "injected provider failure",
      cause: "fixture",
    });
    const databaseFailure = new AutomationDatabaseError({
      operation: "finish run",
      path: target.path,
      message: "injected terminal write failure",
      cause: "fixture",
    });
    let finishCalls = 0;
    const store: AutomationRunStore = {
      ...automationRunStore,
      finish: () => {
        finishCalls += 1;
        return Effect.fail(databaseFailure);
      },
    };

    const result = await Effect.runPromise(
      harness(events, { promptFailure: providerFailure, store })
        .run(target, "daily-note", { kind: "manual-force" })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: (outcome) => outcome,
          }),
        ),
    );
    expect(result).toBe(databaseFailure);
    expect(finishCalls).toBe(1);
    expect(events).toEqual([
      `open:${target.path}:local:${join(target.path, "sessions", "automations", "daily-note")}:fresh`,
      "prompt:Write the daily note.",
      "dispose",
    ]);
    expect((await Effect.runPromise(readAutomationRuns(target.path)))[0]).toMatchObject({
      state: "running",
      localCompleted: false,
      failureCategory: null,
      finishedAtMs: null,
    });
  });

  test("interruption during execution publishes one interrupted terminal", async () => {
    const events: Array<string> = [];
    const target = await profile("none");
    const entered = await Effect.runPromise(Deferred.make<void>());
    let finishCalls = 0;
    let terminal: RunTerminal | undefined;
    const store: AutomationRunStore = {
      ...automationRunStore,
      finish: (profilePath, runId, nextTerminal, targets) => {
        finishCalls += 1;
        terminal = nextTerminal;
        return automationRunStore.finish(profilePath, runId, nextTerminal, targets);
      },
    };
    const service = harness(events, {
      store,
      promptEffect: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const fiber = Effect.runFork(service.run(target, "daily-note", { kind: "manual-force" }));
    await Effect.runPromise(Deferred.await(entered));

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(finishCalls).toBe(1);
    expect(events.at(-1)).toBe("dispose");
    expect(terminal).toEqual({
      state: "failed",
      atMs: 1_000,
      localCompleted: false,
      failureCategory: "interrupted",
      gateExitCode: null,
    });
    expect((await Effect.runPromise(readAutomationRuns(target.path)))[0]).toMatchObject({
      state: "failed",
      localCompleted: false,
      failureCategory: "interrupted",
      finishedAtMs: 1_000,
    });
  });

  test("an interrupted run preserves terminal publication failure in its exit", async () => {
    const events: Array<string> = [];
    const target = await profile("none");
    const entered = await Effect.runPromise(Deferred.make<void>());
    const databaseFailure = new AutomationDatabaseError({
      operation: "finish run",
      path: target.path,
      message: "injected interrupted terminal write failure",
      cause: "fixture",
    });
    let finishCalls = 0;
    const store: AutomationRunStore = {
      ...automationRunStore,
      finish: () => {
        finishCalls += 1;
        return Effect.fail(databaseFailure);
      },
    };
    const fiber = Effect.runFork(
      harness(events, {
        store,
        promptEffect: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      }).run(target, "daily-note", { kind: "manual-force" }),
    );
    await Effect.runPromise(Deferred.await(entered));

    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));

    expect(finishCalls).toBe(1);
    expect(exit).toEqual(Exit.fail(databaseFailure));
  });

  test("interruption during terminal publication waits for the one truthful terminal attempt", async () => {
    const events: Array<string> = [];
    const target = await profile("none");
    const finishEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseFinish = await Effect.runPromise(Deferred.make<void>());
    const interruptionStarted = await Effect.runPromise(Deferred.make<void>());
    const interruptionDone = await Effect.runPromise(Deferred.make<void>());
    let finishCalls = 0;
    let terminal: RunTerminal | undefined;
    const store: AutomationRunStore = {
      ...automationRunStore,
      finish: (profilePath, runId, nextTerminal, targets) => {
        finishCalls += 1;
        terminal = nextTerminal;
        return Deferred.succeed(finishEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFinish)),
          Effect.andThen(automationRunStore.finish(profilePath, runId, nextTerminal, targets)),
        );
      },
    };
    const runFiber = Effect.runFork(
      harness(events, { store }).run(target, "daily-note", { kind: "manual-force" }),
    );
    await Effect.runPromise(Deferred.await(finishEntered));
    const interruptFiber = Effect.runFork(
      Deferred.succeed(interruptionStarted, undefined).pipe(
        Effect.andThen(Fiber.interrupt(runFiber)),
        Effect.ensuring(Deferred.succeed(interruptionDone, undefined)),
      ),
    );
    await Effect.runPromise(Deferred.await(interruptionStarted));
    await Effect.runPromise(Effect.yieldNow);
    const completedBeforeRelease = Option.isSome(
      await Effect.runPromise(Deferred.poll(interruptionDone)),
    );
    await Effect.runPromise(Deferred.succeed(releaseFinish, undefined));
    await Effect.runPromise(Fiber.join(interruptFiber));

    expect(completedBeforeRelease).toBe(false);
    expect(finishCalls).toBe(1);
    expect(terminal).toEqual({
      state: "completed",
      atMs: 1_000,
      localCompleted: true,
      failureCategory: null,
      gateExitCode: null,
    });
    expect((await Effect.runPromise(readAutomationRuns(target.path)))[0]).toMatchObject({
      state: "completed",
      localCompleted: true,
      failureCategory: null,
      finishedAtMs: 1_000,
    });
  });

  test("continues success, failure, success with complete ordered outcomes", async () => {
    const events: Array<string> = [];
    const target = await profile("discord:channel:1,telegram:chat:2,slack:channel:C0123ABCDE");
    const apiFailure = new TelegramApiError({
      operation: "sendMessage",
      reason: "rate-limited",
      retriable: true,
      status: 429,
      message: "failed",
      cause: "fixture",
    });
    expect(await run(harness(events, { telegramFailure: apiFailure }), target)).toEqual({
      kind: "executed",
      delivery: {
        kind: "resolved",
        targets: [
          { target: "discord:channel:1", status: "delivered" },
          {
            target: "telegram:chat:2",
            status: "failed",
            category: "rate-limited",
            retriable: true,
          },
          { target: "slack:channel:C0123ABCDE", status: "delivered" },
        ],
      },
    });
    expect(events.filter((event) => event.startsWith("send:"))).toEqual([
      "send:discord:1:local reply",
      "send:telegram:2:local reply",
      "send:slack:C0123ABCDE:-:local reply",
    ]);
    const persisted = (await Effect.runPromise(readAutomationRuns(target.path)))[0];
    expect({
      state: persisted?.state,
      localCompleted: persisted?.localCompleted,
      targets: persisted?.targets,
    }).toEqual({
      state: "failed",
      localCompleted: true,
      targets: [
        {
          ordinal: 0,
          target: "discord:channel:1",
          status: "delivered",
          failureCategory: null,
          retriable: null,
        },
        {
          ordinal: 1,
          target: "telegram:chat:2",
          status: "failed",
          failureCategory: "rate-limited",
          retriable: true,
        },
        {
          ordinal: 2,
          target: "slack:channel:C0123ABCDE",
          status: "delivered",
          failureCategory: null,
          retriable: null,
        },
      ],
    });
  });
});
