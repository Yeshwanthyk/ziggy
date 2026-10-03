import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { ChatPromptImage } from "../../session";
import { protocolFailure } from "./errors";

export const UI_IMAGE_MAX_BYTES = 5 * 1_024 * 1_024;

const UPLOAD_TTL_MS = 10 * 60 * 1_000;

const UPLOADS_PER_OWNER = 8;

/** HTTP callbacks insert validated bytes; gateway requests atomically consume a whole batch. */
export const makeUiUploadStore = (now: () => number = Date.now) => {
  const held = new Map<
    string,
    {
      readonly owner: string;
      readonly expiresAt: number;
      readonly image: ChatPromptImage;
    }
  >();

  const sweep = () => {
    const time = now();

    for (const [id, upload] of held) {
      if (upload.expiresAt <= time) held.delete(id);
    }
  };

  const put = (owner: string, image: ChatPromptImage): string => {
    sweep();
    const owned = [...held].filter(([, upload]) => upload.owner === owner);

    while (owned.length >= UPLOADS_PER_OWNER) {
      const oldest = owned.shift();

      if (oldest !== undefined) held.delete(oldest[0]);
    }

    const id = randomUUID();
    held.set(id, { owner, image, expiresAt: now() + UPLOAD_TTL_MS });

    return id;
  };

  const consume = Effect.fn("UiUploads.consume")(function* (
    owner: string,
    ids: ReadonlyArray<string>,
  ) {
    sweep();
    const images: Array<ChatPromptImage> = [];

    if (new Set(ids).size !== ids.length)
      return yield* protocolFailure("bad_params", "Each image attachment must be unique.");

    for (const id of ids) {
      const upload = held.get(id);

      if (upload === undefined || upload.owner !== owner)
        return yield* protocolFailure(
          "bad_params",
          "An image attachment is unavailable or expired. Attach it again.",
        );
      images.push(upload.image);
    }

    for (const id of ids) held.delete(id);

    return images;
  });

  return { put, consume, sweep } as const;
};

export type UiUploadStore = ReturnType<typeof makeUiUploadStore>;
