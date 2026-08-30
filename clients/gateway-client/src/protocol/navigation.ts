import {
  hasOnlyKeys,
  isBoundedString,
  isCommandId,
  isProfileId,
  isRecord,
  isSafeInteger,
  type ZiggyProfileId,
} from "./common";
import { isSessionReference, type ZiggySessionRef } from "./conversations";

export interface ZiggyPin {
  readonly id: string;
  readonly ref: ZiggySessionRef;
  readonly label?: string;
  readonly order: number;
}

export interface ZiggyPinListResult {
  readonly profileId: ZiggyProfileId;
  readonly pins: ReadonlyArray<ZiggyPin>;
  readonly revision: number;
}

export interface ZiggyPinSetParams {
  readonly profileId: ZiggyProfileId;
  readonly pin: ZiggyPin;
  readonly expectedRevision: number;
  readonly commandId: string;
}

export interface ZiggyPinSetResult {
  readonly profileId: ZiggyProfileId;
  readonly revision: number;
  readonly pins: ReadonlyArray<ZiggyPin>;
}

export interface ZiggyPinRemoveParams {
  readonly profileId: ZiggyProfileId;
  readonly pinId: string;
  readonly expectedRevision: number;
  readonly commandId: string;
}

export interface ZiggyPinRemoveResult {
  readonly profileId: ZiggyProfileId;
  readonly revision: number;
  readonly pins: ReadonlyArray<ZiggyPin>;
}

export interface ZiggyNavigationRequestMap {
  readonly "pin.list": { readonly profileId: ZiggyProfileId };
  readonly "pin.set": ZiggyPinSetParams;
  readonly "pin.remove": ZiggyPinRemoveParams;
}

export interface ZiggyNavigationResultMap {
  readonly "pin.list": ZiggyPinListResult;
  readonly "pin.set": ZiggyPinSetResult;
  readonly "pin.remove": ZiggyPinRemoveResult;
}

const isPinId = (value: unknown): value is string => isBoundedString(value, 128);

const isPin = (value: unknown): value is ZiggyPin =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "ref", "label", "order"]) &&
  isPinId(value.id) &&
  isSessionReference(value.ref) &&
  isSafeInteger(value.order) &&
  value.order <= 1_000_000 &&
  (value.label === undefined || isBoundedString(value.label, 160));

export const isPinListResult = (value: unknown): value is ZiggyPinListResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "revision", "pins"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.pins) &&
  value.pins.length <= 256 &&
  value.pins.every((pin) => isPin(pin) && pin.ref.profileId === value.profileId) &&
  isSafeInteger(value.revision);

export const isPinSetResult = (value: unknown): value is ZiggyPinSetResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "revision", "pins"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.pins) &&
  value.pins.length <= 256 &&
  value.pins.every((pin) => isPin(pin) && pin.ref.profileId === value.profileId) &&
  isSafeInteger(value.revision);

export const isPinRemoveResult = (value: unknown): value is ZiggyPinRemoveResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "revision", "pins"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.pins) &&
  value.pins.length <= 256 &&
  value.pins.every((pin) => isPin(pin) && pin.ref.profileId === value.profileId) &&
  isSafeInteger(value.revision);

export interface ZiggyPinPersistence {
  readonly read: () => Promise<ReadonlyArray<ZiggyPin>>;
  readonly write: (pins: ReadonlyArray<ZiggyPin>) => Promise<void>;
}

/**
 * A small persistence adapter for applications that want pins to survive a
 * client restart.  The SDK does not assume browser storage: callers provide
 * the durable medium and can use IndexedDB, a native key/value store, or a
 * server-backed cache while keeping Ziggy's Profile state authoritative.
 */
export const createPinPersistence = (persistence: ZiggyPinPersistence) => {
  let pins: ReadonlyArray<ZiggyPin> | undefined;
  const load = async (): Promise<ReadonlyArray<ZiggyPin>> => {
    pins ??= await persistence.read();
    return pins;
  };
  return {
    list: async (): Promise<ReadonlyArray<ZiggyPin>> =>
      [...(await load())].sort((a, b) => a.order - b.order),
    replace: async (next: ReadonlyArray<ZiggyPin>): Promise<void> => {
      const sorted = [...next].sort((a, b) => a.order - b.order);
      await persistence.write(sorted);
      pins = sorted;
    },
    clear: async (): Promise<void> => {
      await persistence.write([]);
      pins = [];
    },
  };
};

export const isPinCommandId = isCommandId;
