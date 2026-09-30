/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Deferred, Effect, Fiber } from "effect";
import { makeChatHandle } from "ziggy/session/handle";
import { makeSessionLeaseSet } from "ziggy/session/lease";
import type { ChatEvent } from "ziggy/session/types";
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

test("a prompt during a resume is refused, and the reset is published before the handle frees", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-handle-resume-"));
  roots.push(profilePath);
  const current = persisted(profilePath, "current");
  persisted(profilePath, "target");
  const { promise: switched, resolve: finishSwitch } = Promise.withResolvers<void>();
  const events: ChatEvent["kind"][] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();

      const handle = yield* makeChatHandle({
        profilePath,
        leases: makeSessionLeaseSet(profilePath),
        runtime: {
          ...fakePiRuntime({ sessionManager: current, prompt: () => Promise.resolve() }),
          switchSession: async () => {
            Deferred.doneUnsafe(entered, Effect.void);
            await switched;

            return { cancelled: false };
          },
        },
      });

      handle.subscribe((event) => events.push(event.kind));
      const resume = yield* handle.resume("target").pipe(Effect.forkChild);
      yield* Deferred.await(entered);

      expect(yield* Effect.result(handle.prompt("too early"))).toMatchObject({
        failure: { _tag: "SessionBusy" },
      });

      finishSwitch();
      expect(yield* Fiber.join(resume)).toEqual({ cancelled: false });
      expect(events).toEqual(["session-state"]);
      yield* handle.dispose;
    }),
  );
});
