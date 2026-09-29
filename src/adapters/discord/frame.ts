import { Schema } from "effect";

const Integer = Schema.Finite.check(Schema.isInt());

const GatewayFrameSchema = Schema.Struct({
  op: Integer,
  d: Schema.optional(Schema.Unknown),
  s: Schema.optional(Schema.NullOr(Integer)),
  t: Schema.optional(Schema.NullOr(Schema.String)),
});

const ReadySchema = Schema.Struct({
  session_id: Schema.String,
  resume_gateway_url: Schema.String,
  user: Schema.Struct({ id: Schema.String }),
  guilds: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const HelloSchema = Schema.Struct({
  heartbeat_interval: Schema.Finite.check(Schema.isGreaterThan(0)),
});

const MessageSchema = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  guild_id: Schema.optional(Schema.String),
  author: Schema.Struct({
    id: Schema.String,
    bot: Schema.optional(Schema.Boolean),
  }),
  content: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});

const MessageAttachmentSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  filename: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  content_type: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  size: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
});

const InteractionSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  type: Integer,
  guild_id: Schema.optional(Schema.String),
  channel_id: Schema.optional(Schema.String),
  channel: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      type: Integer,
      parent_id: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  member: Schema.optional(Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })),
  user: Schema.optional(Schema.Struct({ id: Schema.String })),
  data: Schema.optional(
    Schema.Struct({
      type: Integer,
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    }),
  ),
});

export const decodeGatewayFrameJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GatewayFrameSchema),
);

export const decodeReadyPayload = Schema.decodeUnknownEffect(ReadySchema);

export const decodeHelloPayload = Schema.decodeUnknownEffect(HelloSchema);

export const decodeMessagePayload = Schema.decodeUnknownEffect(MessageSchema);

export const decodeMessageAttachment = Schema.decodeUnknownEffect(MessageAttachmentSchema);

export const decodeInteractionPayload = Schema.decodeUnknownEffect(InteractionSchema);

export const normalizeGatewayFrame = (decoded: typeof GatewayFrameSchema.Type) => ({
  op: decoded.op,
  d: decoded.d,
  s: decoded.s ?? null,
  t: decoded.t ?? null,
});

export type GatewayFrame = ReturnType<typeof normalizeGatewayFrame>;
