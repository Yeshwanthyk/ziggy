import { Schema } from "effect";

const DiscordUserId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((value) => /^[0-9]+$/.test(value), {
    expected: "a non-empty ASCII digit Discord user ID",
  }),
);

export const DiscordGatewayConfig = Schema.Struct({
  botToken: Schema.String.check(Schema.isMinLength(1)),
  ownerUserId: DiscordUserId,
});

export type DiscordGatewayConfig = typeof DiscordGatewayConfig.Type;

export const decodeDiscordGatewayConfigJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DiscordGatewayConfig),
  { onExcessProperty: "error" },
);
