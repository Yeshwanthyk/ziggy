import { Schema } from "effect";
import type { ProfileExtensionInvalid } from "../domain/profile";
import type { ProfileFileSystemError } from "../profile";

/** A package id: the folder name under `extensions/`, in lowercase kebab-case. */
export const ExtensionId = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));

export type ExtensionKind = "skill" | "code" | "skill+code";

/** Where a package comes from: compiled into Ziggy, or only on this Profile's shelf. */
export type ExtensionSource = "bundled" | "profile";

/** One Pi package, read and checked from disk. */
export interface ExtensionPackage {
  readonly id: string;
  readonly description: string;
  readonly packagePath: string;
  readonly extensionPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly automations: ReadonlyArray<{ readonly id: string; readonly path: string }>;
  readonly kind: ExtensionKind;
  readonly required: boolean;
}

/** A package as `extensions list` and `extensions show` describe it. */
export interface ExtensionListing {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly kind: ExtensionKind;
  readonly required: boolean;
  readonly source: ExtensionSource;
  readonly packagePath: string;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly extensionPaths: ReadonlyArray<string>;
}

/** A package a Profile may select. */
export interface ExtensionChoice {
  readonly id: string;
  readonly description: string;
  readonly kind: ExtensionKind;
  readonly source: ExtensionSource;
}

export interface ExtensionSelection {
  readonly available: ReadonlyArray<ExtensionChoice>;
  readonly selected: ReadonlyArray<string>;
  readonly required: ReadonlyArray<string>;
}

export interface ExtensionMutation {
  readonly id: string;
  readonly profilePath: string;
  readonly changed: boolean;
  readonly selected: boolean;
  /** Automations the package declares that were installed, resumed or paused. */
  readonly automations: ReadonlyArray<string>;
}

export interface ExtensionSetResult {
  readonly changed: boolean;
  readonly selected: ReadonlyArray<string>;
}

export interface ExtensionDiagnostic {
  readonly source: string;
  readonly message: string;
}

/** A selected package Pi could not load; the session opens without it. */
export interface SkippedPackage {
  readonly id: string;
  readonly diagnostics: ReadonlyArray<ExtensionDiagnostic>;
}

export interface ExtensionCheck {
  readonly extensionPathCount: number;
  readonly skillPathCount: number;
  readonly extensionFactoryCount: number;
  readonly skipped: ReadonlyArray<SkippedPackage>;
}

export interface ExtensionValidation {
  readonly selected: ReadonlyArray<string>;
  readonly preflight: Omit<ExtensionCheck, "skipped">;
}

export interface ExtensionHealth {
  readonly listing: ExtensionSelection;
  readonly skipped: ReadonlyArray<SkippedPackage>;
}

export interface ExtensionUpdateResult {
  readonly id: string;
  readonly profilePath: string;
  readonly status: "updated" | "current" | "adopted";
  readonly previousHash: string;
  readonly contentHash: string;
}

/** Pi reported problems it could not pin on one optional package, or a package being added. */
export class ExtensionLoadFailed extends Schema.TaggedErrorClass<ExtensionLoadFailed>()(
  "ExtensionLoadFailed",
  {
    profilePath: Schema.String,
    stage: Schema.Literals(["resources", "extensions", "skills", "services"]),
    message: Schema.String,
    diagnostics: Schema.Array(Schema.Struct({ source: Schema.String, message: Schema.String })),
    cause: Schema.Defect(),
  },
) {}

/** Another writer held the Profile's extension lock for too long. */
export class ExtensionLockFailed extends Schema.TaggedErrorClass<ExtensionLockFailed>()(
  "ExtensionLockFailed",
  {
    profilePath: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ExtensionUpdateError extends Schema.TaggedErrorClass<ExtensionUpdateError>()(
  "ExtensionUpdateError",
  {
    profilePath: Schema.String,
    id: Schema.String,
    reason: Schema.Literals([
      "unsupported",
      "unmanaged",
      "modified",
      "automation",
      "filesystem",
      "resident",
    ]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** What opening a session can fail with because of its packages. */
export type ExtensionRuntimeError =
  | ProfileExtensionInvalid
  | ProfileFileSystemError
  | ExtensionLoadFailed;

export type ExtensionError = ExtensionRuntimeError | ExtensionLockFailed;
