import { Schema } from "effect";
import { UiGatewayMessage, UiGroupRecord, UiPin } from "./ui-gateway";

export const UiStateVersion = Schema.Literal(1);
export const UiCommandFingerprint = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
);

export const UiPinState = Schema.Struct({
  version: UiStateVersion,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pins: Schema.Array(UiPin).check(Schema.isMaxLength(256)),
  commands: Schema.Array(
    Schema.Struct({
      commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      fingerprint: UiCommandFingerprint,
      revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ).check(Schema.isMaxLength(128)),
});
export type UiPinState = typeof UiPinState.Type;

export const UiGroupState = Schema.Struct({
  version: UiStateVersion,
  groups: Schema.Array(UiGroupRecord).check(Schema.isMaxLength(256)),
  commands: Schema.Array(
    Schema.Struct({
      commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      fingerprint: UiCommandFingerprint,
      groupId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ).check(Schema.isMaxLength(128)),
});
export type UiGroupState = typeof UiGroupState.Type;

export class UiStateReadError extends Schema.TaggedErrorClass<UiStateReadError>()(
  "UiStateReadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    message: UiGatewayMessage,
    cause: Schema.Defect(),
  },
) {}

export class UiStateWriteError extends Schema.TaggedErrorClass<UiStateWriteError>()(
  "UiStateWriteError",
  {
    operation: Schema.Literals(["mkdir", "write", "rename"]),
    message: UiGatewayMessage,
    cause: Schema.Defect(),
  },
) {}

export class UiStateConflict extends Schema.TaggedErrorClass<UiStateConflict>()("UiStateConflict", {
  expectedRevision: Schema.Int,
  actualRevision: Schema.Int,
  message: UiGatewayMessage,
}) {}

export class UiStateCommandConflict extends Schema.TaggedErrorClass<UiStateCommandConflict>()(
  "UiStateCommandConflict",
  { commandId: Schema.String, message: UiGatewayMessage },
) {}

export class UiGroupNotFound extends Schema.TaggedErrorClass<UiGroupNotFound>()("UiGroupNotFound", {
  groupId: Schema.String,
  message: UiGatewayMessage,
}) {}
