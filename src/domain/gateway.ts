import { Schema } from "effect";

export class GatewayConfigError extends Schema.TaggedErrorClass<GatewayConfigError>()(
  "GatewayConfigError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const GatewayOwnerStatus = Schema.Union([
  Schema.TaggedStruct("stopped", { path: Schema.String }),
  Schema.TaggedStruct("running", {
    path: Schema.String,
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    acquiredAt: Schema.String,
  }),
  Schema.TaggedStruct("stale", {
    path: Schema.String,
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    acquiredAt: Schema.String,
  }),
]);
export type GatewayOwnerStatus = typeof GatewayOwnerStatus.Type;

export class GatewayOwnerError extends Schema.TaggedErrorClass<GatewayOwnerError>()(
  "GatewayOwnerError",
  {
    reason: Schema.Literals(["held", "stale", "unreadable", "filesystem"]),
    path: Schema.String,
    pid: Schema.UndefinedOr(Schema.Finite),
    message: Schema.String,
    cause: Schema.UndefinedOr(Schema.Defect()),
  },
) {}
