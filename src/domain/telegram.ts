import { Schema } from "effect";

const TelegramUserId = Schema.Finite.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0, {
    expected: "a positive safe integer Telegram user ID",
  }),
);

export const TelegramGatewayConfig = Schema.Struct({
  botToken: Schema.String.check(Schema.isMinLength(1)),
  ownerUserId: TelegramUserId,
});

export type TelegramGatewayConfig = typeof TelegramGatewayConfig.Type;

export const decodeTelegramGatewayConfigJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(TelegramGatewayConfig),
  { onExcessProperty: "error" },
);
