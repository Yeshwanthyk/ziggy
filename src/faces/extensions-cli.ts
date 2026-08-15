import { Schema } from "effect";

const ExtensionSkillJson = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
});

export const ExtensionCatalogListingJson = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  description: Schema.String,
  kind: Schema.Literals(["skill", "code", "skill+code", "remote"]),
  required: Schema.Boolean,
  source: Schema.Literals(["bundled", "remote-approved"]),
  installed: Schema.Boolean,
  packagePath: Schema.optional(Schema.String),
  skills: Schema.optional(Schema.Array(ExtensionSkillJson)),
  extensionPaths: Schema.optional(Schema.Array(Schema.String)),
});
export type ExtensionCatalogListingJson = typeof ExtensionCatalogListingJson.Type;

export const ExtensionsJson = Schema.Array(ExtensionCatalogListingJson);
export type ExtensionsJson = typeof ExtensionsJson.Type;
const encodeExtensions = Schema.encodeSync(ExtensionsJson);
const encodeExtension = Schema.encodeSync(ExtensionCatalogListingJson);

export const renderExtensionsJson = (
  extensions: ReadonlyArray<ExtensionCatalogListingJson>,
): string => JSON.stringify(encodeExtensions(extensions));

export const renderExtensionJson = (extension: ExtensionCatalogListingJson): string =>
  JSON.stringify(encodeExtension(extension));

export const renderExtensionListingsJson = renderExtensionsJson;
