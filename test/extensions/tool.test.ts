/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Extensions, extensionTools } from "ziggy/extensions/index";

// Pi's anthropic-messages provider sends only a tool schema's `properties` and `required`.
const BranchedToolSchema = Schema.Struct({
  properties: Schema.Record(Schema.String, Schema.Unknown),
  required: Schema.Array(Schema.String),
  anyOf: Schema.Array(Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) })),
});

const decodeBranchedToolSchema = Schema.decodeUnknownSync(BranchedToolSchema);

test("profile_extensions names every action's fields where Anthropic reads them", () => {
  const [tool] = Effect.runSync(
    extensionTools(Effect.runSync(Extensions.make))({
      profilePath: "/profiles/p",
      context: { kind: "local" },
      session: () => undefined,
      voice: () => undefined,
    }),
  );

  const schema = decodeBranchedToolSchema(tool?.parameters);

  const fields = new Set(schema.anyOf.flatMap((branch) => Object.keys(branch.properties)));

  expect(Object.keys(schema.properties).toSorted()).toEqual([...fields].toSorted());
  expect(schema.required).toEqual(["action"]);
});
