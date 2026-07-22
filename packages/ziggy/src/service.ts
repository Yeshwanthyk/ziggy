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
import { Effect, Result, Schema } from "effect";

const schemaVersion = 1;
const markerPrefix = "ziggy-service-ownership:";

export type ServicePlatform = "darwin" | "linux";
export type DefinitionState = "absent" | "current" | "owned-drifted" | "foreign" | "unsupported";
type DarwinOverrideDisposition = "absent" | "enabled" | "disabled" | "unknown";
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface ProcessManager {
  run(argv: ReadonlyArray<string>, timeoutMs: number): Effect.Effect<CommandResult, ServiceError>;
}
const OwnershipSchema = Schema.Struct({
  schemaVersion: Schema.Finite,
  platform: Schema.Literals(["darwin", "linux"]),
  profileHash: Schema.String,
  identity: Schema.String,
});
export type Ownership = typeof OwnershipSchema.Type;
const decodeOwnership = Schema.decodeUnknownResult(Schema.fromJsonString(OwnershipSchema));
export interface DefinitionExpectation {
  readonly content: string;
  readonly ownership: Ownership;
  readonly profilePath: string;
}
export interface ServiceFilesystem {
  canonicalize(path: string): Effect.Effect<string, ServiceError>;
  classify(
    path: string,
    expected: DefinitionExpectation,
  ): Effect.Effect<DefinitionState, ServiceError>;
  create(path: string, content: string): Effect.Effect<void, ServiceError>;
  replace(
    path: string,
    content: string,
    expected: DefinitionExpectation,
  ): Effect.Effect<void, ServiceError>;
  remove(path: string, expected: DefinitionExpectation): Effect.Effect<void, ServiceError>;
}
export interface ServiceControllerOptions {
  readonly platform: ServicePlatform;
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
  identity(input: ServiceInput): Effect.Effect<ServiceIdentity, ServiceControllerError>;
  classify(input: ServiceInput): Effect.Effect<DefinitionState, ServiceControllerError>;
  install(input: ServiceInput): Effect.Effect<ServiceStatus, ServiceControllerError>;
  start(input: ServiceInput): Effect.Effect<ServiceStatus, ServiceControllerError>;
  stop(input: ServiceInput): Effect.Effect<ServiceStatus, ServiceControllerError>;
  status(input: ServiceInput): Effect.Effect<ServiceStatus, ServiceControllerError>;
  remove(input: ServiceInput): Effect.Effect<ServiceRemoveResult, ServiceControllerError>;
}

export class ServiceError extends Schema.TaggedErrorClass<ServiceError>()("ServiceError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class ServiceConfigurationError extends Schema.TaggedErrorClass<ServiceConfigurationError>()(
  "ServiceConfigurationError",
  { field: Schema.String, message: Schema.String },
) {}

export type ServiceControllerError = ServiceConfigurationError | ServiceError;

export function decodeServicePlatform(
  value: string,
): Effect.Effect<ServicePlatform, ServiceConfigurationError> {
  return value === "darwin" || value === "linux"
    ? Effect.succeed(value)
    : Effect.fail(
        new ServiceConfigurationError({
          field: "platform",
          message: `unsupported service platform: ${value}`,
        }),
      );
}

export class NodeServiceFilesystem implements ServiceFilesystem {
  canonicalize(path: string): Effect.Effect<string, ServiceError> {
    return tryNodeService("canonicalize", path, () => realpath(path));
  }
  classify(
    path: string,
    expected: DefinitionExpectation,
  ): Effect.Effect<DefinitionState, ServiceError> {
    return Effect.gen(function* () {
      const info = yield* tryNodeService("inspect", path, () => lstat(path)).pipe(
        Effect.catch((error) =>
          isCode(error.cause, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
      if (info === undefined) return "absent";
      if (!info.isFile() || info.isSymbolicLink()) return "foreign";
      const content = yield* tryNodeService("read", path, () => readFile(path, "utf8"));
      return classifyServiceDefinition(content, expected);
    });
  }
  create(path: string, content: string): Effect.Effect<void, ServiceError> {
    return Effect.gen(function* () {
      yield* tryNodeService("create parent directory", dirname(path), () =>
        mkdir(dirname(path), { recursive: true, mode: 0o700 }),
      );
      yield* Effect.acquireUseRelease(
        tryNodeService("create", path, () =>
          open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600),
        ),
        (file) => tryNodeService("write", path, () => file.writeFile(content)),
        (file) => tryNodeService("close", path, () => file.close()),
      );
    });
  }
  replace(
    path: string,
    content: string,
    expected: DefinitionExpectation,
  ): Effect.Effect<void, ServiceError> {
    const verifyOwned = this.requireOwned(path, expected);
    return Effect.gen(function* () {
      yield* verifyOwned;
      const temporary = yield* Effect.try({
        try: () => `${path}.tmp-${crypto.randomUUID()}`,
        catch: (cause) =>
          new ServiceError({
            operation: "create temporary path",
            message: `failed to create temporary service definition path for ${path}`,
            cause,
          }),
      });
      yield* Effect.acquireUseRelease(
        tryNodeService("write temporary definition", temporary, () =>
          writeFile(temporary, content, { flag: "wx", mode: 0o600 }),
        ).pipe(Effect.as(temporary)),
        () =>
          tryNodeService("set permissions", temporary, () => chmod(temporary, 0o600)).pipe(
            Effect.andThen(tryNodeService("replace", path, () => rename(temporary, path))),
          ),
        () =>
          tryNodeService("remove temporary definition", temporary, () =>
            rm(temporary, { force: true }),
          ),
      );
    });
  }
  remove(path: string, expected: DefinitionExpectation): Effect.Effect<void, ServiceError> {
    return this.requireOwned(path, expected).pipe(
      Effect.andThen(tryNodeService("remove", path, () => rm(path))),
    );
  }
  private requireOwned(
    path: string,
    expected: DefinitionExpectation,
  ): Effect.Effect<void, ServiceError> {
    return this.classify(path, expected).pipe(
      Effect.flatMap((state) =>
        state === "current" || state === "owned-drifted"
          ? Effect.void
          : Effect.fail(
              new ServiceError({
                operation: "verify ownership",
                message: `service definition changed before mutation: ${state}`,
              }),
            ),
      ),
    );
  }
}

interface Prepared {
  readonly identity: ServiceIdentity;
  readonly content: string;
  readonly ownership: Ownership;
  readonly state: DefinitionState;
}

export function createServiceController(options: ServiceControllerOptions): ServiceController {
  const platform = options.platform;
  const timeout = options.commandTimeoutMs ?? 15_000;
  function prepare(
    input: ServiceInput,
  ): Effect.Effect<Omit<Prepared, "state">, ServiceControllerError> {
    return Effect.gen(function* () {
      yield* validateAbsolute(input.executable, "executable");
      yield* validateAbsolute(options.home, "home directory");
      yield* rejectControls(input.executable);
      yield* rejectControls(input.profilePath);
      const profilePath = yield* options.filesystem.canonicalize(input.profilePath);
      yield* rejectControls(profilePath);
      const hash = createHash("sha256").update(profilePath).digest("hex");
      const label = `dev.ziggy.profile.${hash}`;
      const definitionPath =
        platform === "darwin"
          ? join(options.home, "Library", "LaunchAgents", `${label}.plist`)
          : join(yield* configHome(options), "systemd", "user", `${label}.service`);
      const target =
        platform === "darwin"
          ? `gui/${yield* requireUid(options.uid)}/${label}`
          : `${label}.service`;
      const identity = { profilePath, hash, label, definitionPath, target };
      const ownership = { schemaVersion, platform, profileHash: hash, identity: label };
      return {
        identity,
        ownership,
        content: definition(platform, identity, input.executable, ownership),
      };
    });
  }
  function classify(input: ServiceInput): Effect.Effect<Prepared, ServiceControllerError> {
    return Effect.gen(function* () {
      const item = yield* prepare(input);
      const state = yield* options.filesystem.classify(item.identity.definitionPath, {
        content: item.content,
        ownership: item.ownership,
        profilePath: item.identity.profilePath,
      });
      return { ...item, state };
    });
  }
  function run(
    argv: ReadonlyArray<string>,
    allowed: ReadonlyArray<number> = [0],
  ): Effect.Effect<CommandResult, ServiceError> {
    return options.process.run(argv, timeout).pipe(
      Effect.flatMap((result) =>
        allowed.includes(result.exitCode)
          ? Effect.succeed(result)
          : Effect.fail(
              new ServiceError({
                operation: "run service command",
                message: `service command failed (${result.exitCode}): ${argv.join(" ")}: ${result.stderr}`,
              }),
            ),
      ),
    );
  }
  function inspect(item: Prepared): Effect.Effect<ServiceStatus, ServiceControllerError> {
    if (item.state === "foreign" || item.state === "unsupported") {
      return Effect.succeed(unknownStatus(item.state));
    }
    if (platform === "darwin") {
      return Effect.gen(function* () {
        const result = yield* run(["launchctl", "print", item.identity.target], [0, 3, 113]);
        const uid = yield* requireUid(options.uid);
        const overrideResult = yield* run(
          ["launchctl", "print-disabled", `gui/${uid}`],
          [0, 1, 3, 113],
        );
        const override = darwinOverrideDisposition(
          overrideResult.exitCode === 0 ? overrideResult.stdout : undefined,
          item.identity.label,
        );
        const registered = result.exitCode === 0;
        return {
          definition: item.state,
          registration: registered ? "registered" : "unregistered",
          process: registered && /state = running/.test(result.stdout) ? "running" : "stopped",
          enablement:
            override === "disabled" ? "disabled" : override === "enabled" ? "enabled" : "unknown",
          detail: { output: result.stdout, overrideDisposition: override },
        };
      });
    }
    return run(
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
    ).pipe(
      Effect.map((result) => {
        const detail = parseProperties(result.stdout);
        const active = detail.ActiveState;
        const pid = positive(detail.MainPID);
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
          ...(pid === undefined ? {} : { pid }),
          detail,
        };
      }),
    );
  }
  const controller: ServiceController = {
    identity: (input) => prepare(input).pipe(Effect.map((item) => item.identity)),
    classify: (input) => classify(input).pipe(Effect.map((item) => item.state)),
    status: (input) => classify(input).pipe(Effect.flatMap(inspect)),
    install: (input) =>
      Effect.gen(function* () {
        const item = yield* classify(input);
        yield* requireSafe(item.state);
        const before = yield* inspect(item);
        if (item.state === "absent" && before.registration !== "unregistered") {
          return yield* new ServiceError({
            operation: "install",
            message: `refusing install: ${item.identity.target} is registered without an owned definition`,
          });
        }
        if (
          item.state === "current" &&
          before.process === "running" &&
          before.registration === "registered" &&
          (platform === "darwin" || before.enablement === "enabled")
        ) {
          return before;
        }
        if (platform === "darwin") {
          yield* requireMutableDarwinOverride(before);
          if (item.state === "owned-drifted" && before.registration === "registered") {
            yield* run(["launchctl", "bootout", item.identity.target]);
          }
          if (item.state === "absent") {
            yield* options.filesystem.create(item.identity.definitionPath, item.content);
          }
          if (item.state === "owned-drifted") {
            yield* options.filesystem.replace(item.identity.definitionPath, item.content, {
              content: item.content,
              ownership: item.ownership,
              profilePath: item.identity.profilePath,
            });
          }
          if (item.state === "owned-drifted" || before.registration !== "registered") {
            const uid = yield* requireUid(options.uid);
            yield* run(["launchctl", "bootstrap", `gui/${uid}`, item.identity.definitionPath]);
          } else {
            yield* run(["launchctl", "kickstart", item.identity.target]);
          }
        } else {
          if (item.state === "absent") {
            yield* options.filesystem.create(item.identity.definitionPath, item.content);
          }
          if (item.state === "owned-drifted") {
            yield* options.filesystem.replace(item.identity.definitionPath, item.content, {
              content: item.content,
              ownership: item.ownership,
              profilePath: item.identity.profilePath,
            });
          }
          yield* run(["systemctl", "--user", "daemon-reload"]);
          yield* run(["systemctl", "--user", "enable", item.identity.target]);
          yield* run(["systemctl", "--user", "reset-failed", item.identity.target]);
          yield* run([
            "systemctl",
            "--user",
            item.state === "owned-drifted" ? "restart" : "start",
            item.identity.target,
          ]);
        }
        return yield* inspect({ ...item, state: "current" });
      }),
    start: (input) =>
      Effect.gen(function* () {
        const item = yield* classify(input);
        yield* requireOwned(item.state);
        const before = yield* inspect(item);
        if (platform === "darwin") {
          yield* requireMutableDarwinOverride(before);
          if (before.registration === "registered") {
            yield* run(["launchctl", "kickstart", item.identity.target]);
          } else {
            const uid = yield* requireUid(options.uid);
            yield* run(["launchctl", "bootstrap", `gui/${uid}`, item.identity.definitionPath]);
          }
        } else {
          yield* run(["systemctl", "--user", "reset-failed", item.identity.target]);
          yield* run(["systemctl", "--user", "start", item.identity.target]);
        }
        return yield* inspect(item);
      }),
    stop: (input) =>
      Effect.gen(function* () {
        const item = yield* classify(input);
        yield* requireOwned(item.state);
        if (platform === "darwin") {
          yield* run(["launchctl", "bootout", item.identity.target], [0, 3, 113]);
        } else {
          yield* run(["systemctl", "--user", "stop", item.identity.target]);
        }
        return yield* inspect(item);
      }),
    remove: (input) =>
      Effect.gen(function* () {
        const item = yield* classify(input);
        if (item.state === "foreign" || item.state === "unsupported") {
          return { kind: "refused", reason: item.state };
        }
        const before = yield* inspect(item);
        if (item.state === "absent") {
          return before.registration !== "unregistered"
            ? { kind: "refused", reason: "ambiguous-registration" }
            : { kind: "absent" };
        }
        if (platform === "darwin") {
          yield* requireKnownDarwinOverride(before);
          yield* run(["launchctl", "bootout", item.identity.target], [0, 3, 113]);
        } else {
          yield* run(["systemctl", "--user", "disable", "--now", item.identity.target]);
        }
        const expected = {
          content: item.content,
          ownership: item.ownership,
          profilePath: item.identity.profilePath,
        };
        yield* options.filesystem.remove(item.identity.definitionPath, expected);
        if (platform === "linux") {
          yield* run(["systemctl", "--user", "daemon-reload"]);
        }
        return { kind: "removed" };
      }),
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
  const decoded = decodeOwnership(raw);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
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
  if (hasControlCharacter(executable)) return undefined;
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
function configHome(
  options: ServiceControllerOptions,
): Effect.Effect<string, ServiceConfigurationError> {
  if (options.xdgConfigHome !== undefined) {
    return validateAbsolute(options.xdgConfigHome, "XDG_CONFIG_HOME").pipe(
      Effect.as(options.xdgConfigHome),
    );
  }
  return Effect.succeed(join(options.home, ".config"));
}
function requireUid(uid: number | undefined): Effect.Effect<number, ServiceConfigurationError> {
  return uid === undefined
    ? Effect.fail(
        new ServiceConfigurationError({ field: "uid", message: "launchd requires a uid" }),
      )
    : Effect.succeed(uid);
}
function validateAbsolute(
  value: string,
  label: string,
): Effect.Effect<void, ServiceConfigurationError> {
  return value.startsWith("/")
    ? Effect.void
    : Effect.fail(
        new ServiceConfigurationError({ field: label, message: `${label} must be absolute` }),
      );
}
function rejectControls(value: string): Effect.Effect<void, ServiceConfigurationError> {
  return hasControlCharacter(value)
    ? Effect.fail(
        new ServiceConfigurationError({
          field: "launch path",
          message: "service launch paths contain control characters",
        }),
      )
    : Effect.void;
}
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
function requireSafe(state: DefinitionState): Effect.Effect<void, ServiceError> {
  return state === "foreign" || state === "unsupported"
    ? Effect.fail(
        new ServiceError({
          operation: "verify ownership",
          message: `refusing ${state} service definition`,
        }),
      )
    : Effect.void;
}
function requireOwned(state: DefinitionState): Effect.Effect<void, ServiceError> {
  return state !== "current" && state !== "owned-drifted"
    ? Effect.fail(
        new ServiceError({
          operation: "verify ownership",
          message: `service definition is ${state}; refusing operation`,
        }),
      )
    : Effect.void;
}
function isCode(error: unknown, code: string): boolean {
  // oxlint-disable-next-line ziggy-effect/no-unknown-shape-probing -- boundary: Node system errors expose a stable code field.
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function darwinOverrideDisposition(
  output: string | undefined,
  label: string,
): DarwinOverrideDisposition {
  if (output === undefined) return "unknown";
  for (const line of output.split("\n")) {
    const match = /^\s*"?([^"\s]+)"?\s*=>\s*(true|false|enabled|disabled)\s*,?\s*$/.exec(line);
    if (match?.[1] !== label) continue;
    const value = match[2];
    return value === "true" || value === "disabled" ? "disabled" : "enabled";
  }
  return /disabled services\s*=\s*\{|^\s*\{/m.test(output) ? "absent" : "unknown";
}

function requireMutableDarwinOverride(status: ServiceStatus): Effect.Effect<void, ServiceError> {
  const disposition = status.detail.overrideDisposition;
  if (disposition === "disabled") {
    return Effect.fail(
      new ServiceError({
        operation: "verify launchd override",
        message: "refusing to mutate an explicitly disabled launchd service",
      }),
    );
  }
  if (disposition !== "absent" && disposition !== "enabled") {
    return Effect.fail(
      new ServiceError({
        operation: "verify launchd override",
        message: "refusing launchd mutation with unknown override state",
      }),
    );
  }
  return Effect.void;
}

function requireKnownDarwinOverride(status: ServiceStatus): Effect.Effect<void, ServiceError> {
  if (status.detail.overrideDisposition === "unknown") {
    return Effect.fail(
      new ServiceError({
        operation: "verify launchd override",
        message: "refusing launchd mutation with unknown override state",
      }),
    );
  }
  return Effect.void;
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

function tryNodeService<A>(
  operation: string,
  path: string,
  // oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- boundary: raw Node filesystem APIs are wrapped immediately below.
  run: () => Promise<A>,
): Effect.Effect<A, ServiceError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ServiceError({
        operation,
        message: `failed to ${operation} service definition at ${path}`,
        cause,
      }),
  });
}
