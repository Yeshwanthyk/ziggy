import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Schema } from "effect";

export type ResidentServiceManager = "launchd" | "systemd";
export type ResidentLaunchVector = readonly [string, ...ReadonlyArray<string>];

export interface ResidentServiceIdentity {
  readonly key: string;
  readonly readableName: string;
  readonly pathDigest: string;
  readonly launchdLabel: string;
  readonly systemdUnit: string;
}

export interface ResidentServiceDefinition {
  readonly manager: ResidentServiceManager;
  readonly identity: ResidentServiceIdentity;
  readonly profilePath: string;
  readonly launchVector: ResidentLaunchVector;
  readonly path: string;
  readonly fingerprint: string;
  readonly content: string;
}

export type ResidentServiceDefinitionState =
  | { readonly _tag: "not-installed"; readonly path: string }
  | { readonly _tag: "current"; readonly path: string; readonly fingerprint: string }
  | {
      readonly _tag: "drifted";
      readonly path: string;
      readonly expectedFingerprint: string;
      readonly installedFingerprint: string | undefined;
    }
  | {
      readonly _tag: "refused";
      readonly path: string;
      readonly reason: "unmanaged" | "symlink" | "non-regular";
    };

export type ResidentServiceWriteResult = "created" | "replaced" | "unchanged";

export class ResidentServiceError extends Schema.TaggedErrorClass<ResidentServiceError>()(
  "ResidentServiceError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "unsupported-platform",
      "invalid-path",
      "filesystem",
      "unmanaged-definition",
      "unsafe-definition",
      "definition-drift",
      "command",
    ]),
    path: Schema.UndefinedOr(Schema.String),
    message: Schema.String,
    cause: Schema.UndefinedOr(Schema.Defect()),
  },
) {}

const readableProfileName = (profilePath: string): string => {
  const readable = basename(profilePath)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32)
    .replace(/-+$/u, "");
  return readable.length === 0 ? "profile" : readable;
};

export const residentServiceFingerprint = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const deriveResidentServiceIdentity = (
  resolvedProfilePath: string,
): ResidentServiceIdentity => {
  const readableName = readableProfileName(resolvedProfilePath);
  const pathDigest = residentServiceFingerprint(resolvedProfilePath).slice(0, 12);
  const key = `${readableName}-${pathDigest}`;
  return {
    key,
    readableName,
    pathDigest,
    launchdLabel: `works.earendil.ziggy.serve.${readableName}.${pathDigest}`,
    systemdUnit: `ziggy-serve-${key}.service`,
  };
};
