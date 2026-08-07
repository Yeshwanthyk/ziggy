import { Schema } from "effect";

export class GatewayConfigError extends Schema.TaggedErrorClass<GatewayConfigError>()(
  "GatewayConfigError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

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
