import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Context, Deferred, Duration, Effect, Exit, Layer, Queue, Result, Semaphore } from "effect";
import type * as Scope from "effect/Scope";
import {
  addReaction,
  authTest,
  downloadFile,
  isSlackPrivateFileUrl,
  MAX_SLACK_IMAGE_BYTES,
  postMessage,
  removeReaction,
  setStatus,
  SlackApiError,
  type SlackImageContent,
  SLACK_IMAGE_MIME_TYPES,
  updateMessage,
} from "../adapters/slack/api";
import {
  admitSlackIngress,
  finishSlackIngress,
  initializeSlackIngressDatabase,
  readReplayableSlackIngress,
  recoverSlackIngress,
  startSlackIngress,
} from "../adapters/bun/slack-ingress-sqlite";
import {
  type SlackInboundMessage,
  type SlackSocket,
  SlackSocketError,
  type SlackSocketInboundAdmit,
  openSlackSocket,
} from "../adapters/slack/socket";
import { loadSlackConfigFile } from "../adapters/fs/gateway-config";
import { writeSlackHealth } from "../adapters/fs/slack-health";
import { type ZiggyAgentError } from "../domain/agent";
import { codePointLength } from "../domain/memory";
import { SlackChannelMode, type SlackGatewayConfig } from "../domain/slack";
import {
  type SlackIngressDatabaseError,
  type SlackIngressFileReference,
  type SlackIngressPayload,
  type SlackIngressRecord,
  type SlackIngressTerminalState,
} from "../domain/slack-ingress";
import {
  evolveSlackHealth,
  initialSlackHealth,
  type SlackHealthEvent,
  type SlackHealthProjectionError,
  type SlackHealthSnapshot,
} from "../domain/slack-health";
import type { ProfileTarget } from "../domain/profile";
import { ZiggyAgent, type ChatHandle, type ZiggyAgentShape } from "./agent";

const SLACK_MESSAGE_LIMIT = 4_000;
const MAX_RETRY_SECONDS = 30;
const MAX_DELIVERY_ATTEMPTS = 4;
const HEARTBEAT_SECONDS = 30;
const PROGRESS_UPDATE_INTERVAL_MS = 1_500;
const PROGRESS_UPDATE_GROWTH = 48;
const WORKING_MESSAGE = "Working on that…";
const QUEUED_MESSAGE = "Queued behind an earlier request…";
const FAILED_MESSAGE = "I couldn't complete that request.";
const STOPPED_MESSAGE = "Stopped.";
const SLACK_BROADCAST_MENTION = /<!(?:everyone|channel|here)(?:\|[^>\n]*)?>/gi;
const SLACK_LINK = /<((?:https?|mailto|tel):[^|>]+)(?:\|([^>]*))?>/giu;
const SLACK_ENTITY = /&(amp|lt|gt);/gu;
const SLACK_ENTITY_VALUE = {
  amp: "&",
  gt: ">",
  lt: "<",
} as const;

export type SlackGatewayError = SlackApiError | SlackIngressDatabaseError;

export interface SlackTransport {
  readonly authTest: (token: string) => Effect.Effect<{ readonly userId: string }, SlackApiError>;
  readonly openSocket: (
    appToken: string,
    admitInbound?: SlackSocketInboundAdmit,
  ) => Effect.Effect<SlackSocket, SlackSocketError, Scope.Scope>;
  readonly postMessage: (
    token: string,
    channel: string,
    text: string,
    threadTs?: string,
  ) => Effect.Effect<{ readonly ts: string }, SlackApiError>;
  readonly updateMessage: (
    token: string,
    channel: string,
    ts: string,
    text: string,
  ) => Effect.Effect<void, SlackApiError>;
  readonly setStatus: (
    token: string,
    channel: string,
    threadTs: string,
    status: string,
  ) => Effect.Effect<void, SlackApiError>;
  readonly addReaction: (
    token: string,
    channel: string,
    ts: string,
    name: string,
  ) => Effect.Effect<void, SlackApiError>;
  readonly removeReaction: (
    token: string,
    channel: string,
    ts: string,
    name: string,
  ) => Effect.Effect<void, SlackApiError>;
  readonly downloadFile?: (
    token: string,
    file: SlackIngressFileReference,
  ) => Effect.Effect<SlackImageContent, SlackApiError>;
}

export interface SlackGatewayShape {
  readonly runLoop: (
    target: ProfileTarget,
    config: SlackGatewayConfig,
  ) => Effect.Effect<never, SlackGatewayError>;
}

export class SlackGateway extends Context.Service<SlackGateway, SlackGatewayShape>()(
  "ziggy/SlackGateway",
) {}

type InboundMessage = SlackIngressPayload;

interface ChatState {
  readonly semaphore: Semaphore.Semaphore;
  readonly statusSemaphore: Semaphore.Semaphore;
  readonly turns: Set<ScheduledSlackTurn>;
  generation: number;
  handle?: ChatHandle;
  pending: number;
}

interface ScheduledSlackTurn {
  readonly cancellation: Deferred.Deferred<void>;
  readonly generation: number;
  readonly message: InboundMessage;
  cancelled: boolean;
  terminalAttempted: boolean;
}

export type SlackAdmissionReason =
  | "bot-message"
  | "empty-message"
  | "mention-required"
  | "not-owner";

export type SlackAdmission =
  | { readonly kind: "accepted"; readonly message: InboundMessage }
  | { readonly kind: "ignored"; readonly reason: SlackAdmissionReason };

export type SlackCommandAdmission =
  | { readonly kind: "turn" | "stop"; readonly message: InboundMessage }
  | { readonly kind: "ignored"; readonly reason: SlackAdmissionReason };

const isSlackStopCommand = (text: string): boolean => text === "stop" || text === "/stop";

export const loadSlackGatewayConfig = loadSlackConfigFile;

export const normalizeSlackUserText = (text: string): string =>
  text
    .replace(SLACK_LINK, (_token, target: string, label: string | undefined) =>
      label === undefined || label.length === 0 ? target : label,
    )
    .replace(
      SLACK_ENTITY,
      (_token, entity: keyof typeof SLACK_ENTITY_VALUE) => SLACK_ENTITY_VALUE[entity],
    );

export const classifySlackMessage = (
  message: SlackInboundMessage,
  botUserId: string,
  ownerUserId: string,
  channelMode: typeof SlackChannelMode.Type = "always",
): SlackAdmission => {
  if (message.userId === botUserId) {
    return { kind: "ignored", reason: "bot-message" };
  }
  if (message.userId !== ownerUserId) {
    return { kind: "ignored", reason: "not-owner" };
  }
  const hasFiles = (message.files?.length ?? 0) > 0 || (message.omittedFileCount ?? 0) > 0;
  if (message.text.trim().length === 0 && !hasFiles) {
    return { kind: "ignored", reason: "empty-message" };
  }

  if (message.channelType === "im") {
    return {
      kind: "accepted",
      message: {
        chatKey: `user-${message.userId}`,
        channel: message.channel,
        context: { kind: "user", userId: "owner" },
        ...(message.files === undefined ? {} : { files: message.files }),
        ...(message.omittedFileCount === undefined
          ? {}
          : { omittedFileCount: message.omittedFileCount }),
        statusThreadTs: message.threadTs ?? message.ts,
        sourceTs: message.ts,
        text: normalizeSlackUserText(message.text),
        threadTs: message.threadTs,
      },
    };
  }

  const botMention = `<@${botUserId}>`;
  if (channelMode === "mention" && !message.text.includes(botMention)) {
    return { kind: "ignored", reason: "mention-required" };
  }
  const channelText = normalizeSlackUserText(message.text.replaceAll(botMention, "")).trim();
  if (channelText.length === 0 && !hasFiles) {
    return { kind: "ignored", reason: "empty-message" };
  }

  // Slack channel IDs are alphanumeric; the "sl" prefix keeps group memory channel-scoped.
  const groupId = `sl${message.channel}`;
  const chatKey =
    message.threadTs === undefined
      ? `group-${groupId}`
      : `group-${groupId}-thread-${encodeURIComponent(message.threadTs)}`;
  return {
    kind: "accepted",
    message: {
      chatKey,
      channel: message.channel,
      context: { kind: "group", groupId },
      ...(message.files === undefined ? {} : { files: message.files }),
      ...(message.omittedFileCount === undefined
        ? {}
        : { omittedFileCount: message.omittedFileCount }),
      statusThreadTs: message.threadTs ?? message.ts,
      sourceTs: message.ts,
      text: channelText,
      threadTs: message.threadTs,
    },
  };
};

export const normalizeSlackMessage = (
  message: SlackInboundMessage,
  botUserId: string,
  ownerUserId: string,
  channelMode: typeof SlackChannelMode.Type = "always",
): InboundMessage | undefined => {
  const admission = classifySlackMessage(message, botUserId, ownerUserId, channelMode);
  return admission.kind === "accepted" ? admission.message : undefined;
};

export const classifySlackCommand = (
  message: SlackInboundMessage,
  botUserId: string,
  ownerUserId: string,
  channelMode: typeof SlackChannelMode.Type = "always",
): SlackCommandAdmission => {
  const admission = classifySlackMessage(message, botUserId, ownerUserId, channelMode);
  if (admission.kind === "ignored") return admission;
  return {
    kind: isSlackStopCommand(admission.message.text) ? "stop" : "turn",
    message: admission.message,
  };
};

export const escapeSlackBroadcastMentions = (text: string): string =>
  text.replace(SLACK_BROADCAST_MENTION, (mention) => mention.replace("<", "&lt;"));

export const slackMessageChunks = (text: string): ReadonlyArray<string> => {
  const characters = [...escapeSlackBroadcastMentions(text)];
  const chunks: Array<string> = [];
  let offset = 0;
  while (offset < characters.length) {
    const hardEnd = Math.min(offset + SLACK_MESSAGE_LIMIT, characters.length);
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

type SlackDeliveryKind = "post" | "update";

const retryableDelivery = (kind: SlackDeliveryKind, failure: SlackApiError): boolean =>
  failure.retriable && (kind === "update" || failure.reason === "rate-limited");

const deliveryOutcomeUnknown = (failure: SlackApiError): boolean =>
  failure.reason === "network" || failure.reason === "server" || failure.reason === "decode";

export const slackIngressTerminalState = (
  deliveryUnknown: boolean,
  turnSucceeded: boolean,
): SlackIngressTerminalState =>
  deliveryUnknown ? "unknown" : turnSucceeded ? "completed" : "failed";

export const slackHeartbeat = (
  updateStatus: (status: string) => Effect.Effect<void>,
  wait: () => Effect.Effect<void> = () => Effect.sleep(Duration.seconds(HEARTBEAT_SECONDS)),
): Effect.Effect<never> =>
  Effect.gen(function* () {
    let elapsedSeconds = HEARTBEAT_SECONDS;
    while (true) {
      yield* wait();
      yield* updateStatus(`is still working... (${elapsedSeconds}s)`);
      elapsedSeconds += HEARTBEAT_SECONDS;
    }
  });

export interface SlackProgressUpdateState {
  readonly atMs: number;
  readonly text: string;
}

export const shouldUpdateSlackProgress = (
  previous: SlackProgressUpdateState,
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

type SlackProgressSignal =
  | { readonly kind: "text"; readonly snapshot: string }
  | { readonly kind: "status"; readonly status: string };

export const uniqueSlackStatusTargets = (
  messages: ReadonlyArray<Pick<SlackIngressPayload, "channel" | "statusThreadTs">>,
): ReadonlyArray<{ readonly channel: string; readonly threadTs: string }> => [
  ...new Map(
    messages.map((message) => [
      `${message.channel}\u0000${message.statusThreadTs}`,
      { channel: message.channel, threadTs: message.statusThreadTs },
    ]),
  ).values(),
];

const safeAttachmentName = (value: string | undefined, index: number): string => {
  const normalized = (value ?? `attachment-${index + 1}`)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return JSON.stringify(normalized.slice(0, 160));
};

const attachmentMetadataIssue = (file: SlackIngressFileReference): string | undefined => {
  if (
    file.mimeType === undefined ||
    !SLACK_IMAGE_MIME_TYPES.some((mimeType) => mimeType === file.mimeType)
  ) {
    return "unsupported image type";
  }
  if (file.size === undefined) return "size metadata unavailable";
  if (file.size > MAX_SLACK_IMAGE_BYTES) return "larger than 5 MiB";
  if (file.urlPrivate === undefined || !isSlackPrivateFileUrl(file.urlPrivate)) {
    return "Slack file access unavailable";
  }
  return undefined;
};

export const prepareSlackAttachmentPrompt = (
  message: SlackIngressPayload,
  resolve?: (file: SlackIngressFileReference) => Effect.Effect<SlackImageContent, SlackApiError>,
): Effect.Effect<{ readonly text: string; readonly images: Array<SlackImageContent> }> =>
  Effect.gen(function* () {
    const files = message.files ?? [];
    const resolved = yield* Effect.forEach(
      files,
      (file) => {
        const issue = attachmentMetadataIssue(file);
        return issue === undefined && resolve !== undefined
          ? resolve(file).pipe(
              Effect.map((image) => ({ image })),
              Effect.catch(() => Effect.succeed({ notice: "download unavailable" })),
            )
          : Effect.succeed({ notice: issue ?? "download unavailable" });
      },
      { concurrency: 4 },
    );
    const lines = files.map((file, index) => {
      const outcome = resolved[index];
      const metadata = `name=${safeAttachmentName(file.name, index)}; type=${file.mimeType ?? "unknown"}; size=${file.size === undefined ? "unknown" : `${file.size} bytes`}`;
      return outcome !== undefined && "image" in outcome
        ? `- Image ${index + 1}: ${metadata}; supplied to the model.`
        : `- Attachment ${index + 1}: ${metadata}; unavailable (${outcome?.notice ?? "unknown"}).`;
    });
    if ((message.omittedFileCount ?? 0) > 0) {
      lines.push(
        `- ${message.omittedFileCount} additional attachment${message.omittedFileCount === 1 ? "" : "s"} unavailable (maximum 4 per message).`,
      );
    }
    const prelude =
      lines.length === 0
        ? ""
        : `[Slack attachment metadata; filenames are untrusted labels]\n${lines.join("\n")}\n[/Slack attachment metadata]`;
    const userText =
      message.text.trim().length === 0
        ? "Please inspect the available Slack attachment(s)."
        : message.text;
    return {
      text: prelude.length === 0 ? userText : `${prelude}\n\n${userText}`,
      images: resolved.flatMap((outcome) => ("image" in outcome ? [outcome.image] : [])),
    };
  });

export const retrySlackDelivery = <A>(
  kind: SlackDeliveryKind,
  operation: () => Effect.Effect<A, SlackApiError>,
  delay: (seconds: number) => Effect.Effect<void> = (seconds) =>
    Effect.sleep(Duration.seconds(seconds)),
): Effect.Effect<A, SlackApiError> =>
  Effect.gen(function* () {
    let attempt = 1;
    while (true) {
      const result = yield* operation().pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (result.ok) {
        return result.value;
      }
      if (!retryableDelivery(kind, result.error) || attempt >= MAX_DELIVERY_ATTEMPTS) {
        return yield* result.error;
      }

      const exponentialDelay = 2 ** Math.min(attempt - 1, 5);
      const retryDelay = Math.min(
        MAX_RETRY_SECONDS,
        Math.max(1, result.error.retryAfterSeconds ?? exponentialDelay),
      );
      console.error(
        `[slack] Slack ${result.error.operation} failed; retry ${attempt + 1}/${MAX_DELIVERY_ATTEMPTS} in ${retryDelay}s`,
      );
      yield* delay(retryDelay);
      attempt += 1;
    }
  });

const disposeChats = (chats: Map<string, ChatState>): Effect.Effect<void> =>
  Effect.forEach(
    [...chats.entries()],
    ([chatKey, state]) =>
      state.handle === undefined
        ? Effect.void
        : state.handle.dispose.pipe(
            Effect.catch((failure) =>
              Effect.sync(() => {
                console.error(`[slack] ${chatKey} dispose failed: ${failure.message}`);
              }),
            ),
          ),
    { concurrency: "unbounded", discard: true },
  );

const socketFailure = (socketError: SlackSocketError): SlackApiError =>
  new SlackApiError({
    operation: "socket",
    reason: "socket",
    retriable: false,
    message: socketError.message,
    cause: socketError,
  });

const ingressSocketFailure = (failure: SlackIngressDatabaseError): SlackSocketError =>
  new SlackSocketError({
    operation: "receive",
    reason: "connection",
    retriable: false,
    message: "Slack inbound durability failed",
    cause: failure,
  });

const liveSlackTransport: SlackTransport = {
  addReaction,
  authTest,
  downloadFile,
  openSocket: (appToken, admitInbound) => openSlackSocket(appToken, undefined, admitInbound),
  postMessage,
  removeReaction,
  setStatus,
  updateMessage,
};

export interface SlackIngressRuntime {
  readonly initialize: (profilePath: string) => Effect.Effect<void, SlackIngressDatabaseError>;
  readonly recover: (
    profilePath: string,
    ownerId: string,
  ) => Effect.Effect<void, SlackIngressDatabaseError>;
  readonly replayable: (
    profilePath: string,
  ) => Effect.Effect<ReadonlyArray<SlackIngressRecord>, SlackIngressDatabaseError>;
  readonly admit: (
    profilePath: string,
    record: SlackIngressRecord,
    atMs: number,
  ) => Effect.Effect<"accepted" | "duplicate", SlackIngressDatabaseError>;
  readonly start: (
    profilePath: string,
    payload: SlackIngressPayload,
    ownerId: string,
    atMs: number,
  ) => Effect.Effect<boolean, SlackIngressDatabaseError>;
  readonly finish: (
    profilePath: string,
    payload: SlackIngressPayload,
    ownerId: string,
    state: SlackIngressTerminalState,
    atMs: number,
  ) => Effect.Effect<void, SlackIngressDatabaseError>;
}

const liveSlackIngressRuntime: SlackIngressRuntime = {
  initialize: initializeSlackIngressDatabase,
  recover: recoverSlackIngress,
  replayable: readReplayableSlackIngress,
  admit: admitSlackIngress,
  start: startSlackIngress,
  finish: finishSlackIngress,
};

const volatileSlackIngressRuntime: SlackIngressRuntime = {
  initialize: () => Effect.void,
  recover: () => Effect.void,
  replayable: () => Effect.succeed([]),
  admit: () => Effect.succeed("accepted"),
  start: () => Effect.succeed(true),
  finish: () => Effect.void,
};

export interface SlackHealthRuntime {
  readonly now: () => number;
  readonly waitForHeartbeat: Effect.Effect<void>;
  readonly write: (
    profilePath: string,
    snapshot: SlackHealthSnapshot,
  ) => Effect.Effect<void, SlackHealthProjectionError>;
}

const liveSlackHealthRuntime: SlackHealthRuntime = {
  now: Date.now,
  waitForHeartbeat: Effect.sleep(Duration.seconds(30)),
  write: writeSlackHealth,
};

const silentSlackHealthRuntime: SlackHealthRuntime = {
  now: Date.now,
  waitForHeartbeat: Effect.never,
  write: () => Effect.void,
};

export const makeSlackGateway = (
  agent: ZiggyAgentShape,
  transport: SlackTransport = liveSlackTransport,
  healthRuntime: SlackHealthRuntime = silentSlackHealthRuntime,
  ingressRuntime: SlackIngressRuntime = volatileSlackIngressRuntime,
): SlackGatewayShape => ({
  runLoop: (target, config) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ingressOwnerId = randomUUID();
        yield* ingressRuntime.initialize(target.path);
        yield* ingressRuntime.recover(target.path, ingressOwnerId);
        const replayable = yield* ingressRuntime.replayable(target.path);
        let health = initialSlackHealth(healthRuntime.now());
        const healthPermit = Semaphore.makeUnsafe(1);
        const observe = (event: SlackHealthEvent): Effect.Effect<void> =>
          healthPermit.withPermit(
            Effect.sync(() => {
              health = evolveSlackHealth(health, event);
              return health;
            }).pipe(
              Effect.flatMap((snapshot) => healthRuntime.write(target.path, snapshot)),
              Effect.catch((failure) =>
                Effect.sync(() => {
                  console.error(`[slack] health observation failed: ${failure.message}`);
                }),
              ),
            ),
          );
        yield* healthRuntime.write(target.path, health).pipe(
          Effect.catch((failure) =>
            Effect.sync(() => {
              console.error(`[slack] health observation failed: ${failure.message}`);
            }),
          ),
        );
        const bot = yield* transport.authTest(config.botToken).pipe(
          Effect.tapError((failure) =>
            observe({
              _tag: "failed",
              atMs: healthRuntime.now(),
              failure: failure.reason === "authentication" ? "authentication" : "connection",
            }),
          ),
        );
        const chats = new Map<string, ChatState>();
        let reactionsAvailable = true;
        const admitInbound: SlackSocketInboundAdmit = (inbound, eventId) => {
          const admission = classifySlackCommand(
            inbound,
            bot.userId,
            config.ownerUserId,
            config.channelMode ?? "always",
          );
          if (admission.kind === "ignored") {
            if (admission.reason === "mention-required") {
              console.log(
                `[slack] ignored owner channel message reason:mention-required channel:${inbound.channel}`,
              );
            }
            return Effect.succeed("acknowledge");
          }
          return ingressRuntime
            .admit(
              target.path,
              {
                ...(eventId === undefined ? {} : { eventId }),
                payload: admission.message,
              },
              healthRuntime.now(),
            )
            .pipe(
              Effect.map((result) => (result === "accepted" ? "deliver" : "acknowledge")),
              Effect.mapError(ingressSocketFailure),
            );
        };
        const socket = yield* transport.openSocket(config.appToken, admitInbound).pipe(
          Effect.tapError((failure) =>
            observe({
              _tag: "failed",
              atMs: healthRuntime.now(),
              failure: failure.reason === "authentication" ? "authentication" : "socket",
            }),
          ),
          Effect.mapError(socketFailure),
        );
        console.log(
          `[slack] authenticated; socket supervisor started; channel-mode:${config.channelMode ?? "always"}`,
        );
        yield* Effect.addFinalizer(() =>
          Effect.all(
            [
              socket.close.pipe(
                Effect.catch((failure) =>
                  Effect.logWarning("Slack socket close failed", { failure }),
                ),
              ),
              disposeChats(chats),
            ],
            { concurrency: "unbounded", discard: true },
          ).pipe(Effect.andThen(observe({ _tag: "stopped", atMs: healthRuntime.now() }))),
        );
        yield* socket.nextConnectionState.pipe(
          Effect.flatMap((state) =>
            observe(
              state.state === "connected"
                ? { _tag: "connected", atMs: healthRuntime.now() }
                : {
                    _tag: "reconnecting",
                    atMs: healthRuntime.now(),
                    failure: state.failure,
                  },
            ),
          ),
          Effect.forever,
          Effect.forkScoped,
        );
        yield* healthRuntime.waitForHeartbeat.pipe(
          Effect.andThen(
            Effect.suspend(() => observe({ _tag: "heartbeat", atMs: healthRuntime.now() })),
          ),
          Effect.forever,
          Effect.forkScoped,
        );

        const chatStateFor = (chatKey: string): ChatState => {
          const existing = chats.get(chatKey);
          if (existing !== undefined) return existing;
          const created: ChatState = {
            semaphore: Semaphore.makeUnsafe(1),
            statusSemaphore: Semaphore.makeUnsafe(1),
            turns: new Set(),
            generation: 0,
            pending: 0,
          };
          chats.set(chatKey, created);
          return created;
        };

        const processMessage = (turn: ScheduledSlackTurn, chatState: ChatState, queued: boolean) =>
          Effect.gen(function* () {
            const message = turn.message;
            const isFresh = () => !turn.cancelled && chatState.generation === turn.generation;
            let deliveryUnknown = false;
            const accepted = observe({
              _tag: "accepted",
              atMs: healthRuntime.now(),
              queued,
            });

            const updateStatus = (status: string) =>
              chatState.statusSemaphore.withPermit(
                Effect.suspend(() =>
                  isFresh()
                    ? transport
                        .setStatus(config.botToken, message.channel, message.statusThreadTs, status)
                        .pipe(
                          Effect.catch((failure) =>
                            Effect.sync(() => {
                              console.error(
                                `[slack] ${message.chatKey} status update failed: ${failure.message}`,
                              );
                            }),
                          ),
                        )
                    : Effect.void,
                ),
              );

            const logFeedbackFailure = (kind: string, failure: SlackApiError) =>
              Effect.sync(() => {
                console.error(`[slack] ${message.chatKey} ${kind} failed: ${failure.message}`);
              });

            const logMessageDeliveryFailure = (kind: string, failure: SlackApiError) =>
              Effect.sync(() => {
                if (deliveryOutcomeUnknown(failure)) deliveryUnknown = true;
                console.error(`[slack] ${message.chatKey} ${kind} failed: ${failure.message}`);
              });

            const runProgress = (
              workingMessage: { readonly ts: string } | undefined,
              initialAtMs: number,
              statusSignals: Queue.Dequeue<SlackProgressSignal>,
              textSignals: Queue.Dequeue<SlackProgressSignal>,
            ): Effect.Effect<never> =>
              Effect.gen(function* () {
                let latestText = "";
                let lastStatus = "is thinking...";
                let lastPlaceholder: SlackProgressUpdateState = {
                  atMs: initialAtMs,
                  text: "",
                };

                const publishStatus = (status: string) =>
                  Effect.suspend(() => {
                    if (!isFresh() || status === lastStatus) return Effect.void;
                    lastStatus = status;
                    return updateStatus(status);
                  });
                const publishText = () =>
                  Effect.suspend(() => {
                    if (
                      !isFresh() ||
                      workingMessage === undefined ||
                      !shouldUpdateSlackProgress(lastPlaceholder, latestText, healthRuntime.now())
                    ) {
                      return Effect.void;
                    }
                    const text = slackMessageChunks(latestText)[0];
                    if (text === undefined) return Effect.void;
                    lastPlaceholder = { atMs: healthRuntime.now(), text: latestText };
                    return transport
                      .updateMessage(config.botToken, message.channel, workingMessage.ts, text)
                      .pipe(
                        Effect.catch((failure) =>
                          logFeedbackFailure("progress message update", failure),
                        ),
                      );
                  });
                while (true) {
                  const signal = yield* Effect.raceFirst(
                    Queue.take(statusSignals),
                    Queue.take(textSignals),
                  );
                  if (!isFresh()) continue;
                  if (signal.kind === "text") {
                    latestText = signal.snapshot;
                    yield* publishText();
                    continue;
                  }
                  yield* publishText();
                  yield* publishStatus(signal.status);
                }
              });

            const offerProgressHeartbeats = (
              signals: Queue.Enqueue<SlackProgressSignal>,
              activeToolStatus: () => string | undefined,
            ) =>
              Effect.gen(function* () {
                let elapsedSeconds = HEARTBEAT_SECONDS;
                while (true) {
                  yield* Effect.sleep(Duration.seconds(HEARTBEAT_SECONDS));
                  yield* Queue.offer(signals, {
                    kind: "status",
                    status: activeToolStatus() ?? `is still working... (${elapsedSeconds}s)`,
                  });
                  elapsedSeconds += HEARTBEAT_SECONDS;
                }
              });

            const reaction = (operation: "add" | "remove", name: string) => {
              if (!reactionsAvailable) return Effect.void;
              const effect =
                operation === "add"
                  ? transport.addReaction(config.botToken, message.channel, message.sourceTs, name)
                  : transport.removeReaction(
                      config.botToken,
                      message.channel,
                      message.sourceTs,
                      name,
                    );
              return effect.pipe(
                Effect.catch((failure) =>
                  Effect.gen(function* () {
                    if (failure.reason === "authentication") reactionsAvailable = false;
                    yield* logFeedbackFailure(`${operation} ${name} reaction`, failure);
                  }),
                ),
              );
            };

            const acquireFeedback = Effect.gen(function* () {
              if (!isFresh()) return undefined;
              yield* reaction("add", "eyes");
              yield* updateStatus(queued ? "is queued..." : "is thinking...");
              return yield* transport
                .postMessage(
                  config.botToken,
                  message.channel,
                  queued ? QUEUED_MESSAGE : WORKING_MESSAGE,
                  message.threadTs,
                )
                .pipe(
                  Effect.catch((failure) =>
                    logMessageDeliveryFailure("working message", failure).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                );
            });

            const work = Effect.acquireUseRelease(
              acquireFeedback,
              (workingMessage) =>
                chatState.semaphore.withPermit(
                  Effect.gen(function* () {
                    if (!isFresh()) return yield* Effect.interrupt;
                    yield* observe({
                      _tag: "started",
                      atMs: healthRuntime.now(),
                      wasQueued: queued,
                    });
                    if (queued) {
                      yield* updateStatus("is thinking...");
                      if (workingMessage !== undefined) {
                        yield* transport
                          .updateMessage(
                            config.botToken,
                            message.channel,
                            workingMessage.ts,
                            WORKING_MESSAGE,
                          )
                          .pipe(
                            Effect.catch((failure) =>
                              logMessageDeliveryFailure("queued-message update", failure),
                            ),
                          );
                      }
                    }

                    const handle =
                      chatState.handle ??
                      (yield* agent.openChat(
                        target,
                        message.context,
                        join(target.path, "sessions", "slack", message.chatKey),
                      ));
                    chatState.handle = handle;

                    const reply = yield* Effect.scoped(
                      Effect.gen(function* () {
                        const progressStartedAtMs = healthRuntime.now();
                        const statusSignals = yield* Queue.sliding<SlackProgressSignal>(1);
                        const textSignals = yield* Queue.sliding<SlackProgressSignal>(1);
                        const activeTools = new Map<string, string>();
                        const activeToolStatus = (): string | undefined => {
                          const names = [...activeTools.values()];
                          const name = names[names.length - 1];
                          return name === undefined ? undefined : `Using ${name}…`;
                        };
                        yield* offerProgressHeartbeats(statusSignals, activeToolStatus).pipe(
                          Effect.forkScoped,
                        );
                        yield* runProgress(
                          workingMessage,
                          progressStartedAtMs,
                          statusSignals,
                          textSignals,
                        ).pipe(Effect.forkScoped);
                        const resolveFile = transport.downloadFile;
                        const prompt = yield* prepareSlackAttachmentPrompt(
                          message,
                          resolveFile === undefined
                            ? undefined
                            : (file) => resolveFile(config.botToken, file),
                        );
                        return yield* handle.prompt(prompt.text, {
                          ...(prompt.images.length === 0 ? {} : { images: prompt.images }),
                          onProgress: (event) => {
                            if (!isFresh()) return;
                            if (event.kind === "assistant-text") {
                              Queue.offerUnsafe(textSignals, {
                                kind: "text",
                                snapshot: event.snapshot,
                              });
                              return;
                            }
                            if (event.phase === "end") {
                              activeTools.delete(event.toolCallId);
                            } else {
                              activeTools.delete(event.toolCallId);
                              if (activeTools.size >= 16) {
                                const oldest = activeTools.keys().next().value;
                                if (oldest !== undefined) activeTools.delete(oldest);
                              }
                              activeTools.set(event.toolCallId, event.toolName);
                            }
                            Queue.offerUnsafe(statusSignals, {
                              kind: "status",
                              status: activeToolStatus() ?? "is thinking...",
                            });
                          },
                        });
                      }),
                    );
                    if (!isFresh()) return yield* Effect.interrupt;
                    const replyChunks = slackMessageChunks(reply);
                    const chunks = replyChunks.length === 0 ? ["Done."] : replyChunks;
                    const firstChunk = chunks[0];
                    let firstUnsentChunk = 0;
                    if (workingMessage !== undefined && firstChunk !== undefined) {
                      if (!isFresh()) return yield* Effect.interrupt;
                      const updateResult = yield* retrySlackDelivery("update", () =>
                        transport.updateMessage(
                          config.botToken,
                          message.channel,
                          workingMessage.ts,
                          firstChunk,
                        ),
                      ).pipe(Effect.result);
                      if (Result.isSuccess(updateResult)) {
                        firstUnsentChunk = 1;
                      } else {
                        yield* logFeedbackFailure(
                          deliveryOutcomeUnknown(updateResult.failure)
                            ? "final working-message update outcome unknown"
                            : "final working-message update",
                          updateResult.failure,
                        );
                        if (deliveryOutcomeUnknown(updateResult.failure)) {
                          deliveryUnknown = true;
                          firstUnsentChunk = 1;
                        }
                      }
                    }
                    for (const chunk of chunks.slice(firstUnsentChunk)) {
                      if (!isFresh()) return yield* Effect.interrupt;
                      yield* retrySlackDelivery("post", () =>
                        transport.postMessage(
                          config.botToken,
                          message.channel,
                          chunk,
                          message.threadTs,
                        ),
                      ).pipe(
                        Effect.tapError((failure) =>
                          logMessageDeliveryFailure("final message post", failure),
                        ),
                      );
                    }
                    console.log(
                      `[slack] ${message.chatKey} in:${codePointLength(message.text)} out:${codePointLength(reply)} chars`,
                    );
                  }),
                ),
              (workingMessage, exit) =>
                Effect.gen(function* () {
                  const cancelled = turn.cancelled;
                  const terminalState = cancelled
                    ? ("cancelled" as const)
                    : slackIngressTerminalState(deliveryUnknown, Exit.isSuccess(exit));
                  yield* Effect.all(
                    [
                      reaction("remove", "eyes"),
                      reaction(
                        "add",
                        terminalState === "completed"
                          ? "white_check_mark"
                          : terminalState === "cancelled"
                            ? "octagonal_sign"
                            : "x",
                      ),
                    ],
                    { concurrency: "unbounded", discard: true },
                  );
                  yield* Effect.all(
                    [
                      isFresh() ? updateStatus("") : Effect.void,
                      workingMessage !== undefined && (cancelled || Exit.isFailure(exit))
                        ? transport
                            .updateMessage(
                              config.botToken,
                              message.channel,
                              workingMessage.ts,
                              cancelled ? STOPPED_MESSAGE : FAILED_MESSAGE,
                            )
                            .pipe(
                              Effect.catch((failure) =>
                                logMessageDeliveryFailure(
                                  cancelled ? "stopped-message update" : "failure-message update",
                                  failure,
                                ),
                              ),
                            )
                        : Effect.void,
                    ],
                    { concurrency: "unbounded", discard: true },
                  );
                  yield* observe(
                    terminalState === "cancelled"
                      ? { _tag: "cancelled", atMs: healthRuntime.now() }
                      : {
                          _tag: "completed",
                          atMs: healthRuntime.now(),
                          succeeded: terminalState === "completed",
                        },
                  );
                  turn.terminalAttempted = true;
                  yield* ingressRuntime.finish(
                    target.path,
                    message,
                    ingressOwnerId,
                    terminalState,
                    healthRuntime.now(),
                  );
                }),
            );

            yield* accepted.pipe(
              Effect.andThen(work),
              Effect.catch((failure: ZiggyAgentError | SlackApiError | SlackIngressDatabaseError) =>
                Effect.sync(() => {
                  console.error(`[slack] ${message.chatKey} failed: ${failure.message}`);
                }),
              ),
            );
          });

        const registerMessage = (message: InboundMessage) =>
          Effect.gen(function* () {
            const started = yield* ingressRuntime.start(
              target.path,
              message,
              ingressOwnerId,
              healthRuntime.now(),
            );
            if (!started) return;
            const chatState = chatStateFor(message.chatKey);
            const queued = chatState.pending > 0;
            const cancellation = yield* Deferred.make<void>();
            const turn: ScheduledSlackTurn = {
              cancellation,
              generation: chatState.generation,
              message,
              cancelled: false,
              terminalAttempted: false,
            };
            chatState.turns.add(turn);
            chatState.pending += 1;
            const cancelled = Deferred.await(cancellation).pipe(Effect.as("cancelled" as const));
            const cleanup = Effect.gen(function* () {
              if (turn.cancelled && !turn.terminalAttempted) {
                turn.terminalAttempted = true;
                yield* ingressRuntime
                  .finish(target.path, message, ingressOwnerId, "cancelled", healthRuntime.now())
                  .pipe(
                    Effect.catch((failure) =>
                      Effect.sync(() => {
                        console.error(
                          `[slack] ${message.chatKey} cancelled ingress settlement failed: ${failure.message}`,
                        );
                      }),
                    ),
                  );
              }
              chatState.turns.delete(turn);
              chatState.pending = Math.max(0, chatState.pending - 1);
            });
            return Effect.suspend(() =>
              turn.cancelled
                ? Effect.void
                : Effect.raceFirst(
                    processMessage(turn, chatState, queued).pipe(Effect.as("settled" as const)),
                    cancelled,
                  ).pipe(Effect.asVoid),
            ).pipe(Effect.ensuring(cleanup));
          });

        const scheduleMessage = (message: InboundMessage) =>
          Effect.gen(function* () {
            const work = yield* registerMessage(message);
            if (work !== undefined) yield* work.pipe(Effect.forkScoped);
          });

        const stopMessage = (message: InboundMessage) =>
          Effect.gen(function* () {
            const started = yield* ingressRuntime.start(
              target.path,
              message,
              ingressOwnerId,
              healthRuntime.now(),
            );
            if (!started) return;
            const chatState = chatStateFor(message.chatKey);
            chatState.generation += 1;
            const cancelled = [...chatState.turns].filter(
              (turn) => turn.generation < chatState.generation && !turn.terminalAttempted,
            );
            for (const turn of cancelled) turn.cancelled = true;
            yield* Effect.forEach(
              cancelled,
              (turn) => Deferred.succeed(turn.cancellation, undefined),
              { discard: true },
            );
            const cancelledStatusTargets = uniqueSlackStatusTargets(
              cancelled.map((turn) => turn.message),
            );
            yield* chatState.statusSemaphore.withPermit(
              Effect.forEach(
                cancelledStatusTargets,
                (target) =>
                  transport.setStatus(config.botToken, target.channel, target.threadTs, "").pipe(
                    Effect.catch((failure) =>
                      Effect.sync(() => {
                        console.error(
                          `[slack] ${message.chatKey} stop status clear failed: ${failure.message}`,
                        );
                      }),
                    ),
                  ),
                { discard: true },
              ),
            );
            yield* ingressRuntime.finish(
              target.path,
              message,
              ingressOwnerId,
              "completed",
              healthRuntime.now(),
            );
            const acknowledgement =
              cancelled.length === 0
                ? "Nothing was running."
                : `Stopped ${cancelled.length} ${cancelled.length === 1 ? "request" : "requests"}.`;
            yield* Effect.all(
              [
                transport
                  .postMessage(config.botToken, message.channel, acknowledgement, message.threadTs)
                  .pipe(
                    Effect.catch((failure) =>
                      Effect.sync(() => {
                        console.error(
                          `[slack] ${message.chatKey} stop acknowledgement failed: ${failure.message}`,
                        );
                      }),
                    ),
                  ),
                reactionsAvailable
                  ? transport
                      .addReaction(
                        config.botToken,
                        message.channel,
                        message.sourceTs,
                        "white_check_mark",
                      )
                      .pipe(
                        Effect.catch((failure) =>
                          Effect.sync(() => {
                            if (failure.reason === "authentication") reactionsAvailable = false;
                            console.error(
                              `[slack] ${message.chatKey} stop reaction failed: ${failure.message}`,
                            );
                          }),
                        ),
                      )
                  : Effect.void,
              ],
              { concurrency: "unbounded", discard: true },
            ).pipe(Effect.forkScoped);
          });

        const dispatchMessage = (message: InboundMessage) =>
          isSlackStopCommand(message.text) ? stopMessage(message) : scheduleMessage(message);

        const replayWork: Array<Effect.Effect<void>> = [];
        for (const recovered of replayable) {
          console.log(`[slack] replaying durable ingress ${recovered.payload.chatKey}`);
          if (isSlackStopCommand(recovered.payload.text)) {
            yield* stopMessage(recovered.payload);
          } else {
            const work = yield* registerMessage(recovered.payload);
            if (work !== undefined) replayWork.push(work);
          }
        }
        yield* Effect.forEach(replayWork, (work) => work, {
          concurrency: 4,
          discard: true,
        }).pipe(Effect.forkScoped);

        while (true) {
          const inbound = yield* socket.next.pipe(
            Effect.tapError((failure) =>
              observe({
                _tag: "failed",
                atMs: healthRuntime.now(),
                failure:
                  failure.reason === "authentication"
                    ? "authentication"
                    : failure.reason === "queue-overflow"
                      ? "queue-overflow"
                      : "socket",
              }),
            ),
            Effect.mapError(socketFailure),
          );
          yield* observe({ _tag: "inbound", atMs: healthRuntime.now() });
          const admission = classifySlackCommand(
            inbound,
            bot.userId,
            config.ownerUserId,
            config.channelMode ?? "always",
          );
          if (admission.kind !== "ignored") {
            console.log(
              `[slack] admitted ${admission.message.chatKey} activation:${config.channelMode ?? "always"}`,
            );
            yield* dispatchMessage(admission.message);
          } else if (admission.reason === "mention-required") {
            console.log(
              `[slack] ignored owner channel message reason:mention-required channel:${inbound.channel}`,
            );
          }
        }
      }),
    ),
});

export const SlackGatewayLive = Layer.effect(
  SlackGateway,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    return makeSlackGateway(
      agent,
      liveSlackTransport,
      liveSlackHealthRuntime,
      liveSlackIngressRuntime,
    );
  }),
);
