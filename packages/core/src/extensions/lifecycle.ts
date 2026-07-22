import { dirname } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { ZIGGY_VERSION } from "../product-version.ts";
import {
  canonicalApprovals,
  decodeExtensionApprovalsJson,
  type ExtensionApprovalRequirement,
  type ExtensionApprovals,
  makeExtensionApprovalRequirement,
} from "./approvals.ts";
import {
  activateStagedExtension,
  cleanupStagedExtension,
  inspectLocalExtensionSource,
  type ExtensionProcessResult,
  type InstalledExtensionFiles,
  listInstalledExtensionIds,
  readInstalledExtensionFiles,
  replaceExtensionAuthorityJson,
  resolveExtensionExecutable,
  runExtensionProcess,
  stageLocalExtensionPackage,
  type StagedExtensionPackage,
} from "./lifecycle-node-adapter.ts";
import { withExtensionLifecyclePermit } from "./lifecycle-coordinator.ts";
import { decodeExtensionManifestJson, type ExtensionManifest } from "./manifest.ts";
import {
  computeTreeDigest,
  deriveExtensionFileKind,
  sha256,
  validateExtensionPackageContent,
  validateExtensionSeal,
} from "./skill-loader.ts";
import { decodeExtensionProvenanceJson, type ExtensionProvenance } from "./provenance.ts";
import { isZiggyVersionCompatible } from "./semver.ts";
import {
  decodeUtf8Maybe,
  readImmutableExtensionTree,
  type ExtensionTreeSnapshot,
} from "./skill-loader-node-adapter.ts";
import { decodeExtensionEnabledStateJson, type ExtensionEnabledState } from "./state.ts";

export type ExtensionLifecycleErrorCode =
  | "extension-not-found"
  | "extension-invalid"
  | "extension-incompatible"
  | "approval-required"
  | "approval-invalid"
  | "extension-conflict"
  | "extension-operation-failed"
  | "extension-timeout"
  | "extension-mutated";

export class ExtensionLifecycleError extends Schema.TaggedErrorClass<ExtensionLifecycleError>(
  "@ziggy/core/extensions/ExtensionLifecycleError",
)("ExtensionLifecycleError", {
  operation: Schema.String,
  code: Schema.Literals([
    "extension-not-found",
    "extension-invalid",
    "extension-incompatible",
    "approval-required",
    "approval-invalid",
    "extension-conflict",
    "extension-operation-failed",
    "extension-timeout",
    "extension-mutated",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ExtensionInstallRequest {
  readonly sourcePath: string;
  readonly approvals: ReadonlyArray<string>;
  readonly verification?: {
    readonly keyId: string;
    readonly signature: string;
  };
}

export interface ExtensionEnableRequest {
  readonly extensionId: string;
  readonly approvals: ReadonlyArray<string>;
}

export interface ExtensionDisableRequest {
  readonly extensionId: string;
}

export interface ExtensionDoctorRequest {
  readonly extensionId: string;
  readonly approval?: string;
}

export interface ExtensionObservation {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly trustTier: ExtensionProvenance["trustTier"];
  readonly treeDigest: string;
  readonly approvalEpoch: number;
  readonly health: "ready" | "mutated" | "invalid";
  readonly message?: string;
}

export type ExtensionInstallResult =
  | {
      readonly status: "approval-required";
      readonly extensionId: string;
      readonly requirements: ReadonlyArray<ExtensionApprovalRequirement>;
    }
  | {
      readonly status: "installed";
      readonly extension: ExtensionObservation;
    };

export type ExtensionEnableResult =
  | {
      readonly status: "approval-required";
      readonly extensionId: string;
      readonly requirements: ReadonlyArray<ExtensionApprovalRequirement>;
    }
  | {
      readonly status: "enabled";
      readonly extension: ExtensionObservation;
    };

export interface ExtensionDoctorResult extends ExtensionProcessResult {
  readonly extension: ExtensionObservation;
}

export interface ExtensionBuiltinCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly treeDigest: string;
}

export interface ExtensionSignatureVerificationInput {
  readonly keyId: string;
  readonly signature: string;
  readonly message: string;
}

export interface ExtensionLifecycleOptions {
  readonly profilePath: string;
  readonly runningZiggyVersion?: string;
  readonly commandSearchPath?: string;
  readonly builtinCatalog?: ReadonlyArray<ExtensionBuiltinCatalogEntry>;
  readonly verifySignature?: (
    input: ExtensionSignatureVerificationInput,
  ) => Effect.Effect<boolean, ExtensionLifecycleError>;
  readonly processTimeoutMs?: number;
  readonly processOutputLimitBytes?: number;
}

export interface ExtensionLifecycleService {
  install(
    request: ExtensionInstallRequest,
  ): Effect.Effect<ExtensionInstallResult, ExtensionLifecycleError>;
  enable(
    request: ExtensionEnableRequest,
  ): Effect.Effect<ExtensionEnableResult, ExtensionLifecycleError>;
  disable(
    request: ExtensionDisableRequest,
  ): Effect.Effect<ExtensionObservation, ExtensionLifecycleError>;
  list(): Effect.Effect<ReadonlyArray<ExtensionObservation>, ExtensionLifecycleError>;
  doctor(
    request: ExtensionDoctorRequest,
  ): Effect.Effect<ExtensionDoctorResult, ExtensionLifecycleError>;
}

export class ExtensionLifecycle extends Context.Service<
  ExtensionLifecycle,
  ExtensionLifecycleService
>()("@ziggy/core/extensions/ExtensionLifecycle") {
  static layer(options: ExtensionLifecycleOptions) {
    return Layer.effect(this, makeExtensionLifecycle(options));
  }
}

interface InstalledRecord {
  readonly files: InstalledExtensionFiles;
  readonly manifest: ExtensionManifest;
  readonly provenance: ExtensionProvenance;
  readonly state: ExtensionEnabledState;
  readonly approvals: ExtensionApprovals;
}

function makeExtensionLifecycle(
  options: ExtensionLifecycleOptions,
): Effect.Effect<ExtensionLifecycleService> {
  return Effect.sync(() => {
    const serialized = <Value>(
      key: string,
      operation: Effect.Effect<Value, ExtensionLifecycleError>,
    ) => withExtensionLifecyclePermit(options.profilePath, key, operation);
    const install = (request: ExtensionInstallRequest) =>
      installExtension(options, request).pipe(
        Effect.flatMap((prepared) => serialized(prepared.extensionId, prepared.effect)),
      );
    const enable = (request: ExtensionEnableRequest) =>
      serialized(request.extensionId, enableExtension(options, request));
    const disable = (request: ExtensionDisableRequest) =>
      serialized(request.extensionId, disableExtension(options, request));
    const doctor = (request: ExtensionDoctorRequest) =>
      serialized(request.extensionId, doctorExtension(options, request));
    const list = () => listExtensions(options, serialized);
    return ExtensionLifecycle.of({ install, enable, disable, list, doctor });
  });
}

function installExtension(
  options: ExtensionLifecycleOptions,
  request: ExtensionInstallRequest,
): Effect.Effect<
  {
    readonly extensionId: string;
    readonly effect: Effect.Effect<ExtensionInstallResult, ExtensionLifecycleError>;
  },
  ExtensionLifecycleError
> {
  return inspectPackage(options, request.sourcePath).pipe(
    Effect.flatMap(({ tree }) => decodeStagedManifest(tree)),
    Effect.map((inspectedManifest) => ({
      extensionId: inspectedManifest.id,
      effect: stagePackage(options, request.sourcePath).pipe(
        Effect.flatMap(({ sourcePath, staged, tree }) =>
          decodeStagedManifest(tree).pipe(
            Effect.flatMap((manifest) =>
              manifest.id === inspectedManifest.id
                ? completeInstall(options, request, sourcePath, staged, tree, manifest)
                : lifecycleFailure(
                    "install",
                    "extension-conflict",
                    "Extension source identity changed while acquiring its lifecycle lock",
                  ),
            ),
            Effect.ensuring(cleanupStage(staged)),
          ),
        ),
      ),
    })),
  );
}

function completeInstall(
  options: ExtensionLifecycleOptions,
  request: ExtensionInstallRequest,
  sourcePath: string,
  staged: StagedExtensionPackage,
  tree: ExtensionTreeSnapshot,
  manifest: ExtensionManifest,
): Effect.Effect<ExtensionInstallResult, ExtensionLifecycleError> {
  return Effect.gen(function* () {
    yield* validateCompatibility(options, manifest);
    const packageValidation = validateExtensionPackageContent(manifest, tree);
    if (!packageValidation.valid) {
      return yield* lifecycleFailure("install", "extension-invalid", packageValidation.message);
    }
    const files = tree.files.map((file) => {
      const kind = deriveExtensionFileKind(manifest, file.path);
      if (kind === undefined) return undefined;
      return { path: file.path, kind, bytes: file.bytes.byteLength, sha256: sha256(file.bytes) };
    });
    if (files.some((file) => file === undefined)) {
      return yield* lifecycleFailure("install", "extension-invalid", "Unknown package file");
    }
    const catalog = files.flatMap((file) => (file === undefined ? [] : [file]));
    const treeDigest = computeTreeDigest(catalog);
    const trustTier = yield* deriveTrust(options, request, manifest, treeDigest);
    const previous = yield* readInstalled(options, manifest.id, false);
    const identical =
      previous !== undefined &&
      previous.provenance.extensionVersion === manifest.version &&
      previous.provenance.treeDigest === treeDigest &&
      previous.provenance.trustTier === trustTier;
    if (
      identical &&
      previous !== undefined &&
      previous.approvals.approvals.length === manifestExecutionEntryCount(manifest)
    ) {
      return { status: "installed", extension: observation(previous) };
    }
    const epoch =
      previous === undefined
        ? 0
        : identical
          ? previous.approvals.epoch
          : previous.approvals.epoch + 1;
    const requirements = yield* makeApprovalRequirements(
      options,
      manifest,
      trustTier,
      treeDigest,
      epoch,
      staged.packagePath,
      staged.profilePath,
      tree,
    );
    if (!hasExactApprovals(request.approvals, requirements)) {
      return { status: "approval-required", extensionId: manifest.id, requirements };
    }
    const provenance: ExtensionProvenance = {
      schemaVersion: 1,
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      source: { kind: "local", locator: sourcePath },
      trustTier,
      verification:
        trustTier === "verified" && request.verification !== undefined
          ? {
              method: "ed25519",
              keyId: request.verification.keyId,
              signature: request.verification.signature,
            }
          : {
              method: trustTier === "builtin" ? "builtin-catalog" : "none",
              keyId: "",
              signature: "",
            },
      files: catalog,
      treeDigest,
    };
    for (const requirement of requirements) {
      if (requirement.entryKind !== "setup") continue;
      const executable = yield* resolveExecutable(
        options,
        manifest.id,
        staged.packagePath,
        requirement.argv[0] ?? "",
      );
      if (
        executable.approvalPath !== requirement.executablePath ||
        executable.sha256 !== requirement.executableSha256
      ) {
        return yield* lifecycleFailure(
          "install",
          "approval-invalid",
          `Approved setup executable changed: ${requirement.entryId}`,
        );
      }
      const result = yield* runProcess(
        options,
        executable.executionPath,
        requirement.argv,
        staged.packagePath,
      );
      if (result.status !== "ok") {
        return yield* lifecycleFailure(
          "install",
          result.status === "timeout" ? "extension-timeout" : "extension-operation-failed",
          `Extension setup ${requirement.entryId} ${result.status}`,
        );
      }
    }
    const postSetupTree = yield* nodeOperation(
      "install",
      `Failed to recheck Extension ${manifest.id} after setup`,
      () => readImmutableExtensionTree(staged.packagePath),
    );
    const postSetupSealError = validateExtensionSeal(manifest, provenance, postSetupTree.files);
    if (postSetupSealError !== undefined) {
      return yield* lifecycleFailure("install", "extension-mutated", postSetupSealError);
    }
    const approvals: ExtensionApprovals = {
      schemaVersion: 1,
      extensionId: manifest.id,
      epoch,
      approvals: canonicalApprovals(requirements),
    };
    const state: ExtensionEnabledState = {
      schemaVersion: 1,
      extensionId: manifest.id,
      enabled: previous?.state.enabled ?? false,
    };
    yield* activate(options, manifest.id, staged, state, provenance, approvals);
    const installed = yield* readInstalledRequired(options, manifest.id, false);
    return { status: "installed", extension: observation(installed) };
  });
}

function enableExtension(
  options: ExtensionLifecycleOptions,
  request: ExtensionEnableRequest,
): Effect.Effect<ExtensionEnableResult, ExtensionLifecycleError> {
  return Effect.gen(function* () {
    const installed = yield* readInstalledRequired(options, request.extensionId, true);
    yield* validateCompatibility(options, installed.manifest);
    const requirements =
      installed.approvals.approvals.length === 0 &&
      manifestExecutionEntryCount(installed.manifest) > 0
        ? yield* makeApprovalRequirements(
            options,
            installed.manifest,
            installed.provenance.trustTier,
            installed.provenance.treeDigest,
            installed.approvals.epoch,
            installed.files.rootPath,
            dirname(dirname(installed.files.rootPath)),
            installed.files.tree,
          )
        : installed.approvals.approvals;
    if (!hasExactApprovals(request.approvals, requirements)) {
      return {
        status: "approval-required",
        extensionId: installed.manifest.id,
        requirements,
      };
    }
    if (installed.approvals.approvals.length !== requirements.length) {
      yield* writeAuthority(
        options,
        installed.manifest.id,
        "approvals.json",
        json({ ...installed.approvals, approvals: requirements }),
      );
    }
    if (!installed.state.enabled) {
      yield* writeAuthority(
        options,
        installed.manifest.id,
        "state.json",
        json({ ...installed.state, enabled: true }),
      );
    }
    const enabled = yield* readInstalledRequired(options, request.extensionId, true);
    return { status: "enabled", extension: observation(enabled) };
  });
}

function disableExtension(
  options: ExtensionLifecycleOptions,
  request: ExtensionDisableRequest,
): Effect.Effect<ExtensionObservation, ExtensionLifecycleError> {
  return Effect.gen(function* () {
    const installed = yield* readInstalledRequired(options, request.extensionId, false);
    if (installed.state.enabled) {
      yield* writeAuthority(
        options,
        installed.manifest.id,
        "state.json",
        json({ ...installed.state, enabled: false }),
      );
    }
    return observation(yield* readInstalledRequired(options, request.extensionId, false));
  });
}

function listExtensions(
  options: ExtensionLifecycleOptions,
  serialized: <Value>(
    key: string,
    effect: Effect.Effect<Value, ExtensionLifecycleError>,
  ) => Effect.Effect<Value, ExtensionLifecycleError>,
): Effect.Effect<ReadonlyArray<ExtensionObservation>, ExtensionLifecycleError> {
  return nodeOperation("list", "Failed to list installed Extensions", () =>
    listInstalledExtensionIds(options.profilePath),
  ).pipe(
    Effect.flatMap((ids) =>
      Effect.forEach(ids, (id) =>
        serialized(
          id,
          readInstalledRequired(options, id, false).pipe(
            Effect.map(observation),
            Effect.catch((error) =>
              Effect.succeed<ExtensionObservation>({
                id,
                version: "",
                name: id,
                enabled: false,
                trustTier: "community",
                treeDigest: "",
                approvalEpoch: 0,
                health: error.code === "extension-mutated" ? "mutated" : "invalid",
                // oxlint-disable-next-line ziggy-effect/no-unknown-error-message -- ExtensionLifecycleError is the typed service error contract
                message: error.message,
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

function doctorExtension(
  options: ExtensionLifecycleOptions,
  request: ExtensionDoctorRequest,
): Effect.Effect<ExtensionDoctorResult, ExtensionLifecycleError> {
  return Effect.gen(function* () {
    const installed = yield* readInstalledRequired(options, request.extensionId, true);
    yield* validateCompatibility(options, installed.manifest);
    const doctor = installed.approvals.approvals.find((entry) => entry.entryKind === "doctor");
    if (doctor === undefined) {
      return yield* lifecycleFailure(
        "doctor",
        "extension-invalid",
        `Extension ${request.extensionId} does not declare a doctor command`,
      );
    }
    if (request.approval !== doctor.fingerprint) {
      return yield* lifecycleFailure(
        "doctor",
        "approval-invalid",
        `Doctor approval is missing or stale for Extension ${request.extensionId}`,
      );
    }
    const executable = yield* resolveExecutable(
      options,
      installed.manifest.id,
      installed.files.rootPath,
      doctor.argv[0] ?? "",
    );
    if (
      executable.approvalPath !== doctor.executablePath ||
      executable.sha256 !== doctor.executableSha256
    ) {
      yield* advanceApprovalEpoch(options, installed);
      return yield* lifecycleFailure(
        "doctor",
        "extension-mutated",
        `Approved doctor executable changed for Extension ${request.extensionId}`,
      );
    }
    const result = yield* runProcess(
      options,
      executable.executionPath,
      doctor.argv,
      installed.files.rootPath,
    );
    return { extension: observation(installed), ...result };
  });
}

function readInstalledRequired(
  options: ExtensionLifecycleOptions,
  extensionId: string,
  advanceMutation: boolean,
): Effect.Effect<InstalledRecord, ExtensionLifecycleError> {
  return readInstalled(options, extensionId, advanceMutation).pipe(
    Effect.flatMap((record) =>
      record === undefined
        ? lifecycleFailure(
            "read",
            "extension-not-found",
            `Extension ${extensionId} is not installed`,
          )
        : Effect.succeed(record),
    ),
  );
}

function readInstalled(
  options: ExtensionLifecycleOptions,
  extensionId: string,
  advanceMutation: boolean,
): Effect.Effect<InstalledRecord | undefined, ExtensionLifecycleError> {
  return nodeOperation("read", `Failed to read Extension ${extensionId}`, () =>
    readInstalledExtensionFiles(options.profilePath, extensionId),
  ).pipe(
    Effect.flatMap((files) => {
      if (files === undefined) return Effect.succeed(undefined);
      return decodeInstalled(files).pipe(
        Effect.flatMap((record) => {
          const sealError = validateExtensionSeal(
            record.manifest,
            record.provenance,
            files.tree.files,
          );
          if (sealError === undefined) return Effect.succeed(record);
          const invalid = lifecycleFailure("read", "extension-mutated", sealError);
          return advanceMutation
            ? advanceApprovalEpoch(options, record).pipe(Effect.andThen(invalid))
            : invalid;
        }),
      );
    }),
  );
}

function decodeInstalled(
  files: InstalledExtensionFiles,
): Effect.Effect<InstalledRecord, ExtensionLifecycleError> {
  return Effect.gen(function* () {
    const manifestFile = files.tree.files.find((file) => file.path === "extension.json");
    const manifestText =
      manifestFile === undefined ? undefined : decodeUtf8Maybe(manifestFile.bytes);
    if (manifestText === undefined) {
      return yield* lifecycleFailure("read", "extension-invalid", "Missing valid extension.json");
    }
    const manifest = yield* decodeExtensionManifestJson(manifestText).pipe(
      Effect.mapError((cause) =>
        lifecycleError("read", "extension-invalid", "Invalid Extension manifest", cause),
      ),
    );
    const provenance = yield* decodeExtensionProvenanceJson(files.provenanceJson).pipe(
      Effect.mapError((cause) =>
        lifecycleError("read", "extension-invalid", "Invalid Extension provenance", cause),
      ),
    );
    const state = yield* decodeExtensionEnabledStateJson(files.stateJson).pipe(
      Effect.mapError((cause) =>
        lifecycleError("read", "extension-invalid", "Invalid Extension state", cause),
      ),
    );
    const approvals = yield* decodeExtensionApprovalsJson(files.approvalsJson).pipe(
      Effect.mapError((cause) =>
        lifecycleError("read", "extension-invalid", "Invalid Extension approvals", cause),
      ),
    );
    if (
      manifest.id !== provenance.extensionId ||
      manifest.version !== provenance.extensionVersion ||
      manifest.id !== state.extensionId ||
      manifest.id !== approvals.extensionId ||
      !approvalsMatchAuthority(manifest, provenance, approvals)
    ) {
      return yield* lifecycleFailure(
        "read",
        "extension-invalid",
        "Extension authority identity mismatch",
      );
    }
    return { files, manifest, provenance, state, approvals };
  });
}

function approvalsMatchAuthority(
  manifest: ExtensionManifest,
  provenance: ExtensionProvenance,
  approvals: ExtensionApprovals,
): boolean {
  const entries = new Map<string, { readonly argv: ReadonlyArray<string> }>();
  for (const tool of manifest.tools ?? []) entries.set(`tool\0${tool.id}`, { argv: [] });
  for (const [index, step] of (manifest.setup?.steps ?? []).entries()) {
    entries.set(`setup\0${index}`, { argv: step.argv });
  }
  if (manifest.setup?.doctor !== undefined) {
    entries.set("doctor\0doctor", { argv: manifest.setup.doctor.argv });
  }
  if (approvals.approvals.length === 0) return true;
  if (entries.size !== approvals.approvals.length) return false;
  return approvals.approvals.every((approval) => {
    const entry = entries.get(`${approval.entryKind}\0${approval.entryId}`);
    return (
      entry !== undefined &&
      approval.epoch === approvals.epoch &&
      approval.extensionId === manifest.id &&
      approval.extensionVersion === manifest.version &&
      approval.trustTier === provenance.trustTier &&
      approval.treeDigest === provenance.treeDigest &&
      approval.permissions.network === manifest.permissions.network &&
      approval.permissions.filesystem === manifest.permissions.filesystem &&
      arraysEqual(approval.permissions.secrets, manifest.permissions.secrets) &&
      arraysEqual(approval.argv, entry.argv)
    );
  });
}

function manifestExecutionEntryCount(manifest: ExtensionManifest): number {
  return (
    (manifest.tools?.length ?? 0) +
    (manifest.setup?.steps.length ?? 0) +
    (manifest.setup?.doctor === undefined ? 0 : 1)
  );
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function decodeStagedManifest(
  tree: ExtensionTreeSnapshot,
): Effect.Effect<ExtensionManifest, ExtensionLifecycleError> {
  const manifestFile = tree.files.find((file) => file.path === "extension.json");
  const text = manifestFile === undefined ? undefined : decodeUtf8Maybe(manifestFile.bytes);
  if (text === undefined) {
    return lifecycleFailure(
      "install",
      "extension-invalid",
      "Extension source has no valid extension.json",
    );
  }
  return decodeExtensionManifestJson(text).pipe(
    Effect.mapError((cause) =>
      lifecycleError("install", "extension-invalid", "Invalid Extension manifest", cause),
    ),
  );
}

function validateCompatibility(
  options: ExtensionLifecycleOptions,
  manifest: ExtensionManifest,
): Effect.Effect<void, ExtensionLifecycleError> {
  const running = options.runningZiggyVersion ?? ZIGGY_VERSION;
  if (!isZiggyVersionCompatible(manifest.ziggy.requires, running)) {
    return lifecycleFailure(
      "compatibility",
      "extension-incompatible",
      `Extension ${manifest.id} requires Ziggy ${manifest.ziggy.requires}; running ${running}`,
    );
  }
  return Effect.void;
}

function deriveTrust(
  options: ExtensionLifecycleOptions,
  request: ExtensionInstallRequest,
  manifest: ExtensionManifest,
  treeDigest: string,
): Effect.Effect<ExtensionProvenance["trustTier"], ExtensionLifecycleError> {
  return Effect.gen(function* () {
    if (request.verification !== undefined) {
      if (options.verifySignature === undefined) {
        return yield* lifecycleFailure(
          "install",
          "extension-invalid",
          "A signature was supplied but no trusted-key verifier is configured",
        );
      }
      const valid = yield* options.verifySignature({
        ...request.verification,
        message: `ziggy-extension-provenance-v1\0${manifest.id}\0${manifest.version}\0${treeDigest}`,
      });
      if (!valid) {
        return yield* lifecycleFailure(
          "install",
          "extension-invalid",
          "Supplied Extension signature is invalid",
        );
      }
      return "verified";
    }
    const builtin = (options.builtinCatalog ?? []).some(
      (entry) =>
        entry.id === manifest.id &&
        entry.version === manifest.version &&
        entry.treeDigest === treeDigest,
    );
    return builtin ? "builtin" : "community";
  });
}

function makeApprovalRequirements(
  options: ExtensionLifecycleOptions,
  manifest: ExtensionManifest,
  trustTier: ExtensionProvenance["trustTier"],
  treeDigest: string,
  epoch: number,
  packagePath: string,
  canonicalProfilePath: string,
  tree: ExtensionTreeSnapshot,
): Effect.Effect<ReadonlyArray<ExtensionApprovalRequirement>, ExtensionLifecycleError> {
  return Effect.gen(function* () {
    const requirements: ExtensionApprovalRequirement[] = [];
    for (const tool of manifest.tools ?? []) {
      const toolPath = `${tool.path}/tool.ts`;
      const file = tree.files.find((entry) => entry.path === toolPath);
      if (file === undefined) {
        return yield* lifecycleFailure("install", "extension-invalid", `Missing ${toolPath}`);
      }
      requirements.push(
        makeExtensionApprovalRequirement({
          extensionId: manifest.id,
          extensionVersion: manifest.version,
          entryKind: "tool",
          entryId: tool.id,
          argv: [],
          permissions: manifest.permissions,
          executablePath: `${canonicalProfilePath}/extensions/${manifest.id}/${toolPath}`,
          executableSha256: sha256(file.bytes),
          trustTier,
          treeDigest,
          epoch,
        }),
      );
    }
    for (const [index, step] of (manifest.setup?.steps ?? []).entries()) {
      const executable = yield* resolveExecutable(
        options,
        manifest.id,
        packagePath,
        step.argv[0] ?? "",
      );
      requirements.push(
        makeExtensionApprovalRequirement({
          extensionId: manifest.id,
          extensionVersion: manifest.version,
          entryKind: "setup",
          entryId: String(index),
          argv: step.argv,
          permissions: manifest.permissions,
          executablePath: executable.approvalPath,
          executableSha256: executable.sha256,
          trustTier,
          treeDigest,
          epoch,
        }),
      );
    }
    if (manifest.setup?.doctor !== undefined) {
      const executable = yield* resolveExecutable(
        options,
        manifest.id,
        packagePath,
        manifest.setup.doctor.argv[0] ?? "",
      );
      requirements.push(
        makeExtensionApprovalRequirement({
          extensionId: manifest.id,
          extensionVersion: manifest.version,
          entryKind: "doctor",
          entryId: "doctor",
          argv: manifest.setup.doctor.argv,
          permissions: manifest.permissions,
          executablePath: executable.approvalPath,
          executableSha256: executable.sha256,
          trustTier,
          treeDigest,
          epoch,
        }),
      );
    }
    return canonicalApprovals(requirements);
  });
}

function hasExactApprovals(
  supplied: ReadonlyArray<string>,
  requirements: ReadonlyArray<ExtensionApprovalRequirement>,
): boolean {
  const expected = requirements.map((requirement) => requirement.fingerprint).sort();
  const actual = [...supplied].sort();
  return (
    expected.length === actual.length && expected.every((value, index) => value === actual[index])
  );
}

function observation(installed: InstalledRecord): ExtensionObservation {
  return {
    id: installed.manifest.id,
    version: installed.manifest.version,
    name: installed.manifest.name,
    enabled: installed.state.enabled,
    trustTier: installed.provenance.trustTier,
    treeDigest: installed.provenance.treeDigest,
    approvalEpoch: installed.approvals.epoch,
    health: "ready",
  };
}

function advanceApprovalEpoch(
  options: ExtensionLifecycleOptions,
  installed: InstalledRecord,
): Effect.Effect<void, ExtensionLifecycleError> {
  const invalidated: ExtensionApprovals = {
    schemaVersion: 1,
    extensionId: installed.manifest.id,
    epoch: installed.approvals.epoch + 1,
    approvals: [],
  };
  return writeAuthority(options, installed.manifest.id, "approvals.json", json(invalidated));
}

function stagePackage(options: ExtensionLifecycleOptions, sourcePath: string) {
  return nodeOperation("install", "Failed to quarantine Extension source", () =>
    stageLocalExtensionPackage(options.profilePath, sourcePath),
  );
}

function inspectPackage(options: ExtensionLifecycleOptions, sourcePath: string) {
  return nodeOperation("install", "Failed to inspect Extension source", () =>
    inspectLocalExtensionSource(options.profilePath, sourcePath),
  );
}

function cleanupStage(staged: StagedExtensionPackage): Effect.Effect<void> {
  return Effect.promise(() => cleanupStagedExtension(staged));
}

function resolveExecutable(
  options: ExtensionLifecycleOptions,
  extensionId: string,
  packagePath: string,
  executable: string,
) {
  return nodeOperation("resolve-executable", `Failed to resolve executable ${executable}`, () =>
    resolveExtensionExecutable(
      options.profilePath,
      extensionId,
      packagePath,
      executable,
      options.commandSearchPath ?? process.env.PATH ?? "",
    ),
  );
}

function runProcess(
  options: ExtensionLifecycleOptions,
  executablePath: string,
  argv: ReadonlyArray<string>,
  cwd: string,
) {
  return nodeOperation("process", `Failed to run Extension process ${executablePath}`, () =>
    runExtensionProcess({
      executablePath,
      argv,
      cwd,
      timeoutMs: options.processTimeoutMs ?? 30_000,
      outputLimitBytes: options.processOutputLimitBytes ?? 64 * 1024,
    }),
  );
}

function activate(
  options: ExtensionLifecycleOptions,
  extensionId: string,
  staged: StagedExtensionPackage,
  state: ExtensionEnabledState,
  provenance: ExtensionProvenance,
  approvals: ExtensionApprovals,
): Effect.Effect<void, ExtensionLifecycleError> {
  return nodeOperation("activate", `Failed to activate Extension ${extensionId}`, () =>
    activateStagedExtension({
      profilePath: options.profilePath,
      extensionId,
      staged,
      stateJson: json(state),
      provenanceJson: json(provenance),
      approvalsJson: json(approvals),
    }),
  ).pipe(Effect.uninterruptible);
}

function writeAuthority(
  options: ExtensionLifecycleOptions,
  extensionId: string,
  name: "state.json" | "approvals.json",
  contents: string,
): Effect.Effect<void, ExtensionLifecycleError> {
  return nodeOperation(
    "authority-write",
    `Failed to write ${name} for Extension ${extensionId}`,
    () => replaceExtensionAuthorityJson(options.profilePath, extensionId, name, contents),
  ).pipe(Effect.uninterruptible);
}

function nodeOperation<Value>(
  operation: string,
  message: string,
  // oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- named boundary converts the Node adapter Promise into a typed Effect
  run: () => Promise<Value>,
): Effect.Effect<Value, ExtensionLifecycleError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => lifecycleError(operation, "extension-operation-failed", message, cause),
  });
}

function lifecycleFailure(
  operation: string,
  code: ExtensionLifecycleErrorCode,
  message: string,
): Effect.Effect<never, ExtensionLifecycleError> {
  return Effect.fail(lifecycleError(operation, code, message));
}

function lifecycleError(
  operation: string,
  code: ExtensionLifecycleErrorCode,
  message: string,
  cause?: unknown,
): ExtensionLifecycleError {
  return new ExtensionLifecycleError({ operation, code, message, cause });
}

function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}
