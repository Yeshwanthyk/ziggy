import { Effect, Schema } from "effect";
import { isStrictJson } from "./strict-json.ts";

const NonEmptyStringSchema = Schema.String.check(Schema.isNonEmpty());
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const SafeCatalogPathSchema = NonEmptyStringSchema.check(
  Schema.makeFilter(isSafeCatalogPath, {
    expected: "an NFC-normalized confined POSIX file path",
  }),
);

const ExtensionProvenanceFileSchema = Schema.Struct({
  path: SafeCatalogPathSchema,
  kind: NonEmptyStringSchema,
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  sha256: Sha256Schema,
});

const ExtensionProvenanceModel = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  extensionId: NonEmptyStringSchema,
  extensionVersion: NonEmptyStringSchema,
  source: Schema.Struct({
    kind: NonEmptyStringSchema,
    locator: NonEmptyStringSchema,
  }),
  trustTier: Schema.Literals(["builtin", "verified", "community"]),
  verification: Schema.Struct({
    method: NonEmptyStringSchema,
    keyId: Schema.String,
    signature: Schema.String,
  }),
  files: Schema.Array(ExtensionProvenanceFileSchema).check(
    Schema.makeFilter(filesAreCanonical, {
      expected: "unique file records sorted by UTF-8 path bytes",
    }),
  ),
  treeDigest: Sha256Schema,
});

export const ExtensionProvenanceSchema = ExtensionProvenanceModel;
export type ExtensionProvenance = typeof ExtensionProvenanceSchema.Type;
export type ExtensionProvenanceFile = typeof ExtensionProvenanceFileSchema.Type;

const StrictJsonStringSchema = Schema.String.check(
  Schema.makeFilter(isStrictJson, {
    expected: "strict JSON without duplicate object keys",
  }),
);
const decodeStrictJsonString = Schema.decodeUnknownEffect(StrictJsonStringSchema);
const decodeProvenanceJsonString = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExtensionProvenanceSchema),
  { errors: "all", onExcessProperty: "error" },
);

export function decodeExtensionProvenanceJson(input: unknown) {
  return decodeStrictJsonString(input).pipe(Effect.flatMap(decodeProvenanceJsonString));
}

function isSafeCatalogPath(path: string): boolean {
  if (path !== path.normalize("NFC") || path.startsWith("/") || path.includes("\\")) return false;
  const components = path.split("/");
  return components.every(
    (component) => component !== "" && component !== "." && component !== "..",
  );
}

function filesAreCanonical(
  files: ReadonlyArray<typeof ExtensionProvenanceFileSchema.Type>,
): boolean {
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (previous === undefined || current === undefined) return false;
    if (Buffer.compare(Buffer.from(previous.path), Buffer.from(current.path)) >= 0) return false;
  }
  return true;
}
