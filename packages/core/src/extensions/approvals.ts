import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { ExtensionManifest } from "./manifest.ts";
import { isStrictJson } from "./strict-json.ts";

const Sha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const ApprovalPermissionsSchema = Schema.Struct({
  network: Schema.Boolean,
  filesystem: Schema.Literals(["none", "profile", "full"]),
  secrets: Schema.Array(Schema.String),
});

const ExtensionApprovalRequirementV1Schema = Schema.Struct({
  fingerprint: Sha256Schema,
  extensionId: Schema.String,
  extensionVersion: Schema.String,
  entryKind: Schema.Literals(["tool", "setup", "doctor"]),
  entryId: Schema.String,
  argv: Schema.Array(Schema.String),
  permissions: ApprovalPermissionsSchema,
  executablePath: Schema.String,
  executableSha256: Sha256Schema,
  trustTier: Schema.Literals(["builtin", "verified", "community"]),
  treeDigest: Sha256Schema,
  epoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const ExtensionCommandApprovalRequirementSchema = Schema.Struct({
  fingerprint: Sha256Schema,
  extensionId: Schema.String,
  extensionVersion: Schema.String,
  entryKind: Schema.Literal("command"),
  entryId: Schema.String,
  argv: Schema.Array(Schema.String),
  argumentMode: Schema.Literals(["none", "append"]),
  cwd: Schema.Literals(["extension", "profile"]),
  timeoutMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(300_000),
  ),
  permissions: ApprovalPermissionsSchema,
  executablePath: Schema.String,
  executableSha256: Sha256Schema,
  trustTier: Schema.Literals(["builtin", "verified", "community"]),
  treeDigest: Sha256Schema,
  epoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export const ExtensionApprovalRequirementSchema = Schema.Union([
  ExtensionApprovalRequirementV1Schema,
  ExtensionCommandApprovalRequirementSchema,
]);

export type ExtensionApprovalRequirement = typeof ExtensionApprovalRequirementSchema.Type;

const ExtensionApprovalsV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  extensionId: Schema.String,
  epoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  invalidated: Schema.Boolean,
  approvals: Schema.Array(ExtensionApprovalRequirementV1Schema).check(
    Schema.makeFilter(approvalsAreCanonical, {
      expected: "unique approvals sorted by fingerprint",
    }),
  ),
});
const ExtensionApprovalsV2Schema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  extensionId: Schema.String,
  epoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  invalidated: Schema.Boolean,
  approvals: Schema.Array(ExtensionApprovalRequirementSchema).check(
    Schema.makeFilter(approvalsAreCanonical, {
      expected: "unique approvals sorted by fingerprint",
    }),
  ),
});
export const ExtensionApprovalsSchema = Schema.Union([
  ExtensionApprovalsV1Schema,
  ExtensionApprovalsV2Schema,
]);

export type ExtensionApprovals = typeof ExtensionApprovalsSchema.Type;

const StrictJsonStringSchema = Schema.String.check(
  Schema.makeFilter(isStrictJson, {
    expected: "strict JSON without duplicate object keys",
  }),
);
const decodeStrictJsonString = Schema.decodeUnknownEffect(StrictJsonStringSchema);
const decodeApprovalsJsonString = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExtensionApprovalsSchema),
  { errors: "all", onExcessProperty: "error" },
);

export function decodeExtensionApprovalsJson(input: unknown) {
  return decodeStrictJsonString(input).pipe(Effect.flatMap(decodeApprovalsJsonString));
}

interface ApprovalFingerprintInputBase {
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly entryId: string;
  readonly argv: ReadonlyArray<string>;
  readonly permissions: ExtensionManifest["permissions"];
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly trustTier: ExtensionApprovalRequirement["trustTier"];
  readonly treeDigest: string;
  readonly epoch: number;
}
export type ApprovalFingerprintInput =
  | (ApprovalFingerprintInputBase & {
      readonly entryKind: "tool" | "setup" | "doctor";
    })
  | (ApprovalFingerprintInputBase & {
      readonly entryKind: "command";
      readonly argumentMode: "none" | "append";
      readonly cwd: "extension" | "profile";
      readonly timeoutMs: number;
    });

export function makeExtensionApprovalRequirement(
  input: ApprovalFingerprintInput,
): ExtensionApprovalRequirement {
  const fingerprint = createHash("sha256")
    .update(
      input.entryKind === "command"
        ? "ziggy-extension-command-approval-v2\0"
        : "ziggy-extension-approval-v1\0",
    )
    .update(frame(input.extensionId))
    .update(frame(input.extensionVersion))
    .update(frame(input.entryKind))
    .update(frame(input.entryId))
    .update(frameArray(input.argv))
    .update(frame(input.permissions.network ? "true" : "false"))
    .update(frame(input.permissions.filesystem))
    .update(frameArray(input.permissions.secrets))
    .update(frame(input.executablePath))
    .update(frame(input.executableSha256))
    .update(frame(input.trustTier))
    .update(frame(input.treeDigest))
    .update(frame(String(input.epoch)))
    .update(
      input.entryKind === "command"
        ? frameArray([input.argumentMode, input.cwd, String(input.timeoutMs)])
        : new Uint8Array(),
    )
    .digest("hex");
  return { ...input, fingerprint };
}

export function canonicalApprovals<Requirement extends ExtensionApprovalRequirement>(
  approvals: ReadonlyArray<Requirement>,
): ReadonlyArray<Requirement> {
  return [...approvals].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

export function invalidatedExtensionApprovals(approvals: ExtensionApprovals): ExtensionApprovals {
  return approvals.invalidated
    ? approvals
    : {
        schemaVersion: approvals.schemaVersion,
        extensionId: approvals.extensionId,
        epoch: approvals.epoch + 1,
        invalidated: true,
        approvals: [],
      };
}

function approvalsAreCanonical(approvals: ReadonlyArray<ExtensionApprovalRequirement>): boolean {
  for (let index = 1; index < approvals.length; index += 1) {
    const previous = approvals[index - 1];
    const current = approvals[index];
    if (previous === undefined || current === undefined) return false;
    if (previous.fingerprint >= current.fingerprint) return false;
  }
  return approvals.every(
    (approval) => makeExtensionApprovalRequirement(approval).fingerprint === approval.fingerprint,
  );
}

function frame(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, bytes.byteLength, false);
  const framed = new Uint8Array(prefix.byteLength + bytes.byteLength);
  framed.set(prefix);
  framed.set(bytes, prefix.byteLength);
  return framed;
}

function frameArray(values: ReadonlyArray<string>): Uint8Array {
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, values.length, false);
  const entries = values.map(frame);
  const total = entries.reduce((size, entry) => size + entry.byteLength, count.byteLength);
  const framed = new Uint8Array(total);
  framed.set(count);
  let offset = count.byteLength;
  for (const entry of entries) {
    framed.set(entry, offset);
    offset += entry.byteLength;
  }
  return framed;
}
