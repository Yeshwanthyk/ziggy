import {
  NodeServiceFilesystem,
  createServiceController,
  type ProcessManager,
  type ServiceController,
  type ServiceInput,
} from "./service.ts";
import { runDoctor, serveDaemon, type DoctorReport } from "./daemon.ts";

export interface ServeRequest {
  readonly profilePath: string;
  readonly signal: AbortSignal;
}
export interface CliDependencies {
  readonly serve?: (request: ServeRequest) => Promise<void>;
  readonly doctor?: (profilePath: string) => Promise<DoctorReport>;
  readonly cwd: () => string;
  readonly onSignal: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly offSignal: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly service?: ServiceController;
  readonly executable?: string;
  readonly canInstallService?: boolean;
  readonly output: (value: string) => void;
}
export async function runCli(
  argv: ReadonlyArray<string>,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv.includes("--version")) {
    dependencies.output("0.0.0");
    return;
  }
  const command = argv[0];
  if (command === "serve") {
    if (dependencies.serve === undefined)
      throw new Error("foreground daemon composition is not available");
    const profilePath = profile(argv.slice(1), dependencies.cwd());
    const abort = new AbortController();
    const stop = () => abort.abort();
    dependencies.onSignal("SIGINT", stop);
    dependencies.onSignal("SIGTERM", stop);
    try {
      await dependencies.serve({ profilePath, signal: abort.signal });
    } finally {
      dependencies.offSignal("SIGINT", stop);
      dependencies.offSignal("SIGTERM", stop);
    }
    return;
  }
  if (command === "doctor") {
    if (dependencies.doctor === undefined) throw new Error("doctor composition is not available");
    const result = await dependencies.doctor(profile(argv.slice(1), dependencies.cwd()));
    dependencies.output(JSON.stringify(result));
    return;
  }
  if (command === "service") {
    const action = argv[1];
    if (!isAction(action))
      throw new Error("usage: ziggy service install|start|stop|status|remove [--profile PATH]");
    if (dependencies.service === undefined || dependencies.executable === undefined)
      throw new Error("service lifecycle composition is not available");
    if (action === "install" && dependencies.canInstallService !== true) {
      throw new Error("service install requires a compiled Ziggy executable, not Bun source mode");
    }
    const input: ServiceInput = {
      profilePath: profile(argv.slice(2), dependencies.cwd()),
      executable: dependencies.executable,
    };
    const result = await dependencies.service[action](input);
    dependencies.output(JSON.stringify(result));
    return;
  }
  throw new Error(
    "usage: ziggy serve [--profile PATH] | doctor [--profile PATH] | service install|start|stop|status|remove",
  );
}
function profile(argv: ReadonlyArray<string>, cwd: string) {
  if (argv.length === 0) return cwd;
  if (argv.length === 2 && argv[0] === "--profile" && argv[1] !== undefined) return argv[1];
  throw new Error("expected [--profile PATH]");
}
function isAction(
  value: string | undefined,
): value is "install" | "start" | "stop" | "status" | "remove" {
  return (
    value === "install" ||
    value === "start" ||
    value === "stop" ||
    value === "status" ||
    value === "remove"
  );
}

export class BunProcessManager implements ProcessManager {
  async run(argv: ReadonlyArray<string>, timeoutMs: number) {
    const child = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGKILL",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (timedOut) throw new Error(`service command timed out after ${timeoutMs}ms`);
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }
}
export function productionDependencies(): CliDependencies {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const base: CliDependencies = {
    serve: ({ profilePath, signal }) => serveDaemon({ profilePath, signal }),
    doctor: (profilePath) => runDoctor({ profilePath }),
    cwd: process.cwd,
    onSignal: (signal, listener) => process.on(signal, listener),
    offSignal: (signal, listener) => process.off(signal, listener),
    output: console.log,
    executable: productionExecutable(),
    canInstallService: "isStandaloneExecutable" in Bun && Bun.isStandaloneExecutable === true,
  };
  if (process.platform !== "darwin" && process.platform !== "linux") return base;
  return {
    ...base,
    service: createServiceController({
      platform: process.platform,
      home: process.env.HOME ?? "",
      uid,
      xdgConfigHome: process.env.XDG_CONFIG_HOME || undefined,
      filesystem: new NodeServiceFilesystem(),
      process: new BunProcessManager(),
    }),
  };
}
function productionExecutable() {
  return process.execPath;
}
