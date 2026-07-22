import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { ZIGGY_VERSION } from "../../packages/core/src/product-version.ts";
import { AttachOutcomeUnknownError } from "../../packages/ziggy/src/attach.ts";
import type { ExtensionClientRequest } from "../../packages/ziggy/src/cli-client.ts";
import {
  BunProcessManager,
  productionDependencies,
  runCli,
  runCliExecutable,
  type CliDependencies,
  type CliExecutableDependencies,
  type ServeRequest,
} from "../../packages/ziggy/src/cli.ts";
import { DaemonControlError, type DoctorReport } from "../../packages/ziggy/src/daemon.ts";
import {
  isVoiceName,
  type ProfileInitializationRequest,
  type ProfileInitializationResult,
} from "../../packages/ziggy/src/profile-initialization.ts";
import type {
  ServiceController,
  ServiceInput,
  ServiceStatus,
} from "../../packages/ziggy/src/service.ts";
import { runEffect } from "../testkit/effect.ts";

function dependencies(serve?: (request: ServeRequest) => Effect.Effect<void>): {
  readonly value: CliDependencies;
  readonly output: Array<string>;
  readonly listeners: Map<string, () => void>;
} {
  const output: Array<string> = [];
  const listeners = new Map<string, () => void>();
  return {
    output,
    listeners,
    value: {
      ...(serve === undefined ? {} : { serve }),
      cwd: Effect.succeed("/cwd"),
      output: (line) => Effect.sync(() => output.push(line)),
      onSignal: (signal, listener) => Effect.sync(() => listeners.set(signal, listener)),
      offSignal: (signal) => Effect.sync(() => listeners.delete(signal)),
    },
  };
}

test("--version does not require production service support", async () => {
  const fake = dependencies();
  await runEffect(runCli(["--version"], fake.value));
  expect(fake.output).toEqual([ZIGGY_VERSION]);
  const production = await runEffect(productionDependencies);
  expect(production.serve).toBeFunction();
  expect(production.doctor).toBeFunction();
});

test("runtime mode reflects whether service installation is safe", async () => {
  const fake = dependencies();
  await runEffect(runCli(["--runtime-mode"], fake.value));
  await runEffect(runCli(["--runtime-mode"], { ...fake.value, canInstallService: true }));
  expect(fake.output).toEqual(["source", "compiled"]);
  expect((await runEffect(productionDependencies)).canInstallService).toBeFalse();
});

test("ask and sessions list parse strict boundaries", async () => {
  const fake = dependencies();
  const asks: Array<{ readonly profilePath: string; readonly prompt: string }> = [];
  const lists: string[] = [];
  const tuis: string[] = [];
  const value: CliDependencies = {
    ...fake.value,
    ask: (profilePath, prompt) =>
      Effect.sync(() => {
        asks.push({ profilePath, prompt });
      }),
    sessionsList: (profilePath) =>
      Effect.sync(() => {
        lists.push(profilePath);
        return "[]";
      }),
    tui: (profilePath) => Effect.sync(() => tuis.push(profilePath)),
  };

  await runEffect(runCli(["ask", "hello"], value));
  await runEffect(runCli(["ask", "hello", "--profile", "/other"], value));
  await runEffect(runCli(["sessions", "list"], value));
  await runEffect(runCli(["sessions", "list", "--profile", "/other"], value));
  await runEffect(runCli(["tui"], value));
  await runEffect(runCli(["tui", "--profile", "/other"], value));

  expect(asks).toEqual([
    { profilePath: "/cwd", prompt: "hello" },
    { profilePath: "/other", prompt: "hello" },
  ]);
  expect(lists).toEqual(["/cwd", "/other"]);
  expect(tuis).toEqual(["/cwd", "/other"]);
  expect(fake.output).toEqual(["[]", "[]"]);

  for (const argv of [
    ["ask"],
    ["ask", ""],
    ["ask", "one", "two"],
    ["ask", "one", "--version"],
    ["ask", "one", "--profile", ""],
    ["ask", "--profile", "/other"],
    ["sessions"],
    ["sessions", "show"],
    ["sessions", "list", "extra"],
    ["sessions", "list", "--profile", "--bad"],
    ["tui", "extra"],
  ]) {
    await expect(runEffect(runCli(argv, value))).rejects.toThrow("usage");
  }
  expect(asks).toHaveLength(2);
  expect(lists).toHaveLength(2);
});

test("Extension commands submit exact intent and approvals without Profile writes", async () => {
  const fake = dependencies();
  const digest = "a".repeat(64);
  const requests: Array<{
    readonly profilePath: string;
    readonly request: ExtensionClientRequest;
  }> = [];
  const value: CliDependencies = {
    ...fake.value,
    extension: (profilePath, request) =>
      Effect.sync(() => {
        requests.push({ profilePath, request });
        return [];
      }),
  };

  await runEffect(
    runCli(
      [
        "extension",
        "install",
        "relative-source",
        "--approve",
        digest,
        "--verification-key",
        "key-1",
        "--signature",
        "signature-1",
        "--profile",
        "/profile",
      ],
      value,
    ),
  );
  await runEffect(runCli(["extension", "enable", "fixture", "--approve", digest], value));
  await runEffect(runCli(["extension", "disable", "fixture"], value));
  await runEffect(runCli(["extension", "list"], value));
  await runEffect(runCli(["extension", "doctor", "fixture", "--approve", digest], value));

  expect(requests).toEqual([
    {
      profilePath: "/profile",
      request: {
        action: "install",
        sourcePath: "/cwd/relative-source",
        approvals: [digest],
        verification: { keyId: "key-1", signature: "signature-1" },
      },
    },
    {
      profilePath: "/cwd",
      request: { action: "enable", extensionId: "fixture", approvals: [digest] },
    },
    { profilePath: "/cwd", request: { action: "disable", extensionId: "fixture" } },
    { profilePath: "/cwd", request: { action: "list" } },
    {
      profilePath: "/cwd",
      request: { action: "doctor", extensionId: "fixture", approval: digest },
    },
  ]);

  for (const argv of [
    ["extension"],
    ["extension", "install"],
    ["extension", "install", "/source", "--approve", "wrong"],
    ["extension", "install", "/source", "--approve", digest, "--approve", digest],
    ["extension", "install", "/source", "--verification-key", "key-only"],
    ["extension", "enable", "fixture", "--signature", "not-allowed"],
    ["extension", "disable", "fixture", "--approve", digest],
    ["extension", "doctor", "fixture", "--approve", digest, "--approve", "b".repeat(64)],
    ["extension", "list", "extra"],
  ]) {
    await expect(runEffect(runCli(argv, value))).rejects.toThrow("usage: ziggy extension");
  }
  expect(requests).toHaveLength(5);
  expect(fake.output).toEqual(["[]", "[]", "[]", "[]", "[]"]);
});

test("executable maps usage, known failure, unknown outcome, and local interrupt", async () => {
  const stderr: string[] = [];
  const exits: number[] = [];
  const fake = dependencies();
  type ExecutableError = AttachOutcomeUnknownError | DaemonControlError;
  const executable = (
    overrides: Partial<CliExecutableDependencies<ExecutableError>> = {},
  ): CliExecutableDependencies<ExecutableError> => ({
    ...fake.value,
    errorOutput: (value) => Effect.sync(() => stderr.push(value)),
    setExitCode: (code) => Effect.sync(() => exits.push(code)),
    ...overrides,
  });

  await runEffect(runCliExecutable(["ask"], executable({ ask: () => Effect.void })));
  await runEffect(
    runCliExecutable(
      ["ask", "known"],
      executable({
        ask: () =>
          Effect.fail(
            new DaemonControlError({ operation: "start", message: "fixture start failure" }),
          ),
      }),
    ),
  );
  await runEffect(
    runCliExecutable(
      ["ask", "unknown"],
      executable({
        ask: () => Effect.fail(new AttachOutcomeUnknownError({ sessionId: "main" })),
      }),
    ),
  );
  await runEffect(
    runCliExecutable(["ask", "interrupt"], executable({ ask: () => Effect.interrupt })),
  );

  expect(exits).toEqual([2, 1, 3, 130]);
  expect(stderr).toEqual([
    "usage: ziggy ask PROMPT [--profile PATH]\n",
    "Ziggy command failed.\n",
    "Turn outcome unknown; it may have been accepted. Do not retry automatically.\n",
    "Interrupted.\n",
  ]);
  expect(stderr.every((value) => value.length <= 513)).toBeTrue();
});

test("serve uses default and explicit Profile", async () => {
  const seen: Array<string> = [];
  const fake = dependencies((request) =>
    Effect.sync(() => {
      seen.push(request.profilePath);
    }),
  );
  await runEffect(runCli(["serve"], fake.value));
  await runEffect(runCli(["serve", "--profile", "/other"], fake.value));
  expect(seen).toEqual(["/cwd", "/other"]);
  expect(fake.listeners.size).toBe(0);
});

test("serve signal aborts and always cleans listeners", async () => {
  const started = await runEffect(Deferred.make<void>());
  let observed = false;
  const fake = dependencies((request) =>
    Deferred.succeed(started, undefined).pipe(
      Effect.andThen(
        Effect.callback<void>((resume) => {
          const onAbort = (): void => {
            observed = request.signal.aborted;
            resume(Effect.void);
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => request.signal.removeEventListener("abort", onAbort));
        }),
      ),
    ),
  );
  const running = runEffect(runCli(["serve"], fake.value));
  await runEffect(Deferred.await(started));
  fake.listeners.get("SIGTERM")?.();
  await running;
  expect(observed).toBeTrue();
  expect(fake.listeners.size).toBe(0);
});

test("missing serve composition fails at operation time", async () => {
  const fake = dependencies();
  await expect(runEffect(runCli(["serve"], fake.value))).rejects.toThrow("not available");
});

test("init strictly parses its optional path and Voice", async () => {
  const fake = dependencies();
  const requests: ProfileInitializationRequest[] = [];
  const init = (
    request: ProfileInitializationRequest,
  ): Effect.Effect<ProfileInitializationResult> =>
    Effect.sync(() => {
      requests.push(request);
      if (request.voice !== undefined && !isVoiceName(request.voice)) {
        return { schemaVersion: 1, profilePath: request.profilePath, voice: "clear", created: [] };
      }
      return {
        schemaVersion: 1,
        profilePath: request.profilePath,
        voice: request.voice ?? "clear",
        created: [],
      };
    });

  await runEffect(runCli(["init"], { ...fake.value, init }));
  await runEffect(runCli(["init", "/profile", "--voice", "warm"], { ...fake.value, init }));
  await runEffect(runCli(["init", "--voice", "operator", "/other"], { ...fake.value, init }));
  expect(requests).toEqual([
    { profilePath: "/cwd" },
    { profilePath: "/profile", voice: "warm" },
    { profilePath: "/other", voice: "operator" },
  ]);
  expect(fake.output).toHaveLength(3);

  for (const argv of [
    ["init", "/one", "/two"],
    ["init", "--voice"],
    ["init", "--voice", "warm", "--voice", "clear"],
    ["init", "--voice", "loud"],
    ["init", "--voice=warm"],
    ["init", "--unknown"],
  ]) {
    await expect(runEffect(runCli(argv, { ...fake.value, init }))).rejects.toThrow(
      "usage: ziggy init",
    );
  }
  expect(requests).toHaveLength(3);
});

test("auth login parses Provider, auth type, and Profile without exposing credential material", async () => {
  const fake = dependencies();
  const calls: Array<{
    readonly profilePath: string;
    readonly providerId: string;
    readonly type: string;
  }> = [];
  const authLogin: NonNullable<CliDependencies["authLogin"]> = (profilePath, providerId, type) =>
    Effect.sync(() => {
      calls.push({ profilePath, providerId, type });
      return { providerId, configured: true, type, source: "stored" };
    });
  await runEffect(runCli(["auth", "login", "anthropic"], { ...fake.value, authLogin }));
  await runEffect(
    runCli(["auth", "login", "openai-codex", "--type", "oauth", "--profile", "/other"], {
      ...fake.value,
      authLogin,
    }),
  );
  expect(calls).toEqual([
    { profilePath: "/cwd", providerId: "anthropic", type: "api_key" },
    { profilePath: "/other", providerId: "openai-codex", type: "oauth" },
  ]);
  expect(fake.output).toEqual([
    '{"providerId":"anthropic","configured":true,"type":"api_key","source":"stored"}',
    '{"providerId":"openai-codex","configured":true,"type":"oauth","source":"stored"}',
  ]);
  await expect(runEffect(runCli(["auth", "login"], { ...fake.value, authLogin }))).rejects.toThrow(
    "usage",
  );
});

test("doctor uses default and explicit Profile and emits its schema-stamped report", async () => {
  const fake = dependencies();
  const profiles: string[] = [];
  const report: DoctorReport = {
    schemaVersion: 1,
    profilePath: "/reported",
    healthy: true,
    checks: {
      daemon: { status: "ok", detail: "ready" },
      socket: { status: "ok", detail: "safe" },
      profileLock: { status: "ok", detail: "owned" },
      providerAuth: { status: "warning", detail: "not configured" },
    },
  };
  const value: CliDependencies = {
    ...fake.value,
    doctor: (profilePath) =>
      Effect.sync(() => {
        profiles.push(profilePath);
        return report;
      }),
  };
  await runEffect(runCli(["doctor"], value));
  await runEffect(runCli(["doctor", "--profile", "/other"], value));
  expect(profiles).toEqual(["/cwd", "/other"]);
  expect(fake.output).toEqual([JSON.stringify(report), JSON.stringify(report)]);
});

test("service install requires standalone composition rather than executable-name guessing", async () => {
  const fake = dependencies();
  const inputs: Array<ServiceInput> = [];
  const service = recordingService(inputs);
  const sourceDependencies = {
    ...fake.value,
    service,
    executable: "/renamed/bun-1.3.13",
    canInstallService: false,
  };
  await expect(runEffect(runCli(["service", "install"], sourceDependencies))).rejects.toThrow(
    "compiled Ziggy executable",
  );
  expect(inputs).toEqual([]);
  await runEffect(
    runCli(["service", "install", "--profile", "/profile"], {
      ...sourceDependencies,
      executable: "/opt/ziggy",
      canInstallService: true,
    }),
  );
  expect(inputs).toEqual([{ executable: "/opt/ziggy", profilePath: "/profile" }]);
  expect(fake.output).toHaveLength(1);
});

test("production process manager enforces a hard command deadline", async () => {
  await expect(
    runEffect(
      new BunProcessManager().run([process.execPath, "-e", "setInterval(() => {}, 1000)"], 20),
    ),
  ).rejects.toThrow("timed out after 20ms");
});

function recordingService(inputs: Array<ServiceInput>): ServiceController {
  const status: ServiceStatus = {
    definition: "current",
    registration: "registered",
    process: "running",
    enablement: "enabled",
    detail: {},
  };
  const record = (input: ServiceInput): Effect.Effect<ServiceStatus> =>
    Effect.sync(() => {
      inputs.push(input);
      return status;
    });
  return {
    identity: (input) =>
      Effect.succeed({
        profilePath: input.profilePath,
        hash: "hash",
        label: "label",
        definitionPath: "/definition",
        target: "target",
      }),
    classify: () => Effect.succeed("current"),
    install: record,
    start: record,
    stop: record,
    status: () => Effect.succeed(status),
    remove: () => Effect.succeed({ kind: "removed" }),
  };
}
