/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: Bun tests drive real child processes through this adapter */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: host process/filesystem adapter translates failures into test failures */
/* oxlint-disable ziggy-effect/no-error-constructor -- boundary: host process/filesystem adapter reports test failures */
/* oxlint-disable ziggy-effect/no-unknown-shape-probing -- boundary: Node system errors expose stable code fields */
import { watch } from "node:fs";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";
import { decodeClientRequest, type ClientRequestFrame } from "../../packages/protocol/src/index.ts";
import { runEffect } from "./effect.ts";

const processTimeoutMs = 20_000;
const diagnosticLimit = 2_048;

const LockMetadataSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  pid: Schema.Int,
  ownerToken: Schema.String,
});
const decodeLockMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(LockMetadataSchema));

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunningProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal: NodeJS.Signals): void;
}

export async function compileCompiledCliFixture(
  executable: string,
  repositoryRoot: string,
): Promise<void> {
  const result = await runProcess(
    [
      "bun",
      "build",
      "--compile",
      "packages/ziggy/testkit/compiled-cli-entry.ts",
      "--outfile",
      executable,
    ],
    { cwd: repositoryRoot, timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`compiled Ziggy fixture build failed: ${bounded(result.stderr)}`);
  }
}

export function spawnProcess(
  argv: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): RunningProcess {
  return Bun.spawn([...argv], {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function collectProcess(
  child: RunningProcess,
  timeoutMs = processTimeoutMs,
): Promise<ProcessResult> {
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await withDeadline(child.exited, timeoutMs, `process ${child.pid} exit`, () =>
    child.kill("SIGKILL"),
  );
  return {
    exitCode,
    stdout: bounded(await stdout),
    stderr: bounded(await stderr),
  };
}

export async function runProcess(
  argv: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number },
): Promise<ProcessResult> {
  return collectProcess(spawnProcess(argv, options), options.timeoutMs);
}

async function stopDetachedDaemon(profilePath: string): Promise<void> {
  const lockPath = `${profilePath}/.runtime/daemon.lock`;
  const metadata = await runEffect(decodeLockMetadata(await readFile(lockPath, "utf8")));
  try {
    process.kill(metadata.pid, "SIGTERM");
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
  await waitForPathState(lockPath, false);
  await waitForPathState(`${profilePath}/.runtime/ziggy.sock`, false);
}

export async function cleanupDetachedDaemon(profilePath: string): Promise<void> {
  try {
    await stopDetachedDaemon(profilePath);
  } catch (error) {
    if (!isMissingPath(error) && !isMissingProcess(error)) throw error;
  }
}

export function awaitBarrier<A>(barrier: Promise<A>): Promise<A> {
  return withDeadline(barrier, processTimeoutMs, "controlled barrier");
}

export async function waitForPathState(path: string, exists: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const matches = async (): Promise<boolean> => (await pathExists(path)) === exists;
  if (await matches()) return;
  await withDeadline(
    new Promise<void>((resolve, reject) => {
      const watcher = watch(dirname(path), check);
      const finish = (): void => {
        watcher.close();
        resolve();
      };
      function check(): void {
        void matches().then((matched) => {
          if (matched) finish();
        }, reject);
      }
      watcher.once("error", reject);
      check();
    }),
    processTimeoutMs,
    `path state ${path}=${exists}`,
  );
}

export async function waitForFile(
  path: string,
  predicate: (contents: string) => boolean,
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const readMatch = async (): Promise<string | undefined> => {
    try {
      const contents = await readFile(path, "utf8");
      return predicate(contents) ? contents : undefined;
    } catch (error) {
      if (isMissingPath(error)) return undefined;
      throw error;
    }
  };
  const initial = await readMatch();
  if (initial !== undefined) return initial;
  return withDeadline(
    new Promise<string>((resolve, reject) => {
      const watcher = watch(dirname(path), check);
      function check(): void {
        void readMatch().then((contents) => {
          if (contents === undefined) return;
          watcher.close();
          resolve(contents);
        }, reject);
      }
      watcher.once("error", reject);
      check();
    }),
    processTimeoutMs,
    `file predicate ${path}`,
  );
}

export async function createStaleSocket(socketPath: string, repositoryRoot: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true });
  const script = `const net=require("node:net"),fs=require("node:fs");const s=net.createServer();s.listen(${JSON.stringify(socketPath)},()=>{fs.chmodSync(${JSON.stringify(socketPath)},0o600);console.log("ready")});setInterval(()=>{},1000);`;
  const child = spawnProcess([process.execPath, "-e", script], { cwd: repositoryRoot });
  const reader = child.stdout.getReader();
  const ready = reader.read().then((result) => {
    const value = result.value === undefined ? "" : new TextDecoder().decode(result.value);
    if (result.done || value.trim() !== "ready") {
      throw new Error("stale socket fixture did not become ready");
    }
  });
  await withDeadline(ready, processTimeoutMs, "stale socket readiness", () =>
    child.kill("SIGKILL"),
  );
  await reader.cancel();
  child.kill("SIGKILL");
  await withDeadline(child.exited, processTimeoutMs, "stale socket fixture exit");
  await chmod(socketPath, 0o600);
}

export interface ControlledAttachServer {
  readonly methods: ReadonlyArray<ClientRequestFrame["method"]>;
  readonly turnMessages: ReadonlyArray<string>;
  readonly closedConnections: Promise<number>;
  close(): Promise<void>;
}

export async function startOutcomeUnknownAttachServer(
  socketPath: string,
): Promise<ControlledAttachServer> {
  await mkdir(dirname(socketPath), { recursive: true });
  const methods: ClientRequestFrame["method"][] = [];
  const turnMessages: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  let closed = 0;
  let resolveClosed: ((value: number) => void) | undefined;
  const closedConnections = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const { createServer } = await import("node:net");
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString();
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const request = decodeClientRequest(buffered.slice(0, newline + 1));
        buffered = buffered.slice(newline + 1);
        methods.push(request.method);
        if (request.method === "turn/start") {
          turnMessages.push(request.params.message);
          socket.destroy();
          continue;
        }
        const result = attachResult(request);
        socket.write(
          `${JSON.stringify({
            schemaVersion: 2,
            requestId: request.requestId,
            method: request.method,
            type: "success",
            result,
          })}\n`,
        );
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      closed += 1;
      if (closed >= 2) resolveClosed?.(closed);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(socketPath);
  });
  await chmod(socketPath, 0o600);
  return {
    methods,
    turnMessages,
    closedConnections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function attachResult(request: Exclude<ClientRequestFrame, { readonly method: "turn/start" }>) {
  switch (request.method) {
    case "initialize":
      return { protocolVersion: 2, features: ["stableMainSession", "sessionReplay"] };
    case "session/ensure":
      return { session: { sessionId: "main", createdAt: "2026-07-21T00:00:00.000Z", lastSeq: 0 } };
    case "session/subscribe":
      return { subscriptionId: "compiled-process-subscription", replayThroughSeq: 0 };
    default:
      throw new Error(`unexpected controlled Attach method ${request.method}`);
  }
}

function bounded(value: string): string {
  return value.slice(0, diagnosticLimit);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function withDeadline<A>(
  operation: Promise<A>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
