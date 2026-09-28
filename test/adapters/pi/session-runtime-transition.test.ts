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
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { bindChatRuntime, makeLiveChatControls } from "ziggy/adapters/pi/pi-agent";
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

  let actions:
    | NonNullable<
        Parameters<AgentSessionRuntime["session"]["bindExtensions"]>[0]["commandContextActions"]
      >
    | undefined;

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

    const bind = result.session.bindExtensions.bind(result.session);

    result.session.bindExtensions = async (bindings) => {
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
    expect((await Effect.runPromise(controls.modelState)).thinking).toBe(
      runtime.session.thinkingLevel,
    );
    expect((await Effect.runPromise(controls.setThinkingLevel("off"))).thinking).toBe("off");
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
  } finally {
    await runtime.dispose();
    await Effect.runPromise(lease.close);
  }
});
