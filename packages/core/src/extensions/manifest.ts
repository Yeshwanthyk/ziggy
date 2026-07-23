import { Effect, Schema } from "effect";
import { isCanonicalSemVer, isCanonicalSemVerRange } from "./semver.ts";
import { isStrictJson } from "./strict-json.ts";

const IdentifierSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
const NonEmptyStringSchema = Schema.String.check(Schema.isNonEmpty());
const utf8Encoder = new TextEncoder();
const ProcessArgumentSchema = NonEmptyStringSchema.check(
  Schema.makeFilter(hasNoNul, { expected: "a non-empty process argument without NUL bytes" }),
);
const ExecutableReferenceSchema = NonEmptyStringSchema.check(
  Schema.makeFilter(isExecutableReference, {
    expected: "a bare executable name or confined package-relative executable",
  }),
);
const RelativePathSchema = NonEmptyStringSchema.check(
  Schema.makeFilter(isConfinedRelativePath, {
    expected: "a normalized relative path confined to the Extension root",
  }),
);
const ArgvSchema = Schema.Array(ProcessArgumentSchema).check(Schema.isNonEmpty());
export const EXTENSION_COMMAND_MAX_ARGUMENTS = 64;
export const EXTENSION_COMMAND_MAX_ARGUMENT_BYTES = 16 * 1024;
const CommandArgvSchema = ArgvSchema.check(
  Schema.makeFilter(commandArgvIsBounded, {
    expected: `at most ${EXTENSION_COMMAND_MAX_ARGUMENTS} arguments and ${EXTENSION_COMMAND_MAX_ARGUMENT_BYTES} aggregate UTF-8 bytes`,
  }),
);
const CommandTimeoutSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(300_000),
);

const ExtensionResourceSchema = Schema.Struct({
  id: IdentifierSchema,
  path: RelativePathSchema,
});

const ExtensionCommandSchema = Schema.Struct({
  id: IdentifierSchema,
  description: NonEmptyStringSchema,
  argv: CommandArgvSchema,
  argumentMode: Schema.Literals(["none", "append"]),
  cwd: Schema.Literals(["extension", "profile"]),
  timeoutMs: CommandTimeoutSchema,
});

const ExtensionManifestFields = {
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
    commands: Schema.Array(ExecutableReferenceSchema),
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
};

const ExtensionManifestV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  ...ExtensionManifestFields,
});
const ExtensionManifestV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  ...ExtensionManifestFields,
  commands: Schema.Array(ExtensionCommandSchema),
});
const ExtensionManifestModel = Schema.Union([ExtensionManifestV1, ExtensionManifestV2]).check(
  Schema.makeFilter(hasValidManifestSemantics, {
    expected: "a canonical internally consistent Extension manifest",
  }),
);

export const ExtensionManifestSchema = ExtensionManifestModel;
export type ExtensionManifest = typeof ExtensionManifestSchema.Type;
export type ExtensionCommand = typeof ExtensionCommandSchema.Type;

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

function commandArgvIsBounded(argv: ReadonlyArray<string>): boolean {
  return (
    argv.length <= EXTENSION_COMMAND_MAX_ARGUMENTS &&
    argv.reduce((total, argument) => total + utf8Encoder.encode(argument).byteLength, 0) <=
      EXTENSION_COMMAND_MAX_ARGUMENT_BYTES
  );
}

function hasValidManifestSemantics(manifest: typeof ExtensionManifestModel.Type): boolean {
  const commands = manifest.schemaVersion === 2 ? manifest.commands : [];
  const sessionToolIds = [
    ...(manifest.tools ?? []).map((tool) => tool.id),
    ...commands.map((command) => command.id),
  ];
  return (
    (manifest.skills.length > 0 || manifest.tools !== undefined || commands.length > 0) &&
    resourcesHaveValidIdentities(manifest.skills, "skills") &&
    (manifest.tools === undefined || resourcesHaveValidIdentities(manifest.tools, "tools")) &&
    isStrictlySortedUnique(commands, (command) => command.id) &&
    new Set(sessionToolIds).size === sessionToolIds.length &&
    isStrictlySortedUnique(manifest.requires.env) &&
    isStrictlySortedUnique(manifest.requires.commands) &&
    isStrictlySortedUnique(manifest.requires.os) &&
    isStrictlySortedUnique(manifest.permissions.secrets) &&
    (manifest.defaults?.model === undefined || manifest.defaults.provider !== undefined) &&
    manifest.permissions.secrets.every((secret) => manifest.requires.env.includes(secret)) &&
    setupCommandsAreDeclared(manifest) &&
    commands.every(
      (command) =>
        (isConfinedPackageExecutable(command.argv[0] ?? "") ||
          (isBareExecutableName(command.argv[0] ?? "") &&
            manifest.requires.commands.includes(command.argv[0] ?? ""))) &&
        (command.cwd !== "profile" ||
          manifest.permissions.filesystem === "profile" ||
          manifest.permissions.filesystem === "full"),
    )
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
    if (executable === undefined) return false;
    if (isConfinedPackageExecutable(executable)) return true;
    return isBareExecutableName(executable) && manifest.requires.commands.includes(executable);
  });
}

function isExecutableReference(executable: string): boolean {
  return isBareExecutableName(executable) || isConfinedPackageExecutable(executable);
}

function isBareExecutableName(executable: string): boolean {
  return (
    executable.length > 0 &&
    executable !== "." &&
    executable !== ".." &&
    hasNoNul(executable) &&
    !executable.includes("/") &&
    !executable.includes("\\") &&
    !executable.includes(":")
  );
}

function isConfinedPackageExecutable(executable: string): boolean {
  return (
    executable.includes("/") &&
    hasNoNul(executable) &&
    !executable.includes(":") &&
    isConfinedRelativePath(executable)
  );
}

function hasNoNul(value: string): boolean {
  return !value.includes("\0");
}

function resourcesHaveValidIdentities(
  resources: ReadonlyArray<typeof ExtensionResourceSchema.Type>,
  root: "skills" | "tools",
): boolean {
  return (
    isStrictlySortedUnique(resources, (resource) => resource.id) &&
    resources.every((resource) => resource.path === `${root}/${resource.id}`)
  );
}

function isStrictlySortedUnique<Value>(
  values: ReadonlyArray<Value>,
  key: (value: Value) => string = String,
): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareUtf8Bytes(key(previous), key(current)) >= 0
    )
      return false;
  }
  return true;
}

function compareUtf8Bytes(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) continue;
    if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
  }
  return leftBytes.length < rightBytes.length ? -1 : leftBytes.length > rightBytes.length ? 1 : 0;
}
