import { Effect, Schema } from "effect";
import { isStrictJson } from "./strict-json.ts";

export const ExtensionEnabledStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  extensionId: Schema.String,
  enabled: Schema.Boolean,
});

export type ExtensionEnabledState = typeof ExtensionEnabledStateSchema.Type;

const StrictJsonStringSchema = Schema.String.check(
  Schema.makeFilter(isStrictJson, {
    expected: "strict JSON without duplicate object keys",
  }),
);
const decodeStrictJsonString = Schema.decodeUnknownEffect(StrictJsonStringSchema);
const decodeEnabledStateJsonString = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExtensionEnabledStateSchema),
  { errors: "all", onExcessProperty: "error" },
);

export function decodeExtensionEnabledStateJson(input: unknown) {
  return decodeStrictJsonString(input).pipe(Effect.flatMap(decodeEnabledStateJsonString));
}
