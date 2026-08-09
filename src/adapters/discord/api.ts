import { Buffer } from "node:buffer";
import { Effect, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { DiscordIngressAttachmentReference } from "../../domain/discord-ingress";

export const MAX_DISCORD_IMAGE_BYTES = 5 * 1024 * 1024;
export const DISCORD_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type DiscordImageMimeType = (typeof DISCORD_IMAGE_MIME_TYPES)[number];
export interface DiscordImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: DiscordImageMimeType;
}
interface DiscordDownloadAccumulator {
  readonly chunks: Array<Uint8Array>;
  readonly size: number;
}

const HttpStatus = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(100),
  Schema.isLessThanOrEqualTo(599),
);
const RetryAfterSeconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const GatewayBotSuccess = Schema.Struct({ url: Schema.String });
const CreateMessageSuccess = Schema.Struct({ id: Schema.String });
const CurrentApplicationSuccess = Schema.Struct({ id: Schema.String });
const ApplicationCommandSuccess = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.Finite.check(Schema.isInt()),
  description: Schema.String,
  integration_types: Schema.optional(Schema.Array(Schema.Finite.check(Schema.isInt()))),
  contexts: Schema.optional(Schema.Array(Schema.Finite.check(Schema.isInt()))),
});
const DiscordChannelSuccess = Schema.Struct({
  id: Schema.String,
  type: Schema.Finite.check(Schema.isInt()),
  guild_id: Schema.optional(Schema.String),
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
});
const RateLimitFailure = Schema.Struct({
  retry_after: Schema.optional(RetryAfterSeconds),
});

const decodeGatewayBotResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GatewayBotSuccess),
);
const decodeCurrentApplicationResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CurrentApplicationSuccess),
);
const decodeApplicationCommandsResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ApplicationCommandSuccess)),
);
const decodeApplicationCommandResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ApplicationCommandSuccess),
);
const decodeCreateMessageResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CreateMessageSuccess),
);
const decodeDiscordChannelResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DiscordChannelSuccess),
);
const decodeRateLimitResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(RateLimitFailure));

export type DiscordApiOperation =
  | "getGatewayBot"
  | "getChannel"
  | "createMessage"
  | "updateMessage"
  | "triggerTyping"
  | "addReaction"
  | "removeReaction"
  | "downloadAttachment"
  | "ensureCommands"
  | "respondToInteraction"
  | "startThreadFromMessage"
  | "gateway";
export type DiscordApiErrorReason =
  | "network"
  | "server"
  | "rate-limited"
  | "authentication"
  | "rejected"
  | "invalid-response"
  | "gateway";

export class DiscordApiError extends Schema.TaggedErrorClass<DiscordApiError>()("DiscordApiError", {
  operation: Schema.Literals([
    "getGatewayBot",
    "getChannel",
    "createMessage",
    "updateMessage",
    "triggerTyping",
    "addReaction",
    "removeReaction",
    "downloadAttachment",
    "ensureCommands",
    "respondToInteraction",
    "startThreadFromMessage",
    "gateway",
  ]),
  reason: Schema.Literals([
    "network",
    "server",
    "rate-limited",
    "authentication",
    "rejected",
    "invalid-response",
    "gateway",
  ]),
  retriable: Schema.Boolean,
  status: Schema.optional(HttpStatus),
  retryAfterSeconds: Schema.optional(RetryAfterSeconds),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

interface RawResponse {
  readonly status: number;
  readonly body: string;
  readonly retryAfterHeader: string | undefined;
}

export interface DiscordApplicationCommandDefinition {
  readonly name: string;
  readonly type: 1;
  readonly description: string;
  readonly integration_types: readonly [0];
  readonly contexts: readonly [0, 1];
}

export const ZIGGY_DISCORD_COMMANDS: ReadonlyArray<DiscordApplicationCommandDefinition> = [
  {
    name: "status",
    type: 1,
    description: "Show this Ziggy conversation's state",
    integration_types: [0],
    contexts: [0, 1],
  },
  {
    name: "stop",
    type: 1,
    description: "Stop work in this Ziggy conversation",
    integration_types: [0],
    contexts: [0, 1],
  },
];

const redact = (value: string, token: string): string =>
  value.replaceAll(token, "[REDACTED]").replaceAll(encodeURIComponent(token), "[REDACTED]");

const safeCause = (cause: unknown, token: string): Error => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(redact(message, token));
};

const apiError = (
  operation: DiscordApiOperation,
  reason: DiscordApiErrorReason,
  retriable: boolean,
  cause: unknown,
  token: string,
  options?: {
    readonly status?: number;
    readonly retryAfterSeconds?: number;
  },
): DiscordApiError =>
  new DiscordApiError({
    operation,
    reason,
    retriable,
    message:
      reason === "authentication"
        ? `Discord ${operation} authentication failed`
        : `Discord ${operation} failed`,
    cause: safeCause(cause, token),
    ...(options?.status === undefined ? {} : { status: options.status }),
    ...(options?.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
  });

const retryAfterHeader = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

const classifyFailure = (
  operation: DiscordApiOperation,
  status: number,
  token: string,
  retryAfterSeconds?: number,
): DiscordApiError => {
  if (status === 401 || status === 403) {
    return apiError(operation, "authentication", false, new Error(`HTTP ${status}`), token, {
      status,
    });
  }
  if (status === 429) {
    return apiError(operation, "rate-limited", true, new Error("HTTP 429"), token, {
      status,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (status >= 500) {
    return apiError(operation, "server", true, new Error(`HTTP ${status}`), token, { status });
  }
  return apiError(operation, "rejected", false, new Error(`HTTP ${status}`), token, { status });
};

export const discordImageMimeType = (value: string | undefined): DiscordImageMimeType | undefined =>
  DISCORD_IMAGE_MIME_TYPES.find((mimeType) => mimeType === value);

export const isDiscordAttachmentUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net") &&
      url.pathname.startsWith("/attachments/")
    );
  } catch {
    return false;
  }
};

const request = (
  client: HttpClient.HttpClient,
  token: string,
  operation: DiscordApiOperation,
  url: string,
  options?: {
    readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    readonly body?: string;
    readonly omitAuthorization?: boolean;
  },
): Effect.Effect<RawResponse, DiscordApiError> => {
  let outgoing = HttpClientRequest.make(options?.method ?? "GET")(url);
  if (options?.omitAuthorization !== true) {
    outgoing = outgoing.pipe(HttpClientRequest.setHeader("Authorization", `Bot ${token}`));
  }
  if (options?.body !== undefined) {
    outgoing = outgoing.pipe(HttpClientRequest.bodyText(options.body, "application/json"));
  }

  return client.execute(outgoing).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((body) => ({
          status: response.status,
          body,
          retryAfterHeader: response.headers["retry-after"],
        })),
      ),
    ),
    Effect.mapError((cause) => apiError(operation, "network", true, cause, token)),
  );
};

const retryAfter = (response: RawResponse): Effect.Effect<number | undefined, never> =>
  decodeRateLimitResponse(response.body).pipe(
    Effect.map((body) => body.retry_after ?? retryAfterHeader(response.retryAfterHeader)),
    Effect.orElseSucceed(() => retryAfterHeader(response.retryAfterHeader)),
  );

const ensureSuccess = (
  token: string,
  operation: DiscordApiOperation,
  response: RawResponse,
): Effect.Effect<RawResponse, DiscordApiError> => {
  if (response.status >= 200 && response.status < 300) {
    return Effect.succeed(response);
  }
  if (response.status === 429) {
    return retryAfter(response).pipe(
      Effect.flatMap((seconds) =>
        Effect.fail(classifyFailure(operation, response.status, token, seconds)),
      ),
    );
  }
  return Effect.fail(classifyFailure(operation, response.status, token));
};

const commandMatches = (
  existing: typeof ApplicationCommandSuccess.Type,
  expected: DiscordApplicationCommandDefinition,
): boolean =>
  existing.name === expected.name &&
  existing.type === expected.type &&
  existing.description === expected.description &&
  JSON.stringify(existing.integration_types ?? []) === JSON.stringify(expected.integration_types) &&
  JSON.stringify(existing.contexts ?? []) === JSON.stringify(expected.contexts);

export const makeDiscordApi = (client: HttpClient.HttpClient) => ({
  getGatewayBot: (token: string) =>
    request(client, token, "getGatewayBot", "https://discord.com/api/v10/gateway/bot").pipe(
      Effect.flatMap((response) => ensureSuccess(token, "getGatewayBot", response)),
      Effect.flatMap((response) =>
        decodeGatewayBotResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("getGatewayBot", "invalid-response", false, cause, token, {
              status: response.status,
            }),
          ),
        ),
      ),
    ),
  ensureCommands: (token: string) =>
    Effect.gen(function* () {
      const applicationResponse = yield* request(
        client,
        token,
        "ensureCommands",
        "https://discord.com/api/v10/oauth2/applications/@me",
      ).pipe(Effect.flatMap((response) => ensureSuccess(token, "ensureCommands", response)));
      const application = yield* decodeCurrentApplicationResponse(applicationResponse.body).pipe(
        Effect.mapError((cause) =>
          apiError("ensureCommands", "invalid-response", false, cause, token, {
            status: applicationResponse.status,
          }),
        ),
      );
      const applicationUrl = `https://discord.com/api/v10/applications/${encodeURIComponent(application.id)}`;
      const commandsUrl = `${applicationUrl}/commands`;
      const commandsResponse = yield* request(client, token, "ensureCommands", commandsUrl).pipe(
        Effect.flatMap((response) => ensureSuccess(token, "ensureCommands", response)),
      );
      const existing = yield* decodeApplicationCommandsResponse(commandsResponse.body).pipe(
        Effect.mapError((cause) =>
          apiError("ensureCommands", "invalid-response", false, cause, token, {
            status: commandsResponse.status,
          }),
        ),
      );
      for (const expected of ZIGGY_DISCORD_COMMANDS) {
        const current = existing.find(
          (command) => command.name === expected.name && command.type === expected.type,
        );
        if (current !== undefined && commandMatches(current, expected)) {
          continue;
        }
        const response = yield* request(client, token, "ensureCommands", commandsUrl, {
          method: "POST",
          body: JSON.stringify(expected),
        }).pipe(Effect.flatMap((raw) => ensureSuccess(token, "ensureCommands", raw)));
        yield* decodeApplicationCommandResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("ensureCommands", "invalid-response", false, cause, token, {
              status: response.status,
            }),
          ),
        );
      }
    }),
  respondToInteraction: (interactionId: string, interactionToken: string, text: string) =>
    request(
      client,
      interactionToken,
      "respondToInteraction",
      `https://discord.com/api/v10/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`,
      {
        method: "POST",
        omitAuthorization: true,
        body: JSON.stringify({
          type: 4,
          data: { content: text, flags: 64, allowed_mentions: { parse: [] } },
        }),
      },
    ).pipe(
      Effect.flatMap((response) =>
        ensureSuccess(interactionToken, "respondToInteraction", response),
      ),
      Effect.asVoid,
    ),
  getChannel: (token: string, channelId: string) =>
    request(
      client,
      token,
      "getChannel",
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`,
    ).pipe(
      Effect.flatMap((response) => ensureSuccess(token, "getChannel", response)),
      Effect.flatMap((response) =>
        decodeDiscordChannelResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("getChannel", "invalid-response", false, cause, token, {
              status: response.status,
            }),
          ),
        ),
      ),
    ),
  createMessage: (token: string, channelId: string, text: string) =>
    request(
      client,
      token,
      "createMessage",
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
      },
    ).pipe(
      Effect.flatMap((response) => ensureSuccess(token, "createMessage", response)),
      Effect.flatMap((response) =>
        decodeCreateMessageResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("createMessage", "invalid-response", false, cause, token, {
              status: response.status,
            }),
          ),
        ),
      ),
    ),
  updateMessage: (token: string, channelId: string, messageId: string, text: string) =>
    request(
      client,
      token,
      "updateMessage",
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
      },
    ).pipe(
      Effect.flatMap((response) => ensureSuccess(token, "updateMessage", response)),
      Effect.flatMap((response) =>
        decodeCreateMessageResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("updateMessage", "invalid-response", false, cause, token, {
              status: response.status,
            }),
          ),
        ),
      ),
      Effect.asVoid,
    ),
  triggerTyping: (token: string, channelId: string) =>
    request(
      client,
      token,
      "triggerTyping",
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/typing`,
      { method: "POST" },
    ).pipe(
      Effect.flatMap((response) => ensureSuccess(token, "triggerTyping", response)),
      Effect.asVoid,
    ),
  addReaction: (token: string, channelId: string, messageId: string, emoji: string) =>
    request(
      client,
      token,
      "addReaction",
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: "PUT" },
    ).pipe(
      Effect.flatMap((response) => ensureSuccess(token, "addReaction", response)),
      Effect.asVoid,
    ),
  removeReaction: (token: string, channelId: string, messageId: string, emoji: string) =>
    request(
      client,
      token,
      "removeReaction",
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: "DELETE" },
    ).pipe(
      Effect.flatMap((response) => ensureSuccess(token, "removeReaction", response)),
      Effect.asVoid,
    ),
  downloadAttachment: (file: DiscordIngressAttachmentReference) => {
    const mimeType = discordImageMimeType(file.mimeType);
    if (mimeType === undefined || file.size === undefined || file.size > MAX_DISCORD_IMAGE_BYTES) {
      return Effect.fail(
        apiError(
          "downloadAttachment",
          "rejected",
          false,
          new Error("invalid attachment metadata"),
          "",
        ),
      );
    }
    if (file.url === undefined || !isDiscordAttachmentUrl(file.url)) {
      return Effect.fail(
        apiError("downloadAttachment", "rejected", false, new Error("invalid attachment URL"), ""),
      );
    }
    return client.execute(HttpClientRequest.get(file.url)).pipe(
      Effect.mapError(() =>
        apiError("downloadAttachment", "network", true, new Error("attachment request failed"), ""),
      ),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(response)
          : Effect.fail(classifyFailure("downloadAttachment", response.status, "")),
      ),
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          const contentLength = Number(response.headers["content-length"]);
          if (Number.isFinite(contentLength) && contentLength > MAX_DISCORD_IMAGE_BYTES) {
            return yield* apiError(
              "downloadAttachment",
              "rejected",
              false,
              new Error("content length too large"),
              "",
            );
          }
          const responseMimeType = response.headers["content-type"]
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (responseMimeType !== mimeType) {
            return yield* apiError(
              "downloadAttachment",
              "rejected",
              false,
              new Error("content type mismatch"),
              "",
            );
          }
          return yield* response.stream.pipe(
            Stream.runFoldEffect(
              (): DiscordDownloadAccumulator => ({ chunks: [], size: 0 }),
              (accumulator, chunk) => {
                const size = accumulator.size + chunk.byteLength;
                if (size > MAX_DISCORD_IMAGE_BYTES) {
                  return Effect.fail(
                    apiError(
                      "downloadAttachment",
                      "rejected",
                      false,
                      new Error("download too large"),
                      "",
                    ),
                  );
                }
                accumulator.chunks.push(chunk);
                return Effect.succeed({ chunks: accumulator.chunks, size });
              },
            ),
            Effect.mapError((failure) =>
              failure instanceof DiscordApiError
                ? failure
                : apiError(
                    "downloadAttachment",
                    "network",
                    true,
                    new Error("attachment body failed"),
                    "",
                  ),
            ),
          );
        }),
      ),
      Effect.map(
        (body): DiscordImageContent => ({
          type: "image",
          data: Buffer.concat(
            body.chunks.map((chunk) => Buffer.from(chunk)),
            body.size,
          ).toString("base64"),
          mimeType,
        }),
      ),
    );
  },
  startThreadFromMessage: (token: string, channelId: string, messageId: string, name: string) =>
    request(
      client,
      token,
      "startThreadFromMessage",
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`,
      {
        method: "POST",
        body: JSON.stringify({ name, auto_archive_duration: 1440 }),
      },
    ).pipe(
      Effect.flatMap((response) => ensureSuccess(token, "startThreadFromMessage", response)),
      Effect.flatMap((response) =>
        decodeDiscordChannelResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("startThreadFromMessage", "invalid-response", false, cause, token, {
              status: response.status,
            }),
          ),
        ),
      ),
    ),
});

export type DiscordApi = ReturnType<typeof makeDiscordApi>;

const withLiveClient = <A, E>(use: (api: DiscordApi) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* use(makeDiscordApi(client));
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const getGatewayBot = (
  token: string,
): Effect.Effect<{ readonly url: string }, DiscordApiError> =>
  withLiveClient((api) => api.getGatewayBot(token));

export const createMessage = (
  token: string,
  channelId: string,
  text: string,
): Effect.Effect<void, DiscordApiError> =>
  withLiveClient((api) => api.createMessage(token, channelId, text)).pipe(Effect.asVoid);

export const createMessageWithReceipt = (
  token: string,
  channelId: string,
  text: string,
): Effect.Effect<{ readonly id: string }, DiscordApiError> =>
  withLiveClient((api) => api.createMessage(token, channelId, text));

export const updateMessage = (
  token: string,
  channelId: string,
  messageId: string,
  text: string,
): Effect.Effect<void, DiscordApiError> =>
  withLiveClient((api) => api.updateMessage(token, channelId, messageId, text));

export const triggerTyping = (
  token: string,
  channelId: string,
): Effect.Effect<void, DiscordApiError> =>
  withLiveClient((api) => api.triggerTyping(token, channelId));

export const addReaction = (
  token: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Effect.Effect<void, DiscordApiError> =>
  withLiveClient((api) => api.addReaction(token, channelId, messageId, emoji));

export const removeReaction = (
  token: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Effect.Effect<void, DiscordApiError> =>
  withLiveClient((api) => api.removeReaction(token, channelId, messageId, emoji));

export const downloadAttachment = (
  file: DiscordIngressAttachmentReference,
): Effect.Effect<DiscordImageContent, DiscordApiError> =>
  withLiveClient((api) => api.downloadAttachment(file));

export const ensureDiscordCommands = (token: string): Effect.Effect<void, DiscordApiError> =>
  withLiveClient((api) => api.ensureCommands(token));

export const respondToDiscordInteraction = (
  interactionId: string,
  interactionToken: string,
  text: string,
): Effect.Effect<void, DiscordApiError> =>
  withLiveClient((api) => api.respondToInteraction(interactionId, interactionToken, text));

export const getChannel = (
  token: string,
  channelId: string,
): Effect.Effect<typeof DiscordChannelSuccess.Type, DiscordApiError> =>
  withLiveClient((api) => api.getChannel(token, channelId));

export const startThreadFromMessage = (
  token: string,
  channelId: string,
  messageId: string,
  name: string,
): Effect.Effect<typeof DiscordChannelSuccess.Type, DiscordApiError> =>
  withLiveClient((api) => api.startThreadFromMessage(token, channelId, messageId, name));
