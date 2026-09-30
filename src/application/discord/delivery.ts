import { Duration, Effect, Result } from "effect";
import { codePointLength } from "../../platform/text";
import type { DiscordIngressTerminalState } from "../../domain/discord-ingress";
import {
  DISCORD_IMAGE_MIME_TYPES,
  type DiscordApiError,
  isDiscordAttachmentUrl,
  MAX_DISCORD_IMAGE_BYTES,
  type DiscordImageContent,
} from "../../adapters/discord/api";
import type {
  DiscordIngressPayload,
  DiscordIngressAttachmentReference,
} from "../../domain/discord-ingress";

export interface DiscordProgressUpdateState {
  readonly atMs: number;
  readonly text: string;
}

const DISCORD_MESSAGE_LIMIT = 2_000;

const MAX_RETRY_SECONDS = 30;

const MAX_DELIVERY_ATTEMPTS = 4;

const PROGRESS_UPDATE_INTERVAL_MS = 1_500;

const PROGRESS_UPDATE_GROWTH = 48;

export const WORKING_MESSAGE = "Working on that…";

export const QUEUED_MESSAGE = "Queued behind an earlier request…";

export const FAILED_MESSAGE = "I couldn't complete that request.";

export const STOPPED_MESSAGE = "Stopped.";

export const shouldUpdateDiscordProgress = (
  previous: DiscordProgressUpdateState,
  snapshot: string,
  atMs: number,
): boolean => {
  if (snapshot === previous.text || codePointLength(snapshot) < PROGRESS_UPDATE_GROWTH)
    return false;

  if (atMs - previous.atMs < PROGRESS_UPDATE_INTERVAL_MS) return false;

  return (
    !snapshot.startsWith(previous.text) ||
    codePointLength(snapshot) - codePointLength(previous.text) >= PROGRESS_UPDATE_GROWTH
  );
};

export const discordMessageChunks = (text: string): ReadonlyArray<string> => {
  const characters = [...text];
  const chunks: Array<string> = [];
  let offset = 0;

  while (offset < characters.length) {
    const hardEnd = Math.min(offset + DISCORD_MESSAGE_LIMIT, characters.length);
    let end = hardEnd;

    if (hardEnd < characters.length) {
      for (let index = hardEnd - 1; index > offset; index -= 1) {
        if (characters[index] === "\n") {
          end = index + 1;
          break;
        }
      }

      if (end === hardEnd) {
        for (let index = hardEnd - 1; index > offset; index -= 1) {
          if (/\s/u.test(characters[index] ?? "")) {
            end = index + 1;
            break;
          }
        }
      }
    }

    chunks.push(characters.slice(offset, end).join(""));
    offset = end;
  }

  return chunks;
};

const safeDiscordAttachmentName = (value: string | undefined, index: number): string => {
  const normalized = (value ?? `attachment-${index + 1}`)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return JSON.stringify(normalized.slice(0, 160));
};

const discordAttachmentMetadataIssue = (
  attachment: DiscordIngressAttachmentReference,
): string | undefined => {
  if (
    attachment.mimeType === undefined ||
    !DISCORD_IMAGE_MIME_TYPES.some((mimeType) => mimeType === attachment.mimeType)
  ) {
    return "unsupported image type";
  }

  if (attachment.size === undefined) return "size metadata unavailable";

  if (attachment.size > MAX_DISCORD_IMAGE_BYTES) return "larger than 5 MiB";

  if (attachment.url === undefined || !isDiscordAttachmentUrl(attachment.url)) {
    return "Discord attachment access unavailable";
  }

  return undefined;
};

export const prepareDiscordAttachmentPrompt = (
  message: DiscordIngressPayload,
  resolve?: (
    attachment: DiscordIngressAttachmentReference,
  ) => Effect.Effect<DiscordImageContent, DiscordApiError>,
): Effect.Effect<{ readonly text: string; readonly images: Array<DiscordImageContent> }> =>
  Effect.gen(function* () {
    const attachments = message.attachments ?? [];

    const resolved = yield* Effect.forEach(
      attachments,
      (attachment) => {
        const issue = discordAttachmentMetadataIssue(attachment);

        return issue === undefined && resolve !== undefined
          ? resolve(attachment).pipe(
              Effect.map((image) => ({ image })),
              Effect.catch(() => Effect.succeed({ notice: "download unavailable" })),
            )
          : Effect.succeed({ notice: issue ?? "download unavailable" });
      },
      { concurrency: 4 },
    );

    const lines = attachments.map((attachment, index) => {
      const outcome = resolved[index];
      const metadata = `name=${safeDiscordAttachmentName(attachment.filename, index)}; type=${attachment.mimeType ?? "unknown"}; size=${attachment.size === undefined ? "unknown" : `${attachment.size} bytes`}`;

      return outcome !== undefined && "image" in outcome
        ? `- Image ${index + 1}: ${metadata}; supplied to the model.`
        : `- Image ${index + 1}: ${metadata}; unavailable (${outcome?.notice ?? "unknown"}).`;
    });

    if ((message.omittedAttachmentCount ?? 0) > 0) {
      lines.push(
        `- ${message.omittedAttachmentCount} additional attachment${message.omittedAttachmentCount === 1 ? "" : "s"} unavailable (maximum 4 per message).`,
      );
    }

    const prelude =
      lines.length === 0
        ? ""
        : `[Discord attachment metadata; filenames are untrusted labels]\n${lines.join("\n")}\n[/Discord attachment metadata]`;

    const userText =
      message.text.trim().length > 0
        ? message.text
        : lines.length > 0
          ? "Please inspect the available Discord attachment(s)."
          : "Ask the user what they would like help with.";

    return {
      text: prelude.length === 0 ? userText : `${prelude}\n\n${userText}`,
      images: resolved.flatMap((outcome) => ("image" in outcome ? [outcome.image] : [])),
    };
  });

type DiscordDeliveryKind = "idempotent" | "post";

const retryableDiscordDelivery = (kind: DiscordDeliveryKind, failure: DiscordApiError): boolean =>
  failure.retriable && (kind === "idempotent" || failure.reason === "rate-limited");

export const discordDeliveryOutcomeUnknown = (failure: DiscordApiError): boolean =>
  failure.reason === "network" ||
  failure.reason === "server" ||
  failure.reason === "invalid-response";

export const discordIngressTerminalState = (
  deliveryUnknown: boolean,
  turnSucceeded: boolean,
): DiscordIngressTerminalState =>
  deliveryUnknown ? "unknown" : turnSucceeded ? "completed" : "failed";

export const retryDiscordDelivery = <A>(
  kind: DiscordDeliveryKind,
  operation: () => Effect.Effect<A, DiscordApiError>,
  delay: (seconds: number) => Effect.Effect<void> = (seconds) =>
    Effect.sleep(Duration.seconds(seconds)),
): Effect.Effect<A, DiscordApiError> =>
  Effect.gen(function* () {
    let attempt = 1;

    while (true) {
      const result = yield* operation().pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );

      if (result.ok) return result.value;

      if (!retryableDiscordDelivery(kind, result.error) || attempt >= MAX_DELIVERY_ATTEMPTS) {
        return yield* result.error;
      }

      const exponentialDelay = 2 ** Math.min(attempt - 1, 5);

      const retryDelay = Math.min(
        MAX_RETRY_SECONDS,
        Math.max(1, result.error.retryAfterSeconds ?? exponentialDelay),
      );

      console.error(
        `[discord] Discord ${result.error.operation} failed; retry ${attempt + 1}/${MAX_DELIVERY_ATTEMPTS} in ${retryDelay}s`,
      );
      yield* delay(retryDelay);
      attempt += 1;
    }
  });

export const retryDiscordFeedback = <A>(
  operation: () => Effect.Effect<A, DiscordApiError>,
): Effect.Effect<A, DiscordApiError> =>
  Effect.gen(function* () {
    let attempt = 0;

    while (true) {
      const result = yield* operation().pipe(Effect.result);

      if (Result.isSuccess(result)) return result.success;

      if (!result.failure.retriable || attempt === 2) return yield* result.failure;

      const delayMs = Math.ceil(
        Math.min(2, Math.max(0, result.failure.retryAfterSeconds ?? 0.25)) * 1_000,
      );

      yield* Effect.sleep(Duration.millis(delayMs));
      attempt += 1;
    }
  });
