import { Effect, Schema } from "effect";

const GatewayId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const Timeout = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(50),
);

const TelegramGatewayConfigSchema = Schema.Struct({
  gatewayId: GatewayId,
  resumeGranularity: Schema.Literals(["conversation", "peer"]),
  longPollTimeoutSeconds: Schema.optional(Timeout),
});
const TelegramCredentialsSchema = Schema.Struct({ botToken: NonEmpty });

type TelegramGatewayConfigInput = typeof TelegramGatewayConfigSchema.Type;
export type TelegramGatewayConfig = Omit<TelegramGatewayConfigInput, "longPollTimeoutSeconds"> & {
  readonly longPollTimeoutSeconds: number;
};
export type TelegramCredentials = typeof TelegramCredentialsSchema.Type;

export class TelegramConfigError extends Schema.TaggedErrorClass<TelegramConfigError>()(
  "TelegramConfigError",
  { message: Schema.String },
) {}
export class TelegramCredentialsError extends Schema.TaggedErrorClass<TelegramCredentialsError>()(
  "TelegramCredentialsError",
  { message: Schema.String },
) {}

const decodeConfig = Schema.decodeUnknownEffect(TelegramGatewayConfigSchema, {
  onExcessProperty: "error",
});
const decodeCredentials = Schema.decodeUnknownEffect(TelegramCredentialsSchema, {
  onExcessProperty: "error",
});

export const decodeTelegramGatewayConfig = (
  input: unknown,
): Effect.Effect<TelegramGatewayConfig, TelegramConfigError> =>
  decodeConfig(input).pipe(
    Effect.map((config) => ({
      ...config,
      longPollTimeoutSeconds: config.longPollTimeoutSeconds ?? 30,
    })),
    Effect.mapError(() => new TelegramConfigError({ message: "Invalid Telegram Gateway config" })),
  );

export const decodeTelegramCredentials = (
  input: unknown,
): Effect.Effect<TelegramCredentials, TelegramCredentialsError> =>
  decodeCredentials(input).pipe(
    Effect.mapError(
      () => new TelegramCredentialsError({ message: "Invalid Telegram credentials" }),
    ),
  );
