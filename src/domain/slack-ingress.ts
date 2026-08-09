import { Schema } from "effect";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const BoundedText = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SlackIngressFileReference = Schema.Struct({
  id: NonEmpty.check(Schema.isMaxLength(255)),
  name: Schema.optional(BoundedText(512)),
  mimeType: Schema.optional(BoundedText(128)),
  size: Schema.optional(NonNegativeInteger),
  urlPrivate: Schema.optional(BoundedText(4_096)),
});
export type SlackIngressFileReference = typeof SlackIngressFileReference.Type;

const SlackIngressFiles = Schema.Array(SlackIngressFileReference).check(
  Schema.makeFilter((files) => files.length <= 4, { expected: "at most four Slack files" }),
);

export const SlackIngressPayload = Schema.Struct({
  chatKey: NonEmpty,
  channel: NonEmpty,
  context: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("user"), userId: NonEmpty }),
    Schema.Struct({ kind: Schema.Literal("group"), groupId: NonEmpty }),
  ]),
  files: Schema.optional(SlackIngressFiles),
  omittedFileCount: Schema.optional(NonNegativeInteger),
  statusThreadTs: NonEmpty,
  sourceTs: NonEmpty,
  text: Schema.String,
  threadTs: Schema.optional(NonEmpty),
}).check(
  Schema.makeFilter(
    (payload) =>
      payload.text.trim().length > 0 ||
      (payload.files?.length ?? 0) > 0 ||
      (payload.omittedFileCount ?? 0) > 0,
    { expected: "Slack text or attachment metadata" },
  ),
);
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
