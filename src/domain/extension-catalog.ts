import { Schema } from "effect";

const ExtensionId = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));

const NonEmpty = Schema.String.check(Schema.isMinLength(1));

const CatalogEntryFields = {
  id: ExtensionId,
  version: NonEmpty,
};

export const BundledExtensionCatalogEntry = Schema.Struct({
  ...CatalogEntryFields,
  source: Schema.Literal("bundled"),
  path: Schema.String.check(Schema.isPattern(/^\.\/extensions\/[a-z0-9-]+$/)),
});

export const ExtensionCatalog = Schema.Struct({
  version: Schema.Literal(1),
  extensions: Schema.Array(BundledExtensionCatalogEntry),
}).check(
  Schema.makeFilter(
    (value) =>
      new Set(value.extensions.map((entry) => entry.id)).size === value.extensions.length &&
      value.extensions.every((entry) => entry.path === `./extensions/${entry.id}`),
    { expected: "an extension catalog with unique IDs and matching package paths" },
  ),
);

export type BundledExtensionCatalogEntry = typeof BundledExtensionCatalogEntry.Type;

export type ExtensionCatalog = typeof ExtensionCatalog.Type;

export class ExtensionCatalogInvalid extends Schema.TaggedErrorClass<ExtensionCatalogInvalid>()(
  "ExtensionCatalogInvalid",
  {
    source: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ExtensionCatalogInstallFailed extends Schema.TaggedErrorClass<ExtensionCatalogInstallFailed>()(
  "ExtensionCatalogInstallFailed",
  {
    id: ExtensionId,
    path: Schema.String,
    reason: Schema.Literals(["validation", "filesystem"]),
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
