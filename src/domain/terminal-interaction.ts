import { Schema } from "effect";

export class TerminalInteractionFailed extends Schema.TaggedErrorClass<TerminalInteractionFailed>()(
  "TerminalInteractionFailed",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}
