import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const schemaVersion = 1;
const markerPrefix = "ziggy-service-ownership:";

export type ServicePlatform = "darwin" | "linux";
export type DefinitionState = "absent" | "current" | "owned-drifted" | "foreign" | "unsupported";
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface ProcessManager {
  run(argv: ReadonlyArray<string>, timeoutMs: number): Promise<CommandResult>;
}
export interface Ownership {
  readonly schemaVersion: number;
  readonly platform: ServicePlatform;
  readonly profileHash: string;
  readonly identity: string;
}
export interface DefinitionExpectation {
  readonly content: string;
  readonly ownership: Ownership;
  readonly profilePath: string;
}
export interface ServiceFilesystem {
  canonicalize(path: string): Promise<string>;
  classify(path: string, expected: DefinitionExpectation): Promise<DefinitionState>;
  create(path: string, content: string): Promise<void>;
  replace(path: string, content: string, expected: DefinitionExpectation): Promise<void>;
  remove(path: string, expected: DefinitionExpectation): Promise<void>;
}
export interface ServiceControllerOptions {
  readonly platform: string;
  readonly home: string;
  readonly uid?: number;
  readonly xdgConfigHome?: string;
  readonly filesystem: ServiceFilesystem;
  readonly process: ProcessManager;
  readonly commandTimeoutMs?: number;
}
export interface ServiceInput {
  readonly profilePath: string;
  readonly executable: string;
}
export interface ServiceIdentity {
  readonly profilePath: string;
  readonly hash: string;
  readonly label: string;
  readonly definitionPath: string;
  readonly target: string;
}
export interface ServiceStatus {
  readonly definition: DefinitionState;
  readonly registration: "registered" | "unregistered" | "unknown";
  readonly process: "running" | "stopped" | "failed" | "unknown";
  readonly enablement: "enabled" | "disabled" | "unknown";
  readonly pid?: number;
  readonly detail: Readonly<Record<string, string>>;
}
export type ServiceRemoveResult =
  | { readonly kind: "removed" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "refused";
      readonly reason: "foreign" | "unsupported" | "ambiguous-registration";
    };
export interface ServiceController {
  identity(input: ServiceInput): Promise<ServiceIdentity>;
  classify(input: ServiceInput): Promise<DefinitionState>;
  install(input: ServiceInput): Promise<ServiceStatus>;
  start(input: ServiceInput): Promise<ServiceStatus>;
  stop(input: ServiceInput): Promise<ServiceStatus>;
  status(input: ServiceInput): Promise<ServiceStatus>;
  remove(input: ServiceInput): Promise<ServiceRemoveResult>;
}

export class NodeServiceFilesystem implements ServiceFilesystem {
  canonicalize(path: string): Promise<string> {
    return realpath(path);
  }
  async classify(path: string, expected: DefinitionExpectation): Promise<DefinitionState> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) return "foreign";
      const content = await readFile(path, "utf8");
      return classifyServiceDefinition(content, expected);
    } catch (error) {
      if (isCode(error, "ENOENT")) return "absent";
      throw error;
    }
  }
  async create(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
  }
  async replace(path: string, content: string, expected: DefinitionExpectation): Promise<void> {
    await this.requireOwned(path, expected);
    const temporary = `${path}.tmp-${crypto.randomUUID()}`;
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  async remove(path: string, expected: DefinitionExpectation): Promise<void> {
    await this.requireOwned(path, expected);
    await rm(path);
  }
  private async requireOwned(path: string, expected: DefinitionExpectation): Promise<void> {
    const state = await this.classify(path, expected);
    if (state !== "current" && state !== "owned-drifted")
      throw new Error(`service definition changed before mutation: ${state}`);
  }
}

interface Prepared {
  readonly identity: ServiceIdentity;
  readonly content: string;
  readonly ownership: Ownership;
  readonly state: DefinitionState;
}

export function createServiceController(options: ServiceControllerOptions): ServiceController {
  const platform = supported(options.platform);
  const timeout = options.commandTimeoutMs ?? 15_000;
  async function prepare(input: ServiceInput): Promise<Omit<Prepared, "state">> {
    validateAbsolute(input.executable, "executable");
    validateAbsolute(options.home, "home directory");
    rejectControls(input.executable);
    rejectControls(input.profilePath);
    const profilePath = await options.filesystem.canonicalize(input.profilePath);
    rejectControls(profilePath);
    const hash = createHash("sha256").update(profilePath).digest("hex");
    const label = `dev.ziggy.profile.${hash}`;
    const definitionPath =
      platform === "darwin"
        ? join(options.home, "Library", "LaunchAgents", `${label}.plist`)
        : join(configHome(options), "systemd", "user", `${label}.service`);
    const target =
      platform === "darwin" ? `gui/${requireUid(options.uid)}/${label}` : `${label}.service`;
    const identity = { profilePath, hash, label, definitionPath, target };
    const ownership = { schemaVersion, platform, profileHash: hash, identity: label };
    return {
      identity,
      ownership,
      content: definition(platform, identity, input.executable, ownership),
    };
  }
  async function classify(input: ServiceInput): Promise<Prepared> {
    const item = await prepare(input);
    return {
      ...item,
      state: await options.filesystem.classify(item.identity.definitionPath, {
        content: item.content,
        ownership: item.ownership,
        profilePath: item.identity.profilePath,
      }),
    };
  }
  async function run(
    argv: ReadonlyArray<string>,
    allowed: ReadonlyArray<number> = [0],
  ): Promise<CommandResult> {
    const result = await options.process.run(argv, timeout);
    if (!allowed.includes(result.exitCode))
      throw new Error(
        `service command failed (${result.exitCode}): ${argv.join(" ")}: ${result.stderr}`,
      );
    return result;
  }
  async function inspect(item: Prepared): Promise<ServiceStatus> {
    if (item.state === "foreign" || item.state === "unsupported") return unknownStatus(item.state);
    if (platform === "darwin") {
      const result = await run(["launchctl", "print", item.identity.target], [0, 3, 113]);
      const registered = result.exitCode === 0;
      return {
        definition: item.state,
        registration: registered ? "registered" : "unregistered",
        process: registered && /state = running/.test(result.stdout) ? "running" : "stopped",
        enablement: "unknown",
        detail: { output: result.stdout },
      };
    }
    const result = await run(
      [
        "systemctl",
        "--user",
        "show",
        item.identity.target,
        "--no-pager",
        "--property=LoadState",
        "--property=ActiveState",
        "--property=SubState",
        "--property=MainPID",
        "--property=Result",
        "--property=UnitFileState",
      ],
      [0],
    );
    const detail = parseProperties(result.stdout);
    const active = detail.ActiveState;
    return {
      definition: item.state,
      registration:
        detail.LoadState === "not-found"
          ? "unregistered"
          : detail.LoadState === "loaded"
            ? "registered"
            : "unknown",
      process:
        active === "active"
          ? "running"
          : active === "failed"
            ? "failed"
            : active === "inactive"
              ? "stopped"
              : "unknown",
      enablement:
        detail.UnitFileState === "enabled"
          ? "enabled"
          : detail.UnitFileState === "disabled"
            ? "disabled"
            : "unknown",
      pid: positive(detail.MainPID),
      detail,
    };
  }
  const controller: ServiceController = {
    identity: async (input) => (await prepare(input)).identity,
    classify: async (input) => (await classify(input)).state,
    status: async (input) => inspect(await classify(input)),
    install: async (input) => {
      const item = await classify(input);
      requireSafe(item.state);
      const before = await inspect(item);
      if (item.state === "absent" && before.registration !== "unregistered")
        throw new Error(
          `refusing install: ${item.identity.target} is registered without an owned definition`,
        );
      if (
        item.state === "current" &&
        before.process === "running" &&
        before.registration === "registered" &&
        (platform === "darwin" || before.enablement === "enabled")
      ) {
        if (platform === "darwin") await run(["launchctl", "enable", item.identity.target]);
        return before;
      }
      if (platform === "darwin") {
        if (item.state === "owned-drifted" && before.registration === "registered")
          await run(["launchctl", "bootout", item.identity.target]);
        if (item.state === "absent")
          await options.filesystem.create(item.identity.definitionPath, item.content);
        if (item.state === "owned-drifted")
          await options.filesystem.replace(item.identity.definitionPath, item.content, {
            content: item.content,
            ownership: item.ownership,
            profilePath: item.identity.profilePath,
          });
        await run(["launchctl", "enable", item.identity.target]);
        if (item.state === "owned-drifted" || before.registration !== "registered")
          await run([
            "launchctl",
            "bootstrap",
            `gui/${requireUid(options.uid)}`,
            item.identity.definitionPath,
          ]);
        else await run(["launchctl", "kickstart", item.identity.target]);
      } else {
        if (item.state === "absent")
          await options.filesystem.create(item.identity.definitionPath, item.content);
        if (item.state === "owned-drifted")
          await options.filesystem.replace(item.identity.definitionPath, item.content, {
            content: item.content,
            ownership: item.ownership,
            profilePath: item.identity.profilePath,
          });
        await run(["systemctl", "--user", "daemon-reload"]);
        await run(["systemctl", "--user", "enable", item.identity.target]);
        await run(["systemctl", "--user", "reset-failed", item.identity.target]);
        await run([
          "systemctl",
          "--user",
          item.state === "owned-drifted" ? "restart" : "start",
          item.identity.target,
        ]);
      }
      return inspect({ ...item, state: "current" });
    },
    start: async (input) => {
      const item = await classify(input);
      requireOwned(item.state);
      const before = await inspect(item);
      if (platform === "darwin") {
        await run(["launchctl", "enable", item.identity.target]);
        if (before.registration === "registered")
          await run(["launchctl", "kickstart", item.identity.target]);
        else
          await run([
            "launchctl",
            "bootstrap",
            `gui/${requireUid(options.uid)}`,
            item.identity.definitionPath,
          ]);
      } else {
        await run(["systemctl", "--user", "reset-failed", item.identity.target]);
        await run(["systemctl", "--user", "start", item.identity.target]);
      }
      return inspect(item);
    },
    stop: async (input) => {
      const item = await classify(input);
      requireOwned(item.state);
      if (platform === "darwin")
        await run(["launchctl", "bootout", item.identity.target], [0, 3, 113]);
      else await run(["systemctl", "--user", "stop", item.identity.target]);
      return inspect(item);
    },
    remove: async (input) => {
      const item = await classify(input);
      if (item.state === "foreign" || item.state === "unsupported")
        return { kind: "refused", reason: item.state };
      const before = await inspect(item);
      if (item.state === "absent")
        return before.registration !== "unregistered"
          ? { kind: "refused", reason: "ambiguous-registration" }
          : { kind: "absent" };
      if (platform === "darwin")
        await run(["launchctl", "bootout", item.identity.target], [0, 3, 113]);
      else await run(["systemctl", "--user", "disable", "--now", item.identity.target]);
      const expected = {
        content: item.content,
        ownership: item.ownership,
        profilePath: item.identity.profilePath,
      };
      await options.filesystem.remove(item.identity.definitionPath, expected);
      if (platform === "linux") {
        await run(["systemctl", "--user", "daemon-reload"]);
      }
      return { kind: "removed" };
    },
  };
  return controller;
}

function definition(
  platform: ServicePlatform,
  identity: ServiceIdentity,
  executable: string,
  ownership: Ownership,
): string {
  const marker = `${markerPrefix}${JSON.stringify(ownership)}`;
  const argv = [executable, "serve", "--profile", identity.profilePath];
  if (platform === "darwin")
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${marker} -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(identity.label)}</string><key>ProgramArguments</key><array>${argv.map((value) => `<string>${xml(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>\n`;
  return `# ${marker}\n[Unit]\nDescription=Ziggy Profile ${identity.hash}\n[Service]\nType=exec\nExecStart=${argv.map(systemdQuote).join(" ")}\nRestart=on-failure\nUMask=0077\n[Install]\nWantedBy=default.target\n`;
}
export function classifyServiceDefinition(
  content: string,
  expected: DefinitionExpectation,
): DefinitionState {
  const ownership = parseOwnership(content, expected.ownership.platform);
  if (ownership === undefined) return "foreign";
  if (ownership.schemaVersion !== schemaVersion) return "unsupported";
  if (
    ownership.platform !== expected.ownership.platform ||
    ownership.profileHash !== expected.ownership.profileHash ||
    ownership.identity !== expected.ownership.identity
  )
    return "foreign";
  if (content === expected.content) return "current";
  const normalized = normalizeExecutable(content, expected.ownership.platform);
  const normalizedExpected = normalizeExecutable(expected.content, expected.ownership.platform);
  return normalized !== undefined && normalized === normalizedExpected
    ? "owned-drifted"
    : "foreign";
}
function parseOwnership(content: string, platform: ServicePlatform): Ownership | undefined {
  const lines = content.split("\n");
  const markerLine = lines[platform === "darwin" ? 1 : 0];
  if (markerLine === undefined) return undefined;
  const prefix = platform === "darwin" ? `<!-- ${markerPrefix}` : `# ${markerPrefix}`;
  if (!markerLine.startsWith(prefix)) return undefined;
  const raw = markerLine.slice(prefix.length).replace(/\s*-->\s*$/, "");
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("schemaVersion" in value) ||
      !("platform" in value) ||
      !("profileHash" in value) ||
      !("identity" in value)
    )
      return undefined;
    const version = value.schemaVersion;
    const platform = value.platform;
    const profileHash = value.profileHash;
    const identity = value.identity;
    if (
      typeof version !== "number" ||
      (platform !== "darwin" && platform !== "linux") ||
      typeof profileHash !== "string" ||
      typeof identity !== "string"
    )
      return undefined;
    return { schemaVersion: version, platform, profileHash, identity };
  } catch {
    return undefined;
  }
}
function normalizeExecutable(content: string, platform: ServicePlatform): string | undefined {
  const startToken = platform === "darwin" ? "<array><string>" : "ExecStart=";
  const endToken = platform === "darwin" ? "</string><string>serve</string>" : ' "serve"';
  const start = content.indexOf(startToken);
  if (start < 0) return undefined;
  const executableStart = start + startToken.length;
  const end = content.indexOf(endToken, executableStart);
  if (end < 0) return undefined;
  const encoded = content.slice(executableStart, end);
  const executable =
    platform === "darwin" ? decodeCanonicalXml(encoded) : decodeCanonicalSystemd(encoded);
  if (executable === undefined || !executable.startsWith("/")) return undefined;
  try {
    rejectControls(executable);
  } catch {
    return undefined;
  }
  return `${content.slice(0, executableStart)}<executable>${content.slice(end)}`;
}
function decodeCanonicalXml(encoded: string): string | undefined {
  const decoded = encoded
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
  return xml(decoded) === encoded ? decoded : undefined;
}
function decodeCanonicalSystemd(encoded: string): string | undefined {
  if (!encoded.startsWith('"') || !encoded.endsWith('"')) return undefined;
  let decoded = "";
  const body = encoded.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === undefined) return undefined;
    if (character !== "\\" && character !== "%" && character !== "$" && character !== '"') {
      decoded += character;
      continue;
    }
    const next = body[index + 1];
    if (
      (character === "\\" && (next === "\\" || next === '"')) ||
      (character === "%" && next === "%") ||
      (character === "$" && next === "$")
    ) {
      decoded += character === "\\" ? next : character;
      index += 1;
      continue;
    }
    return undefined;
  }
  return systemdQuote(decoded) === encoded ? decoded : undefined;
}
function unknownStatus(definition: DefinitionState): ServiceStatus {
  return {
    definition,
    registration: "unknown",
    process: "unknown",
    enablement: "unknown",
    detail: {},
  };
}
function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function systemdQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")}"`;
}
function supported(value: string): ServicePlatform {
  if (value === "darwin" || value === "linux") return value;
  throw new Error(`unsupported service platform: ${value}`);
}
function configHome(options: ServiceControllerOptions): string {
  if (options.xdgConfigHome !== undefined) {
    validateAbsolute(options.xdgConfigHome, "XDG_CONFIG_HOME");
    return options.xdgConfigHome;
  }
  return join(options.home, ".config");
}
function requireUid(uid: number | undefined): number {
  if (uid === undefined) throw new Error("launchd requires a uid");
  return uid;
}
function validateAbsolute(value: string, label: string): void {
  if (!value.startsWith("/")) throw new Error(`${label} must be absolute`);
}
function rejectControls(value: string): void {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127)
      throw new Error("service launch paths contain control characters");
  }
}
function requireSafe(state: DefinitionState): void {
  if (state === "foreign" || state === "unsupported")
    throw new Error(`refusing ${state} service definition`);
}
function requireOwned(state: DefinitionState): void {
  if (state !== "current" && state !== "owned-drifted")
    throw new Error(`service definition is ${state}; refusing operation`);
}
function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function parseProperties(output: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}
function positive(value: string | undefined): number | undefined {
  const number = value === undefined ? 0 : Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}
