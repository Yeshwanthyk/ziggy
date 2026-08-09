import { Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const SlackChannelMode = Schema.Literals(["mention", "always"]);

export const SlackGatewayConfig = Schema.Struct({
  botToken: NonEmptyString,
  appToken: NonEmptyString,
  ownerUserId: NonEmptyString,
  channelMode: Schema.optional(SlackChannelMode),
});

export type SlackGatewayConfig = typeof SlackGatewayConfig.Type;

export const decodeSlackGatewayConfigJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SlackGatewayConfig),
  { onExcessProperty: "error" },
);
