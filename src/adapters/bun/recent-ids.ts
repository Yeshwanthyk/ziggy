export interface RecentIds {
  readonly has: (id: string) => boolean;
  readonly remember: (id: string) => boolean;
}

export const makeRecentIds = (capacity: number): RecentIds => {
  const ids = new Set<string>();

  return {
    has: (id) => ids.has(id),
    remember: (id) => {
      if (ids.has(id)) {
        return false;
      }

      ids.add(id);
      if (ids.size > capacity) {
        const oldest = ids.values().next().value;
        if (oldest !== undefined) {
          ids.delete(oldest);
        }
      }
      return true;
    },
  };
};
