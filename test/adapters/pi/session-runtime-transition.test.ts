/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSessionEvent,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { makeLiveChatControls, makeSessionChatHandle } from "ziggy/adapters/pi/pi-agent";
import { bindChatRuntime } from "ziggy/adapters/pi/chat-runtime-binding";
import { profileResourceLoaderOptions } from "ziggy/adapters/pi/profile-resource-loader";
import { acquireSessionLease, makeSessionLeaseTransitions } from "ziggy/adapters/pi/session-lease";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("Pi command wrappers transfer leases and preserve the old owner on a pre-teardown error", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-pi-transitions-"));
  roots.push(profilePath);

  const directory = join(profilePath, "sessions");
  const source = SessionManager.create(profilePath, directory, { id: "source" });
  const target = SessionManager.create(profilePath, directory, { id: "target" });
  target.appendMessage({ role: "user", content: "materialize", timestamp: Date.now() });
  await Bun.write(
    join(directory, "third.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "third", cwd: profilePath, timestamp: new Date().toISOString() })}\n`,
  );
  target.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "ready" }],
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

  const targetFile = target.getSessionFile();

  if (targetFile === undefined) throw new Error("target transcript missing");

  const release = await Effect.runPromise(acquireSessionLease(profilePath, "source"));

  const lease = makeSessionLeaseTransitions(profilePath, "source", release);

  const subscriptions = new Map<string, Set<(event: AgentSessionEvent) => void>>();

  let actions:
    | NonNullable<
        Parameters<AgentSessionRuntime["session"]["bindExtensions"]>[0]["commandContextActions"]
      >
    | undefined;

  let rejectTargetBind = false;

  const createRuntime: Parameters<typeof createAgentSessionRuntime>[0] = async ({
    cwd,
    agentDir,
    sessionManager,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: profileResourceLoaderOptions(
        "Profile",
        {
          extensionPaths: [],
          skillPaths: [],
          extensionFactories: [],
        },
        [],
      ),
    });

    const result = await createAgentSessionFromServices({ services, sessionManager });

    const listeners = new Set<(event: AgentSessionEvent) => void>();
    subscriptions.set(sessionManager.getSessionId(), listeners);
    const subscribe = result.session.subscribe.bind(result.session);

    result.session.subscribe = (listener) => {
      listeners.add(listener);
      const unsubscribe = subscribe(listener);

      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    };

    const bind = result.session.bindExtensions.bind(result.session);

    result.session.bindExtensions = async (bindings) => {
      if (rejectTargetBind && sessionManager.getSessionId() === "target")
        throw new Error("target bind failed");

      actions = bindings.commandContextActions;
      await bind(bindings);
    };

    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: profilePath,
    agentDir: profilePath,
    sessionManager: source,
  });

  try {
    const binding = await bindChatRuntime(runtime, lease);
    const controls = makeLiveChatControls(profilePath, runtime, lease, binding);

    const handle = makeSessionChatHandle(
      profilePath,
      () => runtime.session,
      { ...controls, prompt: () => Effect.succeed(""), dispose: Effect.void },
      undefined,
      undefined,
      lease,
      binding,
    );

    const events: Array<string> = [];

    const unsubscribe = handle.subscribe((event) => events.push(event.kind));

    const emitTool = (id: string) => {
      for (const listener of subscriptions.get(id) ?? []) {
        listener({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: {} });
      }
    };

    emitTool("source");
    expect(events).toEqual(["tool"]);
    expect((await Effect.runPromise(controls.modelState)).thinking).toBe(
      runtime.session.thinkingLevel,
    );
    expect((await Effect.runPromise(controls.setThinkingLevel("off"))).thinking).toBe("off");
    expect(
      await Effect.runPromise(Effect.result(controls.setModel("missing", "model"))),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderConfigError" },
    });

    for (const invalid of ["../x", join(profilePath, "sessions", "target.jsonl")]) {
      expect(await Effect.runPromise(Effect.result(controls.resume(invalid)))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SessionNotFound" },
      });
    }

    Object.defineProperty(runtime.session, "isIdle", { configurable: true, get: () => false });
    expect(await Effect.runPromise(Effect.result(controls.resume("target")))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SessionBusy" },
    });

    for (const change of [
      controls.setModel("missing", "model"),
      controls.setThinkingLevel("high"),
    ]) {
      expect(await Effect.runPromise(Effect.result(change))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SessionBusy" },
      });
    }

    expect(lease.owns("source")).toBe(true);
    emitTool("source");
    expect(events).toEqual(["tool", "tool"]);
    Reflect.deleteProperty(runtime.session, "isIdle");

    const before = actions;

    if (before === undefined) throw new Error("Pi command actions not bound");

    await expect(before.fork("invalid-entry-id")).rejects.toThrow("Invalid entry ID");
    expect(lease.owns("source")).toBe(true);

    const malformed = join(directory, "malformed.jsonl");
    await Bun.write(
      malformed,
      `${JSON.stringify({ type: "session", version: 3, id: "malformed", cwd: join(profilePath, "missing-cwd"), timestamp: new Date().toISOString() })}\n`,
    );
    await expect(before.switchSession(malformed)).rejects.toThrow();
    expect(lease.owns("source")).toBe(true);
    expect(runtime.session.sessionManager.getSessionId()).toBe("source");
    await runtime.session.sendCustomMessage(
      { customType: "test", content: "current chat still writable", display: false },
      { triggerTurn: false },
    );
    expect(
      runtime.session.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom_message" && entry.content === "current chat still writable",
        ),
    ).toBe(true);
    expect(
      await Effect.runPromise(Effect.result(acquireSessionLease(profilePath, "source"))),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SessionLeaseHeld" },
    });

    const competingRelease = await Effect.runPromise(acquireSessionLease(profilePath, "target"));

    try {
      expect(await Effect.runPromise(Effect.result(controls.resume("target")))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SessionHeld" },
      });
      expect(lease.owns("source")).toBe(true);
    } finally {
      await Effect.runPromise(competingRelease);
    }

    expect(await Effect.runPromise(controls.resume("target"))).toEqual({ cancelled: false });
    expect(lease.owns("target")).toBe(true);
    emitTool("source");
    emitTool("target");
    expect(events).toEqual(["tool", "tool", "tool"]);

    const old = await Effect.runPromise(acquireSessionLease(profilePath, "source"));

    await Effect.runPromise(old);
    expect(
      await Effect.runPromise(Effect.result(acquireSessionLease(profilePath, "target"))),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SessionLeaseHeld" },
    });

    const after = actions;

    if (after === undefined) throw new Error("replacement command actions not bound");
    expect(await after.newSession()).toEqual({ cancelled: false });
    expect(lease.owns(runtime.session.sessionManager.getSessionId())).toBe(true);
    expect(lease.owns("target")).toBe(false);
    expect(await Effect.runPromise(controls.resume(relative(directory, targetFile)))).toEqual({
      cancelled: false,
    });
    expect(lease.owns("target")).toBe(true);
    emitTool("target");
    expect(events).toEqual(["tool", "tool", "tool", "tool"]);
    await Promise.all([
      Effect.runPromise(controls.resume("third")),
      Effect.runPromise(controls.resume("target")),
    ]);
    expect(lease.owns("target")).toBe(true);
    const thirdAfter = await Effect.runPromise(acquireSessionLease(profilePath, "third"));
    await Effect.runPromise(thirdAfter);

    let notified = 0;

    const removeFirst = binding.onRebind(() => {
      throw new Error("removed callback ran");
    });

    binding.onRebind(() => {
      notified += 1;
    });
    removeFirst();

    let enteredSwitch: () => void = () => undefined;
    let releaseSwitch: () => void = () => undefined;

    const entered = new Promise<void>((resolve) => {
      enteredSwitch = resolve;
    });

    const blocked = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });

    const originalSwitch = runtime.switchSession.bind(runtime);
    runtime.switchSession = async (file, options) => {
      enteredSwitch();
      await blocked;

      return originalSwitch(file, options);
    };

    const pending = Effect.runPromise(controls.resume("third"));
    await entered;

    try {
      expect(binding.isSwitching()).toBe(true);

      for (const operation of [handle.prompt("hello"), handle.steer("hi"), handle.followUp("hi")]) {
        expect(await Effect.runPromise(Effect.result(operation))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "SessionBusy" },
        });
      }

      const commands = actions;

      if (commands === undefined) throw new Error("Pi command actions not bound");
      await expect(commands.newSession()).rejects.toMatchObject({ _tag: "SessionBusy" });
      await expect(commands.fork("entry")).rejects.toMatchObject({ _tag: "SessionBusy" });
      await expect(commands.switchSession(targetFile)).rejects.toMatchObject({
        _tag: "SessionBusy",
      });
      expect(lease.owns("target")).toBe(true);
    } finally {
      releaseSwitch();
    }

    expect(await pending).toEqual({ cancelled: false });
    expect(binding.isSwitching()).toBe(false);
    expect(notified).toBe(1);
    expect(lease.owns("third")).toBe(true);
    emitTool("third");
    expect(events).toHaveLength(5);

    rejectTargetBind = true;
    expect(await Effect.runPromise(Effect.result(controls.resume("target")))).toMatchObject({
      _tag: "Failure",
    });
    emitTool("third");
    emitTool("target");
    expect(events).toHaveLength(6);

    unsubscribe();
    await Effect.runPromise(handle.dispose);
  } finally {
    await runtime.dispose();
    await Effect.runPromise(lease.close);
  }
});
