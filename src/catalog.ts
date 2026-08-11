import { Schema } from "effect";
import catalogJson from "../catalog.json" with { type: "json" };
import { ExtensionCatalog } from "./domain/extension-catalog";

/** The single checked and embedded authority for approved extension IDs. */
export const BUILTIN_EXTENSION_CATALOG: ExtensionCatalog =
  Schema.decodeUnknownSync(ExtensionCatalog)(catalogJson);

export const APPROVED_BUNDLED_EXTENSION_IDS: ReadonlySet<string> = new Set(
  BUILTIN_EXTENSION_CATALOG.extensions.flatMap((entry) =>
    entry.source === "bundled" ? [entry.id] : [],
  ),
);
