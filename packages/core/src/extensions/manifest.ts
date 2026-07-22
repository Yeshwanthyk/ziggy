import { Schema } from "effect";

const IdentifierSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
const NonEmptyStringSchema = Schema.String.check(Schema.isNonEmpty());
const RelativePathSchema = NonEmptyStringSchema.check(
  Schema.makeFilter(isConfinedRelativePath, {
    expected: "a normalized relative path confined to the Extension root",
  }),
);
const ArgvSchema = Schema.Array(NonEmptyStringSchema).check(Schema.isNonEmpty());

const ExtensionResourceSchema = Schema.Struct({
  id: IdentifierSchema,
  path: RelativePathSchema,
});

const ExtensionManifestModel = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: IdentifierSchema,
  version: NonEmptyStringSchema.check(
    Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
  ),
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  ziggy: Schema.Struct({
    requires: NonEmptyStringSchema,
  }),
  defaults: Schema.optional(
    Schema.Struct({
      provider: Schema.optional(NonEmptyStringSchema),
      model: Schema.optional(NonEmptyStringSchema),
      thinkingLevel: Schema.optional(Schema.Literals(["low", "medium", "high"])),
    }),
  ),
  skills: Schema.Array(ExtensionResourceSchema),
  tools: Schema.optional(Schema.Array(ExtensionResourceSchema)),
  adapters: Schema.optional(Schema.Tuple([])),
  setup: Schema.optional(
    Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          argv: ArgvSchema,
        }),
      ),
      doctor: Schema.optional(
        Schema.Struct({
          argv: ArgvSchema,
        }),
      ),
    }),
  ),
  requires: Schema.optional(
    Schema.Struct({
      env: Schema.Array(NonEmptyStringSchema),
      commands: Schema.Array(NonEmptyStringSchema),
      os: Schema.Array(Schema.Literals(["darwin", "linux", "win32"])),
    }),
  ),
  permissions: Schema.optional(
    Schema.Struct({
      network: Schema.Boolean,
      filesystem: Schema.Literals(["none", "profile", "full"]),
      secrets: Schema.Array(NonEmptyStringSchema),
    }),
  ),
  distribution: Schema.optional(
    Schema.Struct({
      source: NonEmptyStringSchema,
      license: NonEmptyStringSchema,
    }),
  ),
  provenance: Schema.optional(
    Schema.Struct({
      origin: NonEmptyStringSchema,
      signature: NonEmptyStringSchema,
    }),
  ),
}).check(
  Schema.makeFilter(hasValidResourceIdentities, {
    expected: "unique resource IDs matching their path basenames",
  }),
);

export const ExtensionManifestSchema = ExtensionManifestModel;
export type ExtensionManifest = typeof ExtensionManifestSchema.Type;

export const decodeExtensionManifest = Schema.decodeUnknownEffect(ExtensionManifestSchema, {
  errors: "all",
  onExcessProperty: "error",
});
export const decodeExtensionManifestJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExtensionManifestSchema),
  { errors: "all", onExcessProperty: "error" },
);

function isConfinedRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasValidResourceIdentities(manifest: typeof ExtensionManifestModel.Type): boolean {
  return (
    resourcesHaveValidIdentities(manifest.skills) &&
    (manifest.tools === undefined || resourcesHaveValidIdentities(manifest.tools))
  );
}

function resourcesHaveValidIdentities(
  resources: ReadonlyArray<typeof ExtensionResourceSchema.Type>,
): boolean {
  const ids = new Set<string>();
  for (const resource of resources) {
    if (ids.has(resource.id) || pathBasename(resource.path) !== resource.id) return false;
    ids.add(resource.id);
  }
  return true;
}

function pathBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
