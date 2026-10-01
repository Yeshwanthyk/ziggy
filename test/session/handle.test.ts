/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Deferred, Effect, Fiber } from "effect";
import { makeChatHandle } from "ziggy/session/handle";
import { makeSessionLeaseSet } from "ziggy/session/lease";
import { fakePiRuntime } from "../harness/pi-runtime";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const persisted = (profilePath: string, id: string): SessionManager => {
  const manager = SessionManager.create(profilePath, join(profilePath, "sessions", "ui"), { id });
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  return manager;
};

test("a prompt during a resume waits, and starts after the transcript reset", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-handle-resume-"));
  roots.push(profilePath);
  const current = persisted(profilePath, "current");
  persisted(profilePath, "target");
  const { promise: switched, resolve: finishSwitch } = Promise.withResolvers<void>();
  const order: string[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();

      const handle = yield* makeChatHandle({
        profilePath,
        leases: makeSessionLeaseSet(profilePath),
        runtime: {
          ...fakePiRuntime({
            sessionManager: current,
            prompt: () => {
              order.push("prompt");

              return Promise.resolve();
            },
          }),
          switchSession: async () => {
            Deferred.doneUnsafe(entered, Effect.void);
            await switched;

            return { cancelled: false };
          },
        },
      });

      handle.subscribe((event) => order.push(event.kind));
      const resume = yield* handle.resume("target").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const prompt = yield* handle.prompt("after the switch").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(order).toEqual([]);

      finishSwitch();
      expect(yield* Fiber.join(resume)).toEqual({ cancelled: false });
      yield* Fiber.join(prompt);
      expect(order.slice(0, 2)).toEqual(["session-state", "prompt"]);
      yield* handle.dispose;
    }),
  );
});

test("disposal waits for an automation append, so the lease outlives the write", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-handle-dispose-"));
  roots.push(profilePath);
  const manager = persisted(profilePath, "live");
  const { promise: written, resolve: finishWrite } = Promise.withResolvers<void>();
  let disposed = false;

  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();

      const handle = yield* makeChatHandle({
        profilePath,
        leases: makeSessionLeaseSet(profilePath),
        runtime: {
          ...fakePiRuntime({
            sessionManager: manager,
            sendCustomMessage: async (message) => {
              Deferred.doneUnsafe(entered, Effect.void);
              await written;
              manager.appendCustomMessageEntry(
                message.customType,
                message.content,
                message.display,
                message.details,
              );
            },
          }),
          dispose: () => {
            disposed = true;

            return Promise.resolve();
          },
        },
      });

      const append = yield* handle
        .appendAutomationResult({
          automationId: "daily-note",
          runId: "manual:dispose",
          targetSessionId: "live",
          text: "result",
          timestamp: "2026-09-30T12:00:00.000Z",
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      const dispose = yield* handle.dispose.pipe(Effect.forkChild);
      yield* Effect.sleep("20 millis");
      expect(disposed).toBe(false);

      finishWrite();
      expect(yield* Fiber.join(append)).toBe(true);
      yield* Fiber.join(dispose);
      expect(disposed).toBe(true);
    }),
  );
});

test("steering and follow-up preserve image blocks at the Pi callback boundary", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-handle-images-"));
  roots.push(profilePath);
  const manager = persisted(profilePath, "images");
  const images = [{ type: "image", data: "fixture", mimeType: "image/png" }] as const;

  const calls: Array<{
    operation: string;
    text: string;
    images: ReadonlyArray<import("ziggy/session/index").ChatPromptImage> | undefined;
  }> = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* makeChatHandle({
        profilePath,
        leases: makeSessionLeaseSet(profilePath),
        runtime: fakePiRuntime({
          sessionManager: manager,
          isIdle: false,
          steer: (text, images) => {
            calls.push({ operation: "steer", text, images });

            return Promise.resolve("queued" as const);
          },
          followUp: (text, images) => {
            calls.push({ operation: "followUp", text, images });

            return Promise.resolve("queued" as const);
          },
        }),
      });

      yield* handle.steer("", [...images]);
      yield* handle.followUp("look", [...images]);
      expect(calls).toEqual([
        { operation: "steer", text: "", images },
        { operation: "followUp", text: "look", images },
      ]);
      yield* handle.dispose;
    }),
  );
});
