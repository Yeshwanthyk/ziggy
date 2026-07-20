import { expect, test } from "bun:test";
import {
  BunProcessManager,
  productionDependencies,
  runCli,
  type CliDependencies,
  type ServeRequest,
} from "../../packages/ziggy/src/cli.ts";
import type {
  ServiceController,
  ServiceInput,
  ServiceStatus,
} from "../../packages/ziggy/src/service.ts";

function dependencies(serve?: (request: ServeRequest) => Promise<void>): {
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
      serve,
      cwd: () => "/cwd",
      output: (line) => output.push(line),
      onSignal: (signal, listener) => listeners.set(signal, listener),
      offSignal: (signal) => listeners.delete(signal),
    },
  };
}
test("--version does not require production service support", async () => {
  const fake = dependencies();
  await runCli(["--version"], fake.value);
  expect(fake.output).toEqual(["0.0.0"]);
  expect(productionDependencies()).toBeDefined();
});
test("serve uses default and explicit Profile", async () => {
  const seen: Array<string> = [];
  const fake = dependencies((request) => {
    seen.push(request.profilePath);
    return Promise.resolve();
  });
  await runCli(["serve"], fake.value);
  await runCli(["serve", "--profile", "/other"], fake.value);
  expect(seen).toEqual(["/cwd", "/other"]);
  expect(fake.listeners.size).toBe(0);
});
test("serve signal aborts and always cleans listeners", async () => {
  let observed = false;
  const fake = dependencies(
    (request) =>
      new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => {
          observed = request.signal.aborted;
          resolve();
        }),
      ),
  );
  const running = runCli(["serve"], fake.value);
  fake.listeners.get("SIGTERM")?.();
  await running;
  expect(observed).toBeTrue();
  expect(fake.listeners.size).toBe(0);
});
test("production-unavailable serve fails at operation time", async () => {
  const fake = dependencies();
  await expect(runCli(["serve"], fake.value)).rejects.toThrow("not available");
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
  await expect(runCli(["service", "install"], sourceDependencies)).rejects.toThrow(
    "compiled Ziggy executable",
  );
  expect(inputs).toEqual([]);
  await runCli(["service", "install", "--profile", "/profile"], {
    ...sourceDependencies,
    executable: "/opt/ziggy",
    canInstallService: true,
  });
  expect(inputs).toEqual([{ executable: "/opt/ziggy", profilePath: "/profile" }]);
  expect(fake.output).toHaveLength(1);
});

test("production process manager enforces a hard command deadline", async () => {
  await expect(
    new BunProcessManager().run([process.execPath, "-e", "setInterval(() => {}, 1000)"], 20),
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
  const record = (input: ServiceInput): Promise<ServiceStatus> => {
    inputs.push(input);
    return Promise.resolve(status);
  };
  return {
    identity: (input) =>
      Promise.resolve({
        profilePath: input.profilePath,
        hash: "hash",
        label: "label",
        definitionPath: "/definition",
        target: "target",
      }),
    classify: () => Promise.resolve("current"),
    install: record,
    start: record,
    stop: record,
    status: () => Promise.resolve(status),
    remove: () => Promise.resolve({ kind: "removed" }),
  };
}
