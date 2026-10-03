import { Schema } from "effect";

export class ZiggyUpdateUnavailable extends Schema.TaggedErrorClass<ZiggyUpdateUnavailable>()(
  "ZiggyUpdateUnavailable",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}
