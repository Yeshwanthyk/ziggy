import { Schema } from "effect";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const BoundedText = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DiscordIngressAttachmentReference = Schema.Struct({
  id: NonEmpty.check(Schema.isMaxLength(255)),
  filename: Schema.optional(BoundedText(512)),
  mimeType: Schema.optional(BoundedText(128)),
  size: Schema.optional(NonNegativeInteger),
  url: Schema.optional(BoundedText(4_096)),
});
export type DiscordIngressAttachmentReference = typeof DiscordIngressAttachmentReference.Type;

const DiscordIngressAttachments = Schema.Array(DiscordIngressAttachmentReference).check(
  Schema.makeFilter((attachments) => attachments.length <= 4, {
    expected: "at most four Discord attachments",
  }),
);

export const DiscordIngressPayload = Schema.Struct({
  messageId: NonEmpty,
  sourceChannelId: NonEmpty,
  channelId: NonEmpty,
  guildId: Schema.optional(NonEmpty),
  authorId: NonEmpty,
  text: Schema.String,
  attachments: Schema.optional(DiscordIngressAttachments),
  omittedAttachmentCount: Schema.optional(NonNegativeInteger),
  chatKey: NonEmpty,
  context: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("user"), userId: NonEmpty }),
    Schema.Struct({ kind: Schema.Literal("group"), groupId: NonEmpty }),
  ]),
}).check(
  Schema.makeFilter(
    (payload) =>
      payload.text.trim().length > 0 ||
      (payload.attachments?.length ?? 0) > 0 ||
      (payload.omittedAttachmentCount ?? 0) > 0,
    { expected: "Discord text or attachment metadata" },
  ),
);
export type DiscordIngressPayload = typeof DiscordIngressPayload.Type;

export const DiscordIngressTerminalState = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export type DiscordIngressTerminalState = typeof DiscordIngressTerminalState.Type;

export class DiscordIngressDatabaseError extends Schema.TaggedErrorClass<DiscordIngressDatabaseError>()(
  "DiscordIngressDatabaseError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}
