import { Schema } from "effect";

export class GatewayConfigError extends Schema.TaggedErrorClass<GatewayConfigError>()(
  "GatewayConfigError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}
