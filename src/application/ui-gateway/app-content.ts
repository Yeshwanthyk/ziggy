import { randomUUID } from "node:crypto";

const APP_CONTENT_TTL_MS = 60 * 1_000;

const APP_CONTENT_PER_OWNER = 16;

/** One serialized result is at most this large; a view's HTML is the biggest thing it carries. */
export const UI_APP_CONTENT_MAX_BYTES = 8 * 1_024 * 1_024;

/**
 * Results of `app.callTool` and `app.readResource`, too large for a WebSocket frame. Each waits,
 * for the connection owner that asked, until fetched once from `/app-content/<id>` or expired.
 */
export const makeUiAppContentStore = (now: () => number = Date.now) => {
  const held = new Map<
    string,
    { readonly owner: string; readonly expiresAt: number; readonly body: string }
  >();

  const sweep = () => {
    const time = now();

    for (const [id, content] of held) {
      if (content.expiresAt <= time) held.delete(id);
    }
  };

  const put = (owner: string, body: string): string => {
    sweep();
    const owned = [...held].filter(([, content]) => content.owner === owner);

    while (owned.length >= APP_CONTENT_PER_OWNER) {
      const oldest = owned.shift();

      if (oldest !== undefined) held.delete(oldest[0]);
    }

    const id = randomUUID();
    held.set(id, { owner, body, expiresAt: now() + APP_CONTENT_TTL_MS });

    return id;
  };

  /** The body once, for its owner only; another owner learns nothing about it. */
  const take = (owner: string, id: string): string | undefined => {
    sweep();
    const content = held.get(id);

    if (content === undefined || content.owner !== owner) return undefined;
    held.delete(id);

    return content.body;
  };

  return { put, take, sweep } as const;
};

export type UiAppContentStore = ReturnType<typeof makeUiAppContentStore>;
