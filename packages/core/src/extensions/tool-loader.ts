import { join } from "node:path";
import type { JsonObject, JsonValue } from "@ziggy/protocol";
import { Effect, Schema, Scope } from "effect";
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
  type ExtensionApprovals,
} from "./approvals.ts";
import { replaceExtensionAuthorityJson } from "./lifecycle-node-adapter.ts";
import {
  withExtensionLifecyclePermit,
  withExtensionPublicationPermit,
} from "./lifecycle-coordinator.ts";
import { decodeExtensionManifestJson, type ExtensionManifest } from "./manifest.ts";
import { decodeExtensionProvenanceJson, type ExtensionProvenance } from "./provenance.ts";
import {
  decodeUtf8Maybe,
  readExtensionAuthorityFiles,
  readImmutableExtensionTree,
  type ExtensionFileSnapshot,
  type ExtensionTreeSnapshot,
} from "./skill-loader-node-adapter.ts";
import { sha256, validateExtensionPackageContent, validateExtensionSeal } from "./skill-loader.ts";
import { isZiggyVersionCompatible } from "./semver.ts";
import { decodeExtensionEnabledStateJson } from "./state.ts";
import {
  canonicalizeExtensionToolProfilePath,
  createExtensionToolExecutionSnapshot,
  importExtensionToolModule,
  inspectImportedExtensionToolModule,
  invokeExtensionTool,
  removeExtensionToolExecutionSnapshot,
  type ExtensionToolExecutionSnapshot,
} from "./tool-loader-node-adapter.ts";
import type { ExtensionToolContext, ExtensionToolDefinition } from "./tool.ts";

export class ExtensionToolLoadError extends Schema.TaggedErrorClass<ExtensionToolLoadError>()(
  "ExtensionToolLoadError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export interface ExtensionToolLoadCutPoint {
  readonly extensionId: string;
  readonly toolIds: ReadonlyArray<string>;
}

export interface ExtensionToolLoaderOptions {
  readonly beforeFinalLiveSealCheck?: (
    point: ExtensionToolLoadCutPoint,
  ) => Effect.Effect<void, ExtensionToolLoadError>;
  readonly beforeImport?: (
    point: ExtensionToolLoadCutPoint,
  ) => Effect.Effect<void, ExtensionToolLoadError>;
  readonly importModule?: (entryPath: string) => Effect.Effect<unknown, ExtensionToolLoadError>;
}

interface PreparedTool {
  readonly id: string;
  readonly snapshot: ExtensionToolExecutionSnapshot;
}

const ToolDefinitionSchema = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  description: Schema.String.check(Schema.isNonEmpty()),
  inputSchema: Schema.Unknown,
  execute: Schema.Unknown,
});
const decodeToolDefinition = Schema.decodeUnknownEffect(ToolDefinitionSchema, {
  errors: "all",
  onExcessProperty: "error",
});

export function loadInstalledExtensionTools(
  profilePath: string,
  runningZiggyVersion: string,
  options: ExtensionToolLoaderOptions = {},
): Effect.Effect<ReadonlyArray<SessionTool>, ExtensionToolLoadError, Scope.Scope> {
  return Effect.gen(function* () {
    const manifestFiles = yield* withExtensionPublicationPermit(
      profilePath,
      Effect.tryPromise({
        try: () => readInstalledExtensionManifests(profilePath),
        catch: toolLoadFailure("Failed to discover installed Extensions"),
      }),
    );
    const tools = yield* Effect.forEach(manifestFiles, (file) =>
      withExtensionLifecyclePermit(
        profilePath,
        file.directoryName,
        loadExtensionTools(profilePath, file, runningZiggyVersion, options),
      ),
    );
    const flattened = tools.flat();
    const names = new Set(flattened.map((tool) => tool.name));
    if (names.size !== flattened.length || names.has("memory")) {
      return yield* fail("Extension Tool names must be unique and must not collide with memory");
    }
    return flattened;
  });
}

function loadExtensionTools(
  profilePath: string,
  file: InstalledExtensionManifestFile,
  runningZiggyVersion: string,
  options: ExtensionToolLoaderOptions,
): Effect.Effect<ReadonlyArray<SessionTool>, ExtensionToolLoadError, Scope.Scope> {
  return Effect.gen(function* () {
    const manifestText = decodeUtf8Maybe(file.contents);
    if (manifestText === undefined) return yield* fail("Extension manifest is not valid UTF-8");
    const manifest = yield* decodeExtensionManifestJson(manifestText).pipe(
      Effect.mapError(toolLoadFailure("Failed to decode installed Extension manifest")),
    );
    if (file.directoryName !== manifest.id) {
      return yield* fail(`Extension directory basename must match manifest id ${manifest.id}`);
    }
    if (!isZiggyVersionCompatible(manifest.ziggy.requires, runningZiggyVersion)) {
      return yield* fail(
        `Extension ${manifest.id} requires Ziggy ${manifest.ziggy.requires}; running ${runningZiggyVersion}`,
      );
    }
    const authority = yield* Effect.tryPromise({
      try: () => readExtensionAuthorityFiles(profilePath, manifest.id),
      catch: toolLoadFailure(`Failed to read daemon-owned authority for Extension ${manifest.id}`),
    });
    const approvals = yield* decodeExtensionApprovalsJson(authority.approvalsJson).pipe(
      Effect.mapError(toolLoadFailure(`Failed to decode approvals for Extension ${manifest.id}`)),
    );
    const state = yield* decodeExtensionEnabledStateJson(authority.stateJson).pipe(
      Effect.mapError(
        toolLoadFailure(`Failed to decode enabled state for Extension ${manifest.id}`),
      ),
    );
    const provenance = yield* decodeExtensionProvenanceJson(authority.provenanceJson).pipe(
      Effect.mapError(toolLoadFailure(`Failed to decode provenance for Extension ${manifest.id}`)),
    );
    if (
      approvals.extensionId !== manifest.id ||
      state.extensionId !== manifest.id ||
      provenance.extensionId !== manifest.id ||
      provenance.extensionVersion !== manifest.version
    ) {
      return yield* fail(`Extension authority identity mismatch for Extension ${manifest.id}`);
    }
    if (approvals.invalidated) {
      return yield* fail(
        `Extension ${manifest.id} was invalidated by immutable mutation; reinstall is required`,
      );
    }
    if (!state.enabled || manifest.tools === undefined) return [];

    const tree = yield* Effect.tryPromise({
      try: () => readImmutableExtensionTree(file.rootPath),
      catch: toolLoadFailure(`Failed to read immutable tree for Extension ${manifest.id}`),
    });
    const sealError = validateExtensionSeal(manifest, provenance, tree.files);
    if (sealError !== undefined) {
      yield* invalidateApprovals(profilePath, approvals);
      return yield* fail(
        `${sealError}; Extension ${manifest.id} was invalidated and reinstall is required`,
      );
    }
    const sealedManifest = tree.files.find((entry) => entry.path === "extension.json");
    if (
      sealedManifest === undefined ||
      !Buffer.from(sealedManifest.bytes).equals(Buffer.from(file.contents))
    ) {
      return yield* fail("Extension manifest changed between discovery and sealed-tree validation");
    }
    const packageValidation = validateExtensionPackageContent(manifest, tree);
    if (!packageValidation.valid) return yield* fail(packageValidation.message);
    const canonicalProfilePath = yield* Effect.tryPromise({
      try: () => canonicalizeExtensionToolProfilePath(profilePath),
      catch: toolLoadFailure(`Failed to canonicalize Profile for Extension ${manifest.id}`),
    });
    yield* requireExactToolApprovals(canonicalProfilePath, manifest, provenance, approvals, tree);

    const prepared = yield* Effect.forEach(manifest.tools, (tool) =>
      prepareToolSnapshot(manifest.id, tool.id, tool.path, tree),
    );
    const point = { extensionId: manifest.id, toolIds: manifest.tools.map((tool) => tool.id) };
    if (options.beforeFinalLiveSealCheck !== undefined) {
      yield* options.beforeFinalLiveSealCheck(point);
    }
    const finalLiveTree = yield* Effect.tryPromise({
      try: () => readImmutableExtensionTree(file.rootPath),
      catch: toolLoadFailure(`Failed final live seal read for Extension ${manifest.id}`),
    });
    const finalSealError = validateExtensionSeal(manifest, provenance, finalLiveTree.files);
    if (finalSealError !== undefined) {
      yield* invalidateApprovals(profilePath, approvals);
      return yield* fail(
        `${finalSealError}; Extension ${manifest.id} was invalidated and reinstall is required`,
      );
    }
    if (options.beforeImport !== undefined) yield* options.beforeImport(point);
    const imported = yield* Effect.forEach(prepared, (tool) => importPreparedTool(tool, options));
    const postImportLiveTree = yield* Effect.tryPromise({
      try: () => readImmutableExtensionTree(file.rootPath),
      catch: toolLoadFailure(`Failed post-import live seal read for Extension ${manifest.id}`),
    });
    const postImportSealError = validateExtensionSeal(
      manifest,
      provenance,
      postImportLiveTree.files,
    );
    if (postImportSealError !== undefined) {
      yield* invalidateApprovals(profilePath, approvals);
      return yield* fail(
        `${postImportSealError}; Extension ${manifest.id} was invalidated and loaded Tools were discarded`,
      );
    }
    return imported;
  });
}

function prepareToolSnapshot(
  extensionId: string,
  toolId: string,
  toolRoot: string,
  tree: ExtensionTreeSnapshot,
): Effect.Effect<PreparedTool, ExtensionToolLoadError, Scope.Scope> {
  const prefix = `${toolRoot}/`;
  const sourceFiles = tree.files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ path: file.path.slice(prefix.length), bytes: file.bytes }));
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createExtensionToolExecutionSnapshot(extensionId, toolId, sourceFiles),
      catch: toolLoadFailure(`Failed to materialize Tool snapshot ${extensionId}/${toolId}`),
    }),
    (snapshot) =>
      Effect.tryPromise({
        try: () => removeExtensionToolExecutionSnapshot(snapshot.rootPath),
        catch: toolLoadFailure(`Failed to remove Tool snapshot ${extensionId}/${toolId}`),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`Failed to remove Tool snapshot ${extensionId}/${toolId}`, cause),
        ),
      ),
  ).pipe(
    Effect.flatMap((snapshot) =>
      Effect.tryPromise({
        try: () => readImmutableExtensionTree(snapshot.rootPath),
        catch: toolLoadFailure(`Failed to validate Tool snapshot ${extensionId}/${toolId}`),
      }).pipe(
        Effect.flatMap((snapshotTree) =>
          snapshotMatches(sourceFiles, snapshotTree.files)
            ? Effect.succeed({ id: toolId, snapshot })
            : fail(`Tool snapshot bytes changed for ${extensionId}/${toolId}`),
        ),
      ),
    ),
  );
}

function importPreparedTool(
  prepared: PreparedTool,
  options: ExtensionToolLoaderOptions,
): Effect.Effect<SessionTool, ExtensionToolLoadError> {
  return Effect.gen(function* () {
    const imported = yield* options.importModule === undefined
      ? Effect.tryPromise({
          try: () => importExtensionToolModule(prepared.snapshot.entryPath),
          catch: toolLoadFailure(`Failed to import Extension Tool ${prepared.id}`),
        })
      : options.importModule(prepared.snapshot.entryPath);
    const module = inspectImportedExtensionToolModule(imported);
    if (module.exportNames.length !== 1 || module.exportNames[0] !== "default") {
      return yield* fail(`Extension Tool ${prepared.id} must have one default export`);
    }
    const decoded = yield* decodeToolDefinition(module.defaultExport).pipe(
      Effect.mapError(toolLoadFailure(`Invalid Extension Tool definition ${prepared.id}`)),
    );
    if (decoded.name !== prepared.id) {
      return yield* fail(`Extension Tool name must match manifest Tool id ${prepared.id}`);
    }
    if (!isExtensionToolExecute(decoded.execute)) {
      return yield* fail(`Extension Tool ${prepared.id} execute must be a function`);
    }
    const inputSchema = jsonObject(decoded.inputSchema);
    if (inputSchema === undefined || inputSchema.type !== "object") {
      return yield* fail(`Extension Tool ${prepared.id} inputSchema must be a JSON object schema`);
    }
    const definition: ExtensionToolDefinition = {
      name: decoded.name,
      description: decoded.description,
      inputSchema,
      execute: decoded.execute,
    };
    return sessionTool(definition);
  });
}

function isExtensionToolExecute(value: unknown): value is ExtensionToolDefinition["execute"] {
  return typeof value === "function";
}

function sessionTool(definition: ExtensionToolDefinition): SessionTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: structuredClone(definition.inputSchema),
    execute({ sessionId, turnId, stepId, toolCallId, input, signal }) {
      const context: ExtensionToolContext = { sessionId, turnId, stepId, toolCallId, signal };
      return Effect.tryPromise({
        try: () => invokeExtensionTool(definition.execute, input, context),
        catch: (cause) =>
          new SessionRuntimeError({
            message: `Extension Tool ${definition.name} execution failed`,
            cause,
          }),
      }).pipe(
        Effect.flatMap((output) => {
          const json = jsonValue(output);
          return json === undefined
            ? Effect.fail(
                new SessionRuntimeError({
                  message: `Extension Tool ${definition.name} returned a non-JSON value`,
                }),
              )
            : Effect.succeed(json);
        }),
      );
    },
  };
}

function requireExactToolApprovals(
  profilePath: string,
  manifest: ExtensionManifest,
  provenance: ExtensionProvenance,
  approvals: ExtensionApprovals,
  tree: ExtensionTreeSnapshot,
): Effect.Effect<void, ExtensionToolLoadError> {
  for (const tool of manifest.tools ?? []) {
    const entryPath = `${tool.path}/tool.ts`;
    const entry = tree.files.find((file) => file.path === entryPath);
    if (entry === undefined) return fail(`Missing Tool entry ${entryPath}`);
    const expected = makeExtensionApprovalRequirement({
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      entryKind: "tool",
      entryId: tool.id,
      argv: [],
      permissions: manifest.permissions,
      executablePath: join(profilePath, "extensions", manifest.id, entryPath),
      executableSha256: sha256(entry.bytes),
      trustTier: provenance.trustTier,
      treeDigest: provenance.treeDigest,
      epoch: approvals.epoch,
    });
    if (!approvals.approvals.some((approval) => approvalRequirementsEqual(approval, expected))) {
      return fail(
        `Exact execution approval is missing for Extension Tool ${manifest.id}/${tool.id}`,
      );
    }
  }
  return Effect.void;
}

function approvalRequirementsEqual(
  left: ReturnType<typeof makeExtensionApprovalRequirement>,
  right: ReturnType<typeof makeExtensionApprovalRequirement>,
): boolean {
  return (
    left.fingerprint === right.fingerprint &&
    left.extensionId === right.extensionId &&
    left.extensionVersion === right.extensionVersion &&
    left.entryKind === right.entryKind &&
    left.entryId === right.entryId &&
    arraysEqual(left.argv, right.argv) &&
    left.permissions.network === right.permissions.network &&
    left.permissions.filesystem === right.permissions.filesystem &&
    arraysEqual(left.permissions.secrets, right.permissions.secrets) &&
    left.executablePath === right.executablePath &&
    left.executableSha256 === right.executableSha256 &&
    left.trustTier === right.trustTier &&
    left.treeDigest === right.treeDigest &&
    left.epoch === right.epoch
  );
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalidateApprovals(
  profilePath: string,
  approvals: ExtensionApprovals,
): Effect.Effect<void, ExtensionToolLoadError> {
  const invalidated = invalidatedExtensionApprovals(approvals);
  return Effect.tryPromise({
    try: () =>
      replaceExtensionAuthorityJson(
        profilePath,
        approvals.extensionId,
        "approvals.json",
        `${JSON.stringify(invalidated, undefined, 2)}\n`,
      ),
    catch: toolLoadFailure(`Failed to invalidate approvals for Extension ${approvals.extensionId}`),
  });
}

function snapshotMatches(
  expected: ReadonlyArray<ExtensionFileSnapshot>,
  actual: ReadonlyArray<ExtensionFileSnapshot>,
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((file, index) => {
      const other = actual[index];
      return (
        other !== undefined &&
        file.path === other.path &&
        Buffer.from(file.bytes).equals(Buffer.from(other.bytes))
      );
    })
  );
}

function jsonObject(value: unknown): JsonObject | undefined {
  const decoded = jsonValue(value);
  return decoded !== undefined && isJsonObject(decoded) ? decoded : undefined;
}

function jsonValue(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return undefined;
    const nextAncestors = new Set(ancestors).add(value);
    const entries: JsonValue[] = [];
    for (const entry of value) {
      const decoded = jsonValue(entry, nextAncestors);
      if (decoded === undefined) return undefined;
      entries.push(decoded);
    }
    return entries;
  }
  if (typeof value !== "object" || ancestors.has(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const nextAncestors = new Set(ancestors).add(value);
  const entries: Array<readonly [string, JsonValue]> = [];
  for (const [key, entry] of Object.entries(value)) {
    const decoded = jsonValue(entry, nextAncestors);
    if (decoded === undefined) return undefined;
    entries.push([key, decoded]);
  }
  return Object.fromEntries(entries);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): Effect.Effect<never, ExtensionToolLoadError> {
  return Effect.fail(new ExtensionToolLoadError({ message, cause: message }));
}

function toolLoadFailure(message: string): (cause: unknown) => ExtensionToolLoadError {
  return (cause) => new ExtensionToolLoadError({ message, cause });
}
