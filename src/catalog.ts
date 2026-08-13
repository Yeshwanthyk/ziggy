import { Schema } from "effect";
import catalogJson from "../catalog.json" with { type: "json" };
import { ExtensionCatalog } from "./domain/extension-catalog";
import { BUILTIN_PACKAGE_METADATA } from "./generated/builtin-catalog-metadata";

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
