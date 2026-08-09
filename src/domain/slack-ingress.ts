import { Schema } from "effect";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));

export const SlackIngressPayload = Schema.Struct({
  chatKey: NonEmpty,
  channel: NonEmpty,
  context: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("user"), userId: NonEmpty }),
    Schema.Struct({ kind: Schema.Literal("group"), groupId: NonEmpty }),
  ]),
  statusThreadTs: NonEmpty,
  sourceTs: NonEmpty,
  text: NonEmpty,
  threadTs: Schema.optional(NonEmpty),
});
export type SlackIngressPayload = typeof SlackIngressPayload.Type;

export const SlackIngressRecord = Schema.Struct({
  eventId: Schema.optional(NonEmpty),
  payload: SlackIngressPayload,
});
export type SlackIngressRecord = typeof SlackIngressRecord.Type;

export const SlackIngressTerminalState = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export type SlackIngressTerminalState = typeof SlackIngressTerminalState.Type;

export class SlackIngressDatabaseError extends Schema.TaggedErrorClass<SlackIngressDatabaseError>()(
  "SlackIngressDatabaseError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}
