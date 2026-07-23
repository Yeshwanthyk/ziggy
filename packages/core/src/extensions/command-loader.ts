import { dirname, join } from "node:path";
import type { JsonObject, JsonValue } from "@ziggy/protocol";
import { Effect, Schema } from "effect";
import type { SessionTool } from "../agent/runtime.ts";
import { SessionRuntimeError } from "../agent/runtime.ts";
import {
  readInstalledExtensionManifests,
  type InstalledExtensionManifestFile,
} from "../provider-node-adapter.ts";
import {
  decodeExtensionApprovalsJson,
  invalidatedExtensionApprovals,
  makeExtensionApprovalRequirement,
  type ExtensionApprovalRequirement,
  type ExtensionApprovals,
} from "./approvals.ts";
import {
  createExtensionCommandExecutionSnapshot,
  inspectApprovedExtensionExecutable,
  readInstalledExtensionFiles,
  removeExtensionCommandExecutionSnapshot,
  replaceExtensionAuthorityJson,
  runExtensionProcess,
  type InstalledExtensionFiles,
} from "./lifecycle-node-adapter.ts";
import {
  withExtensionLifecyclePermit,
  withExtensionPublicationPermit,
} from "./lifecycle-coordinator.ts";
import {
  decodeExtensionManifestJson,
  EXTENSION_COMMAND_MAX_ARGUMENT_BYTES,
  EXTENSION_COMMAND_MAX_ARGUMENTS,
  type ExtensionCommand,
  type ExtensionManifest,
} from "./manifest.ts";
import { decodeExtensionProvenanceJson, type ExtensionProvenance } from "./provenance.ts";
import { decodeUtf8Maybe } from "./skill-loader-node-adapter.ts";
import { validateExtensionPackageContent, validateExtensionSeal } from "./skill-loader.ts";
import { sha256 } from "./skill-loader.ts";
import { isZiggyVersionCompatible } from "./semver.ts";
import { decodeExtensionEnabledStateJson, type ExtensionEnabledState } from "./state.ts";

const CommandArgumentSchema = Schema.String.check(
  Schema.makeFilter((value) => !value.includes("\0"), {
    expected: "a process argument without NUL bytes",
  }),
);
const AppendInputSchema = Schema.Struct({
  args: Schema.Array(CommandArgumentSchema).check(
    Schema.isMaxLength(EXTENSION_COMMAND_MAX_ARGUMENTS),
  ),
});
const decodeAppendInput = Schema.decodeUnknownEffect(AppendInputSchema, {
  errors: "all",
  onExcessProperty: "error",
});
const utf8Encoder = new TextEncoder();

export class ExtensionCommandLoadError extends Schema.TaggedErrorClass<ExtensionCommandLoadError>()(
  "ExtensionCommandLoadError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export interface ExtensionCommandLoaderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly outputLimitBytes?: number;
  readonly beforeSpawn?: (
    point: ExtensionCommandInvocationCutPoint,
  ) => Effect.Effect<void, SessionRuntimeError>;
}

export interface ExtensionCommandInvocationCutPoint {
  readonly extensionId: string;
  readonly commandId: string;
}

interface InstalledCommandRecord {
  readonly files: InstalledExtensionFiles;
  readonly manifest: ExtensionManifest & { readonly schemaVersion: 2 };
  readonly provenance: ExtensionProvenance;
  readonly approvals: ExtensionApprovals & { readonly schemaVersion: 2 };
  readonly state: ExtensionEnabledState;
}

export function loadInstalledExtensionCommands(
  profilePath: string,
  runningZiggyVersion: string,
  options: ExtensionCommandLoaderOptions = {},
): Effect.Effect<ReadonlyArray<SessionTool>, ExtensionCommandLoadError> {
  return Effect.gen(function* () {
    const manifests = yield* withExtensionPublicationPermit(
      profilePath,
      Effect.tryPromise({
        try: () => readInstalledExtensionManifests(profilePath),
        catch: loadFailure("Failed to discover installed Extensions"),
      }),
    );
    const nested = yield* Effect.forEach(manifests, (file) =>
      withExtensionLifecyclePermit(
        profilePath,
        file.directoryName,
        loadExtensionCommands(profilePath, file, runningZiggyVersion, options),
      ),
    );
    const commands = nested.flat();
    const names = new Set(commands.map((command) => command.name));
    if (names.size !== commands.length || names.has("memory")) {
      return yield* loadFail(
        "Extension Command names must be unique and must not collide with memory",
      );
    }
    return commands;
  });
}

function loadExtensionCommands(
  profilePath: string,
  file: InstalledExtensionManifestFile,
  runningZiggyVersion: string,
  options: ExtensionCommandLoaderOptions,
): Effect.Effect<ReadonlyArray<SessionTool>, ExtensionCommandLoadError> {
  return Effect.gen(function* () {
    const manifestText = decodeUtf8Maybe(file.contents);
    if (manifestText === undefined) return yield* loadFail("Extension manifest is not valid UTF-8");
    const discovered = yield* decodeExtensionManifestJson(manifestText).pipe(
      Effect.mapError(loadFailure("Failed to decode installed Extension manifest")),
    );
    if (discovered.schemaVersion !== 2 || discovered.commands.length === 0) return [];
    if (file.directoryName !== discovered.id) {
      return yield* loadFail(
        `Extension directory basename must match manifest id ${discovered.id}`,
      );
    }
    const record = yield* readCommandRecord(profilePath, discovered.id).pipe(
      Effect.mapError(loadFailure(`Failed to load Extension Commands for ${discovered.id}`)),
    );
    if (!isZiggyVersionCompatible(record.manifest.ziggy.requires, runningZiggyVersion)) {
      return yield* loadFail(
        `Extension ${record.manifest.id} requires Ziggy ${record.manifest.ziggy.requires}; running ${runningZiggyVersion}`,
      );
    }
    if (!record.state.enabled) return [];
    yield* validateCommandRecord(profilePath, record).pipe(
      Effect.mapError(loadFailure(`Invalid Extension Command authority for ${record.manifest.id}`)),
    );
    return record.manifest.commands.map((command) =>
      commandTool(profilePath, runningZiggyVersion, record.manifest.id, command, options),
    );
  });
}

function commandTool(
  profilePath: string,
  runningZiggyVersion: string,
  extensionId: string,
  command: ExtensionCommand,
  options: ExtensionCommandLoaderOptions,
): SessionTool {
  return {
    name: command.id,
    description: command.description,
    inputSchema:
      command.argumentMode === "append"
        ? {
            type: "object",
            additionalProperties: false,
            required: ["args"],
            properties: {
              args: {
                type: "array",
                maxItems: EXTENSION_COMMAND_MAX_ARGUMENTS - command.argv.length,
                items: {
                  type: "string",
                  description: "Exact argv element; shell syntax is inert.",
                },
              },
            },
          }
        : { type: "object", additionalProperties: false, properties: {} },
    execute(input) {
      return decodeCommandArguments(command, input.input).pipe(
        Effect.flatMap((args) =>
          withExtensionLifecyclePermit(
            profilePath,
            extensionId,
            invokeCommand(
              profilePath,
              runningZiggyVersion,
              extensionId,
              command,
              args,
              input.signal,
              options,
            ),
          ),
        ),
      );
    },
  };
}

function decodeCommandArguments(
  command: ExtensionCommand,
  input: JsonObject,
): Effect.Effect<ReadonlyArray<string>, SessionRuntimeError> {
  if (command.argumentMode === "none") {
    return Object.keys(input).length === 0
      ? Effect.succeed([])
      : runtimeFail("Invalid Extension Command input");
  }
  const decoded = decodeAppendInput(input).pipe(Effect.map((value) => value.args));
  return decoded.pipe(
    Effect.mapError(
      (cause) => new SessionRuntimeError({ message: "Invalid Extension Command input", cause }),
    ),
    Effect.flatMap((args) => validateCombinedCommandArguments(command.argv, args)),
  );
}

function validateCombinedCommandArguments(
  fixed: ReadonlyArray<string>,
  appended: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, SessionRuntimeError> {
  if (fixed.length + appended.length > EXTENSION_COMMAND_MAX_ARGUMENTS) {
    return runtimeFail(
      `Extension Command arguments exceed ${EXTENSION_COMMAND_MAX_ARGUMENTS} total entries`,
    );
  }
  const byteLength = [...fixed, ...appended].reduce(
    (total, argument) => total + utf8Encoder.encode(argument).byteLength,
    0,
  );
  return byteLength <= EXTENSION_COMMAND_MAX_ARGUMENT_BYTES
    ? Effect.succeed(appended)
    : runtimeFail(
        `Extension Command arguments exceed ${EXTENSION_COMMAND_MAX_ARGUMENT_BYTES} aggregate UTF-8 bytes`,
      );
}

function invokeCommand(
  profilePath: string,
  runningZiggyVersion: string,
  extensionId: string,
  frozen: ExtensionCommand,
  args: ReadonlyArray<string>,
  signal: AbortSignal,
  options: ExtensionCommandLoaderOptions,
): Effect.Effect<JsonValue, SessionRuntimeError> {
  return Effect.gen(function* () {
    const record = yield* readCommandRecord(profilePath, extensionId);
    if (!isZiggyVersionCompatible(record.manifest.ziggy.requires, runningZiggyVersion)) {
      return yield* runtimeFail(`Extension ${extensionId} is incompatible with this Ziggy version`);
    }
    if (!record.state.enabled) return yield* runtimeFail(`Extension ${extensionId} is disabled`);
    yield* validateCommandRecord(profilePath, record);
    const live = record.manifest.commands.find((entry) => entry.id === frozen.id);
    if (live === undefined || !sameCommand(live, frozen)) {
      return yield* runtimeFail(`Extension Command ${extensionId}/${frozen.id} changed`);
    }
    const approval = record.approvals.approvals.find(
      (entry) => entry.entryKind === "command" && entry.entryId === live.id,
    );
    if (approval === undefined) {
      return yield* runtimeFail(
        `Exact approval is missing for Extension Command ${extensionId}/${live.id}`,
      );
    }
    const expectedPath = live.argv[0]?.includes("/")
      ? join(record.files.rootPath, live.argv[0] ?? "")
      : approval.executablePath;
    if (approval.executablePath !== expectedPath) {
      yield* invalidate(profilePath, record.approvals);
      return yield* runtimeFail(
        `Approved executable path is stale for Extension Command ${extensionId}/${live.id}`,
      );
    }
    const executable = yield* Effect.tryPromise({
      try: () => inspectApprovedExtensionExecutable(approval.executablePath),
      catch: runtimeFailure(`Failed to inspect approved executable for ${extensionId}/${live.id}`),
    }).pipe(
      Effect.catch((error) =>
        invalidate(profilePath, record.approvals).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    if (executable.sha256 !== approval.executableSha256) {
      yield* invalidate(profilePath, record.approvals);
      return yield* runtimeFail(
        `Approved executable changed for Extension Command ${extensionId}/${live.id}`,
      );
    }
    const environment = yield* commandEnvironment(record.manifest, options.environment);
    const result = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => createExtensionCommandExecutionSnapshot(extensionId, live.id, executable.bytes),
        catch: runtimeFailure(
          `Failed to materialize Extension Command snapshot ${extensionId}/${live.id}`,
        ),
      }),
      (snapshot) =>
        Effect.gen(function* () {
          if (options.beforeSpawn !== undefined) {
            yield* options.beforeSpawn({ extensionId, commandId: live.id });
          }
          return yield* Effect.tryPromise({
            try: () =>
              runExtensionProcess({
                executablePath: snapshot.executablePath,
                argv: [...live.argv, ...args],
                cwd:
                  live.cwd === "extension"
                    ? record.files.rootPath
                    : dirname(dirname(record.files.rootPath)),
                environment,
                timeoutMs: live.timeoutMs,
                outputLimitBytes: options.outputLimitBytes ?? 64 * 1024,
                signal,
              }),
            catch: runtimeFailure(`Extension Command ${extensionId}/${live.id} execution failed`),
          });
        }),
      (snapshot) =>
        Effect.tryPromise({
          try: () => removeExtensionCommandExecutionSnapshot(snapshot.rootPath),
          catch: runtimeFailure(
            `Failed to remove Extension Command snapshot ${extensionId}/${live.id}`,
          ),
        }),
    );
    return {
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  });
}

function readCommandRecord(
  profilePath: string,
  extensionId: string,
): Effect.Effect<InstalledCommandRecord, SessionRuntimeError> {
  return Effect.gen(function* () {
    const files = yield* Effect.tryPromise({
      try: () => readInstalledExtensionFiles(profilePath, extensionId),
      catch: runtimeFailure(`Failed to read Extension ${extensionId}`),
    });
    if (files === undefined) return yield* runtimeFail(`Extension ${extensionId} is not installed`);
    const manifestFile = files.tree.files.find((entry) => entry.path === "extension.json");
    const manifestText =
      manifestFile === undefined ? undefined : decodeUtf8Maybe(manifestFile.bytes);
    if (manifestText === undefined) return yield* runtimeFail("Missing valid extension.json");
    const manifest = yield* decodeExtensionManifestJson(manifestText).pipe(
      Effect.mapError(runtimeFailure("Invalid Extension manifest")),
    );
    if (manifest.schemaVersion !== 2) {
      return yield* runtimeFail(`Extension ${extensionId} does not declare Commands`);
    }
    const provenance = yield* decodeExtensionProvenanceJson(files.provenanceJson).pipe(
      Effect.mapError(runtimeFailure("Invalid Extension provenance")),
    );
    const approvals = yield* decodeExtensionApprovalsJson(files.approvalsJson).pipe(
      Effect.mapError(runtimeFailure("Invalid Extension approvals")),
    );
    if (approvals.schemaVersion !== 2) {
      return yield* runtimeFail("Extension manifest and approval schema versions differ");
    }
    const state = yield* decodeExtensionEnabledStateJson(files.stateJson).pipe(
      Effect.mapError(runtimeFailure("Invalid Extension enabled state")),
    );
    if (
      manifest.id !== extensionId ||
      provenance.extensionId !== extensionId ||
      approvals.extensionId !== extensionId ||
      state.extensionId !== extensionId
    ) {
      return yield* runtimeFail(`Extension authority identity mismatch for ${extensionId}`);
    }
    return { files, manifest, provenance, approvals, state };
  });
}

function validateCommandRecord(
  profilePath: string,
  record: InstalledCommandRecord,
): Effect.Effect<void, SessionRuntimeError> {
  if (
    record.manifest.id !== record.provenance.extensionId ||
    record.manifest.version !== record.provenance.extensionVersion ||
    record.manifest.id !== record.approvals.extensionId ||
    record.approvals.invalidated
  ) {
    return runtimeFail(`Extension authority identity mismatch for ${record.manifest.id}`);
  }
  const sealError = validateExtensionSeal(
    record.manifest,
    record.provenance,
    record.files.tree.files,
  );
  if (sealError !== undefined) {
    return invalidate(profilePath, record.approvals).pipe(
      Effect.andThen(runtimeFail(`${sealError}; reinstall is required`)),
    );
  }
  const packageValidation = validateExtensionPackageContent(record.manifest, record.files.tree);
  if (!packageValidation.valid) return runtimeFail(packageValidation.message);
  if (!completeApprovalSetMatches(record)) {
    return runtimeFail(`Exact approval authority is stale for Extension ${record.manifest.id}`);
  }
  return Effect.void;
}

function completeApprovalSetMatches(record: InstalledCommandRecord): boolean {
  const expectedKeys = new Set<string>();
  for (const tool of record.manifest.tools ?? []) expectedKeys.add(`tool\0${tool.id}`);
  for (const command of record.manifest.commands) expectedKeys.add(`command\0${command.id}`);
  for (const [index] of (record.manifest.setup?.steps ?? []).entries()) {
    expectedKeys.add(`setup\0${index}`);
  }
  if (record.manifest.setup?.doctor !== undefined) expectedKeys.add("doctor\0doctor");
  if (expectedKeys.size !== record.approvals.approvals.length) return false;
  return record.approvals.approvals.every((approval) => {
    const key = `${approval.entryKind}\0${approval.entryId}`;
    if (!expectedKeys.has(key)) return false;
    if (approval.entryKind === "command") {
      const command = record.manifest.commands.find((entry) => entry.id === approval.entryId);
      return command !== undefined && approvalMatches(record, command, approval);
    }
    const argv =
      approval.entryKind === "tool"
        ? []
        : approval.entryKind === "doctor"
          ? record.manifest.setup?.doctor?.argv
          : record.manifest.setup?.steps[Number(approval.entryId)]?.argv;
    if (argv === undefined) return false;
    const executablePath =
      approval.entryKind === "tool"
        ? join(record.files.rootPath, "tools", approval.entryId, "tool.ts")
        : approval.executablePath;
    const toolFile =
      approval.entryKind === "tool"
        ? record.files.tree.files.find((file) => file.path === `tools/${approval.entryId}/tool.ts`)
        : undefined;
    if (approval.entryKind === "tool" && toolFile === undefined) return false;
    const expected = makeExtensionApprovalRequirement({
      extensionId: record.manifest.id,
      extensionVersion: record.manifest.version,
      entryKind: approval.entryKind,
      entryId: approval.entryId,
      argv,
      permissions: record.manifest.permissions,
      executablePath,
      executableSha256: toolFile === undefined ? approval.executableSha256 : sha256(toolFile.bytes),
      trustTier: record.provenance.trustTier,
      treeDigest: record.provenance.treeDigest,
      epoch: record.approvals.epoch,
    });
    return expected.fingerprint === approval.fingerprint;
  });
}

function approvalMatches(
  record: InstalledCommandRecord,
  command: ExtensionCommand,
  approval: Extract<ExtensionApprovalRequirement, { readonly entryKind: "command" }>,
): boolean {
  const expected = makeExtensionApprovalRequirement({
    extensionId: record.manifest.id,
    extensionVersion: record.manifest.version,
    entryKind: "command",
    entryId: command.id,
    argv: command.argv,
    argumentMode: command.argumentMode,
    cwd: command.cwd,
    timeoutMs: command.timeoutMs,
    permissions: record.manifest.permissions,
    executablePath: approval.executablePath,
    executableSha256: approval.executableSha256,
    trustTier: record.provenance.trustTier,
    treeDigest: record.provenance.treeDigest,
    epoch: record.approvals.epoch,
  });
  return expected.fingerprint === approval.fingerprint;
}

function commandEnvironment(
  manifest: ExtensionManifest,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<Readonly<Record<string, string>>, SessionRuntimeError> {
  const environment: Record<string, string> = {};
  for (const name of manifest.requires.env) {
    const value = source[name];
    if (value === undefined)
      return runtimeFail(`Extension ${manifest.id} requires missing environment variable ${name}`);
    environment[name] = value;
  }
  return Effect.succeed(environment);
}

function invalidate(
  profilePath: string,
  approvals: ExtensionApprovals,
): Effect.Effect<void, SessionRuntimeError> {
  return Effect.tryPromise({
    try: () =>
      replaceExtensionAuthorityJson(
        profilePath,
        approvals.extensionId,
        "approvals.json",
        `${JSON.stringify(invalidatedExtensionApprovals(approvals), undefined, 2)}\n`,
      ),
    catch: runtimeFailure(`Failed to invalidate approvals for Extension ${approvals.extensionId}`),
  });
}

function sameCommand(left: ExtensionCommand, right: ExtensionCommand): boolean {
  return (
    left.id === right.id &&
    left.description === right.description &&
    left.argumentMode === right.argumentMode &&
    left.cwd === right.cwd &&
    left.timeoutMs === right.timeoutMs &&
    left.argv.length === right.argv.length &&
    left.argv.every((value, index) => value === right.argv[index])
  );
}

function loadFail(message: string): Effect.Effect<never, ExtensionCommandLoadError> {
  return Effect.fail(new ExtensionCommandLoadError({ message, cause: message }));
}

function loadFailure(message: string): (cause: unknown) => ExtensionCommandLoadError {
  return (cause) => new ExtensionCommandLoadError({ message, cause });
}

function runtimeFail(message: string): Effect.Effect<never, SessionRuntimeError> {
  return Effect.fail(new SessionRuntimeError({ message }));
}

function runtimeFailure(message: string): (cause: unknown) => SessionRuntimeError {
  return (cause) => new SessionRuntimeError({ message, cause });
}
