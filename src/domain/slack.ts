import { Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const SlackChannelMode = Schema.Literals(["mention", "always"]);
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{8,31}$/;

export const SlackChannelPolicies = Schema.Record(Schema.String, SlackChannelMode).check(
  Schema.makeFilter(
    (channels) => Object.keys(channels).every((channel) => SLACK_CHANNEL_ID.test(channel)),
    { expected: "Slack channel IDs as policy keys" },
  ),
);

export const SlackGatewayConfig = Schema.Struct({
  botToken: NonEmptyString,
  appToken: NonEmptyString,
  ownerUserId: NonEmptyString,
  channels: Schema.optional(SlackChannelPolicies),
});

export type SlackGatewayConfig = typeof SlackGatewayConfig.Type;

export const decodeSlackGatewayConfigJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SlackGatewayConfig),
  { onExcessProperty: "error" },
);
