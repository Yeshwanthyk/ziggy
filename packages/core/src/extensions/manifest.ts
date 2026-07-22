import { Effect, Schema } from "effect";
import { isCanonicalSemVer, isCanonicalSemVerRange } from "./semver.ts";
import { isStrictJson } from "./strict-json.ts";

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
    Schema.makeFilter(isCanonicalSemVer, { expected: "a canonical SemVer 2 version" }),
  ),
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  ziggy: Schema.Struct({
    requires: NonEmptyStringSchema.check(
      Schema.makeFilter(isCanonicalSemVerRange, {
        expected: "a canonical Ziggy version range",
      }),
    ),
  }),
  defaults: Schema.optional(
    Schema.Struct({
      provider: Schema.optional(NonEmptyStringSchema),
      model: Schema.optional(NonEmptyStringSchema),
      thinkingLevel: Schema.optional(Schema.Literals(["low", "medium", "high"])),
    }),
  ),
  skills: Schema.Array(ExtensionResourceSchema),
  tools: Schema.optional(Schema.Array(ExtensionResourceSchema).check(Schema.isNonEmpty())),
  adapters: Schema.Tuple([]),
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
  requires: Schema.Struct({
    env: Schema.Array(NonEmptyStringSchema),
    commands: Schema.Array(NonEmptyStringSchema),
    os: Schema.Array(Schema.Literals(["darwin", "linux", "win32"])),
  }),
  permissions: Schema.Struct({
    network: Schema.Boolean,
    filesystem: Schema.Literals(["none", "profile", "full"]),
    secrets: Schema.Array(NonEmptyStringSchema),
  }),
  distribution: Schema.Struct({
    source: NonEmptyStringSchema,
    license: NonEmptyStringSchema,
  }),
}).check(
  Schema.makeFilter(hasValidManifestSemantics, {
    expected: "a canonical internally consistent Extension manifest",
  }),
);

export const ExtensionManifestSchema = ExtensionManifestModel;
export type ExtensionManifest = typeof ExtensionManifestSchema.Type;

export const decodeExtensionManifest = Schema.decodeUnknownEffect(ExtensionManifestSchema, {
  errors: "all",
  onExcessProperty: "error",
});
const StrictJsonStringSchema = Schema.String.check(
  Schema.makeFilter(isStrictJson, {
    expected: "strict JSON without duplicate object keys",
  }),
);
const decodeStrictJsonString = Schema.decodeUnknownEffect(StrictJsonStringSchema);
const decodeManifestJsonString = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExtensionManifestSchema),
  { errors: "all", onExcessProperty: "error" },
);

export function decodeExtensionManifestJson(input: unknown) {
  return decodeStrictJsonString(input).pipe(Effect.flatMap(decodeManifestJsonString));
}

function isConfinedRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasValidManifestSemantics(manifest: typeof ExtensionManifestModel.Type): boolean {
  return (
    (manifest.skills.length > 0 || manifest.tools !== undefined) &&
    resourcesHaveValidIdentities(manifest.skills, "skills") &&
    (manifest.tools === undefined || resourcesHaveValidIdentities(manifest.tools, "tools")) &&
    (manifest.defaults?.model === undefined || manifest.defaults.provider !== undefined) &&
    manifest.permissions.secrets.every((secret) => manifest.requires.env.includes(secret)) &&
    setupCommandsAreDeclared(manifest)
  );
}

function setupCommandsAreDeclared(manifest: typeof ExtensionManifestModel.Type): boolean {
  if (manifest.setup === undefined) return true;
  const argvEntries = [
    ...manifest.setup.steps.map((step) => step.argv),
    ...(manifest.setup.doctor === undefined ? [] : [manifest.setup.doctor.argv]),
  ];
  return argvEntries.every((argv) => {
    const executable = argv[0];
    return executable !== undefined && manifest.requires.commands.includes(executable);
  });
}

function resourcesHaveValidIdentities(
  resources: ReadonlyArray<typeof ExtensionResourceSchema.Type>,
  root: "skills" | "tools",
): boolean {
  const ids = new Set<string>();
  for (const resource of resources) {
    if (ids.has(resource.id) || resource.path !== `${root}/${resource.id}`) return false;
    ids.add(resource.id);
  }
  return true;
}
