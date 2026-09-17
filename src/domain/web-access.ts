import { Schema } from "effect";

const Port = Schema.Int.check(
  Schema.makeFilter((value) => value >= 0 && value <= 65_535, {
    expected: "a TCP port or zero for automatic legacy binding",
  }),
);

export const WebAccessConfig = Schema.Struct({
  version: Schema.Literal(1),
  port: Port,
  publicUrl: Schema.optionalKey(Schema.String),
});

export type WebAccessConfig = typeof WebAccessConfig.Type;

export class WebAccessError extends Schema.TaggedErrorClass<WebAccessError>()("WebAccessError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface WebPairing {
  readonly url: string;
  readonly expiresAt: string;
}
