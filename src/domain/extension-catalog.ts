import { Schema } from "effect";

const ExtensionId = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{7,64}$/));

const CatalogEntryFields = {
  id: ExtensionId,
  version: NonEmpty,
};

export const BundledExtensionCatalogEntry = Schema.Struct({
  ...CatalogEntryFields,
  source: Schema.Literal("bundled"),
  path: Schema.String.check(Schema.isPattern(/^\.\/extensions\/[a-z0-9-]+$/)),
});

export const GitHubExtensionCatalogEntry = Schema.Struct({
  ...CatalogEntryFields,
  description: NonEmpty,
  source: Schema.Literal("github"),
  repository: Schema.String.check(Schema.isPattern(/^[^/\\s]+\/[^/\\s]+$/)),
  commit: Commit,
  path: Schema.String.check(Schema.isPattern(/^\.\/extensions\/[a-z0-9-]+$/)),
  archiveUrl: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  archiveSha256: Sha256,
});

export const ExtensionCatalogEntry = Schema.Union([
  BundledExtensionCatalogEntry,
  GitHubExtensionCatalogEntry,
]);

export const ExtensionCatalog = Schema.Struct({
  version: Schema.Literal(1),
  extensions: Schema.Array(ExtensionCatalogEntry),
}).check(
  Schema.makeFilter(
    (value) =>
      new Set(value.extensions.map((entry) => entry.id)).size === value.extensions.length &&
      value.extensions.every((entry) => entry.path === `./extensions/${entry.id}`),
    { expected: "an extension catalog with unique IDs and matching package paths" },
  ),
);

export type ExtensionCatalogEntry = typeof ExtensionCatalogEntry.Type;
export type BundledExtensionCatalogEntry = typeof BundledExtensionCatalogEntry.Type;
export type GitHubExtensionCatalogEntry = typeof GitHubExtensionCatalogEntry.Type;
export type ExtensionCatalog = typeof ExtensionCatalog.Type;

export class ExtensionCatalogInvalid extends Schema.TaggedErrorClass<ExtensionCatalogInvalid>()(
  "ExtensionCatalogInvalid",
  {
    source: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ExtensionCatalogUnavailable extends Schema.TaggedErrorClass<ExtensionCatalogUnavailable>()(
  "ExtensionCatalogUnavailable",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ExtensionCatalogInstallFailed extends Schema.TaggedErrorClass<ExtensionCatalogInstallFailed>()(
  "ExtensionCatalogInstallFailed",
  {
    id: ExtensionId,
    path: Schema.String,
    reason: Schema.Literals(["download", "checksum", "archive", "validation", "filesystem"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ZiggyUpdateUnavailable extends Schema.TaggedErrorClass<ZiggyUpdateUnavailable>()(
  "ZiggyUpdateUnavailable",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}
