import { Schema } from "effect";
import catalogJson from "../catalog.json" with { type: "json" };
import { ExtensionCatalog } from "./domain/extension-catalog";
import {
  BUILTIN_CORE_SKILLS,
  BUILTIN_PACKAGE_METADATA,
} from "./generated/builtin-catalog-metadata";

export {
  APPROVED_BUNDLED_EXTENSION_IDS,
  BUILTIN_CATALOG_FINGERPRINT,
  BUILTIN_CORE_SKILLS,
  BUILTIN_PACKAGE_METADATA,
} from "./generated/builtin-catalog-metadata";

/** The single checked and embedded authority for approved extension IDs. */
export const BUILTIN_EXTENSION_CATALOG: ExtensionCatalog =
  Schema.decodeUnknownSync(ExtensionCatalog)(catalogJson);

export type BuiltinPackageMetadata = (typeof BUILTIN_PACKAGE_METADATA)[number];

export const bundledPackageMetadata = (id: string): BuiltinPackageMetadata | undefined =>
  BUILTIN_PACKAGE_METADATA.find((entry) => entry.id === id);

export interface BundledSkill {
  readonly id: string;
  readonly logicalPath: string;
  readonly files: ReadonlyArray<string>;
  readonly required: boolean;
}

const bundledSkillEntries = (): ReadonlyArray<BundledSkill> => {
  const byId = new Map<string, BundledSkill>();
  for (const pkg of BUILTIN_PACKAGE_METADATA) {
    for (const skill of pkg.skills) {
      if (byId.has(skill.name)) continue;
      byId.set(skill.name, {
        id: skill.name,
        logicalPath: skill.logicalPath,
        files: skill.files,
        required: pkg.required,
      });
    }
  }
  for (const skill of BUILTIN_CORE_SKILLS) {
    if (byId.has(skill.id)) continue;
    byId.set(skill.id, {
      id: skill.id,
      logicalPath: skill.logicalPath,
      files: skill.files,
      required: true,
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

export const BUNDLED_SKILLS: ReadonlyArray<BundledSkill> = bundledSkillEntries();

export const bundledSkill = (id: string): BundledSkill | undefined =>
  BUNDLED_SKILLS.find((skill) => skill.id === id);
