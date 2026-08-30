import type { ZiggyEventCursor, ZiggyProfileId } from "./protocol";
import type { ZiggySessionRef } from "./protocol/conversations";

export interface ZiggyWatch {
  readonly ref: ZiggySessionRef;
  readonly cursor: ZiggyEventCursor | undefined;
}

export type ZiggyWatchState = Readonly<Record<string, ZiggyWatch>>;

export const watchKey = (ref: ZiggySessionRef): string =>
  ref.kind === "live" ? `${ref.profileId}:live:${ref.key}` : `${ref.profileId}:stored:${ref.id}`;

export const addWatch = (
  watches: ZiggyWatchState,
  ref: ZiggySessionRef,
  cursor: ZiggyEventCursor | undefined = undefined,
) => {
  const next = {
    ...watches,
    [watchKey(ref)]: { ref, cursor },
  } satisfies ZiggyWatchState;
  return next;
};

export const updateWatchCursor = (
  watches: ZiggyWatchState,
  ref: ZiggySessionRef,
  cursor: ZiggyEventCursor | undefined,
): ZiggyWatchState => {
  const current = watches[watchKey(ref)];
  return current === undefined
    ? addWatch(watches, ref, cursor)
    : { ...watches, [watchKey(ref)]: { ...current, cursor } };
};

export const removeWatch = (watches: ZiggyWatchState, ref: ZiggySessionRef) => {
  const key = watchKey(ref);
  if (watches[key] === undefined) return watches;
  const next = { ...watches } satisfies ZiggyWatchState;
  delete next[key];
  return next;
};

export const watchesForProfile = (
  watches: ZiggyWatchState,
  profileId: ZiggyProfileId,
): ReadonlyArray<ZiggyWatch> =>
  Object.values(watches).filter((watch) => watch.ref.profileId === profileId);
