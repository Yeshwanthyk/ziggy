/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { appendStoredAutomationResult } from "ziggy/adapters/pi/automation-result";
import { readSessionHistory } from "ziggy/adapters/pi/session-history";
import { makeSessionChatHandle } from "ziggy/adapters/pi/pi-agent";
import { makeChatRegistry } from "ziggy/application/chat-registry";

const roots: string[] = [];

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const materialize = (manager: SessionManager): string => {
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "before" }],
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "ready" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const file = manager.getSessionFile();

  if (file === undefined) throw new Error("expected a persisted session file");

  return file;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("stored automation delivery persists one full-tree receipt and reloads through history", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-automation-result-"));
  roots.push(profilePath);

  const manager = SessionManager.create(profilePath, join(profilePath, "sessions", "ui"), {
    id: "pinned-session",
  });

  const file = materialize(manager);

  const result = {
    automationId: "daily-note",
    runId: "manual:one",
    targetSessionId: "pinned-session",
    text: "The durable result",
    timestamp: "2026-09-17T12:00:00.000Z",
  } as const;

  await Effect.runPromise(appendStoredAutomationResult(profilePath, result));
  const branched = SessionManager.open(file);

  const receipt = branched
    .getEntries()
    .find(
      (entry) => entry.type === "custom_message" && entry.customType === "ziggy.automation-result",
    );

  if (receipt?.parentId === null || receipt?.parentId === undefined) {
    throw new Error("expected automation receipt parent");
  }

  branched.branch(receipt.parentId);
  branched.appendCustomMessageEntry("fixture.branch", "alternate branch", true);
  await Effect.runPromise(appendStoredAutomationResult(profilePath, result));

  const source = await readFile(file, "utf8");
  expect(source.match(/"customType":"ziggy\.automation-result"/gu)).toHaveLength(1);

  const history = await Effect.runPromise(readSessionHistory(profilePath, "pinned-session"));
  expect(history.entries).toContainEqual({
    kind: "automation-result",
    automationId: "daily-note",
    runId: "manual:one",
    text: "Automation daily-note result (run manual:one):\nThe durable result",
    timestamp: expect.any(String),
  });
});

test("stored automation delivery reports a deleted destination without creating a transcript", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-automation-missing-"));
  roots.push(profilePath);

  const manager = SessionManager.create(profilePath, join(profilePath, "sessions"), {
    id: "deleted-session",
  });

  const file = materialize(manager);
  await rm(file);

  const failure = await Effect.runPromise(
    appendStoredAutomationResult(profilePath, {
      automationId: "daily-note",
      runId: "manual:missing",
      targetSessionId: "deleted-session",
      text: "result",
      timestamp: "2026-09-17T12:00:00.000Z",
    }).pipe(Effect.result),
  );

  expect(failure).toMatchObject({
    _tag: "Failure",
    failure: { category: "destination-missing", retriable: false },
  });
});

test("live idle delivery appends without prompting, publishes once, and busy delivery does not steer", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-automation-live-"));
  roots.push(profilePath);

  const manager = SessionManager.create(profilePath, join(profilePath, "sessions", "channel"), {
    id: "live-session",
  });

  const file = materialize(manager);
  let idle = true;
  let prompts = 0;
  let aborts = 0;
  let steers = 0;
  let followUps = 0;
  let customMessages = 0;
  const agentMemory: unknown[] = [];
  const deliveryOptions: unknown[] = [];
  const listeners = new Set<AgentSessionEventListener>();

  const handle = makeSessionChatHandle(
    profilePath,
    {
      get isIdle() {
        return idle;
      },
      sessionManager: manager,
      prompt: () => {
        prompts += 1;

        return Promise.resolve();
      },
      abort: () => {
        aborts += 1;

        return Promise.resolve();
      },
      steer: () => {
        steers += 1;

        return Promise.resolve();
      },
      followUp: () => {
        followUps += 1;

        return Promise.resolve();
      },
      sendCustomMessage: (message, options) => {
        customMessages += 1;
        agentMemory.push(message);
        deliveryOptions.push(options);
        manager.appendCustomMessageEntry(
          message.customType,
          message.content,
          message.display,
          message.details,
        );

        return Promise.resolve();
      },
      subscribe: (listener) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
    },
    {
      currentSession: Effect.succeed({ id: "live-session", file }),
      prompt: () =>
        Effect.sync(() => {
          prompts += 1;

          return "unused";
        }),
      dispose: Effect.void,
    },
  );

  const result = {
    automationId: "daily-note",
    runId: "manual:live",
    targetSessionId: "live-session",
    text: "live result",
    timestamp: "2026-09-17T12:00:00.000Z",
  } as const;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry(profilePath);
        yield* registry.registerAlias("discord/live", "discord", handle);
        const events: unknown[] = [];
        yield* registry.subscribe("discord/live", (event) => events.push(event));
        yield* registry.deliverAutomationResult({ name: "test", path: profilePath }, result);
        yield* registry.deliverAutomationResult({ name: "test", path: profilePath }, result);
        expect(events).toHaveLength(1);

        idle = false;
        expect(
          yield* Effect.result(
            registry.deliverAutomationResult(
              { name: "test", path: profilePath },
              { ...result, runId: "manual:busy" },
            ),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { category: "session-busy", retriable: true },
        });
      }),
    ),
  );

  expect(prompts).toBe(0);
  expect(aborts).toBe(0);
  expect(steers).toBe(0);
  expect(followUps).toBe(0);
  expect(customMessages).toBe(1);
  expect(deliveryOptions).toEqual([{ triggerTurn: false }]);
  expect(agentMemory).toMatchObject([
    {
      customType: "ziggy.automation-result",
      content: "Automation daily-note result (run manual:live):\nlive result",
      display: true,
    },
  ]);
  const persisted = SessionManager.open(file);
  expect(
    persisted
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom_message" && entry.customType === "ziggy.automation-result",
      ),
  ).toHaveLength(1);
});

test("a live append rejection never dedupes from memory and a reopened owner can retry", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-automation-poison-"));
  roots.push(profilePath);

  const manager = SessionManager.create(profilePath, join(profilePath, "sessions", "ui"), {
    id: "poison-session",
  });

  const file = materialize(manager);

  const result = {
    automationId: "daily-note",
    runId: "manual:poison",
    targetSessionId: "poison-session",
    text: "retry me",
    timestamp: "2026-09-17T12:00:00.000Z",
  } as const;

  const memoryOnly: unknown[] = [];
  let failedSends = 0;

  const failedHandle = makeSessionChatHandle(
    profilePath,
    {
      isIdle: true,
      sessionManager: manager,
      prompt: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      steer: () => Promise.resolve(),
      followUp: () => Promise.resolve(),
      sendCustomMessage: (message) => {
        failedSends += 1;
        memoryOnly.push(message);

        return Promise.reject(new Error("injected persistence failure"));
      },
      subscribe: () => () => undefined,
    },
    {
      currentSession: Effect.succeed({ id: "poison-session", file }),
      prompt: () => Effect.succeed("unused"),
      dispose: Effect.void,
    },
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry(profilePath);
        yield* registry.registerAlias("ui/poison", "slack", failedHandle);

        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(
            yield* Effect.result(
              registry.deliverAutomationResult({ name: "test", path: profilePath }, result),
            ),
          ).toMatchObject({
            _tag: "Failure",
            failure: { category: "write", retriable: true },
          });
        }

        expect(failedSends).toBe(1);
        expect(memoryOnly).toHaveLength(1);
        expect(
          SessionManager.open(file)
            .getEntries()
            .some(
              (entry) =>
                entry.type === "custom_message" && entry.customType === "ziggy.automation-result",
            ),
        ).toBe(false);

        yield* registry.closeAlias("ui/poison", failedHandle);
        const reopenedManager = SessionManager.open(file);

        const reopened = makeSessionChatHandle(
          profilePath,
          {
            isIdle: true,
            sessionManager: reopenedManager,
            prompt: () => Promise.resolve(),
            abort: () => Promise.resolve(),
            steer: () => Promise.resolve(),
            followUp: () => Promise.resolve(),
            sendCustomMessage: (message) => {
              reopenedManager.appendCustomMessageEntry(
                message.customType,
                message.content,
                message.display,
                message.details,
              );

              return Promise.resolve();
            },
            subscribe: () => () => undefined,
          },
          {
            currentSession: Effect.succeed({ id: "poison-session", file }),
            prompt: () => Effect.succeed("unused"),
            dispose: Effect.void,
          },
        );

        yield* registry.registerAlias("ui/poison", "slack", reopened);
        yield* registry.deliverAutomationResult({ name: "test", path: profilePath }, result);
      }),
    ),
  );

  expect(
    SessionManager.open(file)
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom_message" && entry.customType === "ziggy.automation-result",
      ),
  ).toHaveLength(1);
});
