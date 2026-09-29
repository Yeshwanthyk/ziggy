import { Effect, Result, Semaphore } from "effect";
import type { SlackApiError, SlackStreamChunk } from "../../adapters/slack/api";
import {
  reduceTurnProgress,
  type TurnProgress,
  type TurnProgressEvent,
} from "../../domain/slack-turn-progress";
import { slackMessageChunks } from "./delivery";
import type { SlackTransport } from "./model";

// Serialized with the turn's text and tool queue. A successful stream start owns the
// message until stop, including when the agent fails or is interrupted.
export const makeTurnProgress = (
  transport: SlackTransport,
  token: string,
  channel: string,
  threadTs: string,
  recipient: { readonly userId: string; readonly teamId: string } | undefined,
  now: () => number,
  log: (kind: string, failure: SlackApiError) => Effect.Effect<void>,
) => {
  let progress: TurnProgress | undefined;
  let sent: TurnProgress | undefined;
  let ts: string | undefined;
  let appended = "";
  let snapshot = "";
  let diverged = false;
  let closed = false;
  let delivered = false;
  let lastPlanAt = 0;
  const permit = Semaphore.makeUnsafe(1);

  const render = () =>
    Effect.gen(function* () {
      const append = transport.appendStream;

      if (progress === undefined || ts === undefined || closed || append === undefined) return;
      const chunks: Array<SlackStreamChunk> = [];

      for (const step of progress.steps) {
        const old = sent?.steps.find((item) => item.id === step.id);

        if (old?.title === step.title && old.status === step.status && old.details === step.details)
          continue;
        chunks.push({
          type: "task_update",
          id: step.id,
          title: step.title,
          status: step.status,
          ...(step.details !== undefined ? { details: step.details } : undefined),
        });
      }

      if (
        sent?.headline !== progress.headline &&
        (chunks.length > 0 || now() - lastPlanAt >= 10_000)
      ) {
        chunks.unshift({ type: "plan_update", title: progress.headline });
      }

      const boundary = slackMessageChunks(snapshot)[0] ?? "";
      // Once a boundary has been streamed it cannot move backward when a later
      // snapshot introduces a newline or whitespace before the 4,000th character.
      const answer = boundary.startsWith(appended) ? boundary : appended;

      if (!slackMessageChunks(snapshot).join("").startsWith(appended)) diverged = true;
      const suffix = !diverged ? answer.slice(appended.length) : "";

      if (chunks.length === 0 && suffix.length === 0) return;

      const result = yield* append(token, channel, ts, chunks, suffix || undefined).pipe(
        Effect.result,
      );

      if (Result.isFailure(result)) {
        diverged = true; // A timed-out append may have committed: correct after stop, never resend it.
        yield* log("stream append", result.failure);

        return;
      }

      if (!diverged) appended = answer;

      if (chunks.some((chunk) => chunk.type === "plan_update")) lastPlanAt = now();
      sent = progress;
    });

  const change = (event: TurnProgressEvent, text?: string) =>
    permit.withPermit(
      Effect.gen(function* () {
        progress = reduceTurnProgress(progress, event);

        if (text !== undefined) snapshot = text;
        yield* render();
      }),
    );

  return {
    get started() {
      return ts !== undefined;
    },
    get headline() {
      return progress?.headline ?? "Thinking";
    },
    start: (queued: boolean, eligible: boolean) =>
      permit.withPermit(
        Effect.gen(function* () {
          progress = reduceTurnProgress(undefined, { kind: "start", atMs: now(), queued });

          if (
            !eligible ||
            transport.startStream === undefined ||
            transport.appendStream === undefined ||
            transport.stopStream === undefined
          )
            return false;

          const result = yield* transport
            .startStream(token, channel, threadTs, {
              chunks: [{ type: "plan_update", title: progress.headline }],
              ...(recipient === undefined
                ? undefined
                : { recipientUserId: recipient.userId, recipientTeamId: recipient.teamId }),
            })
            .pipe(Effect.result);

          if (Result.isFailure(result)) {
            // A timeout may have created a stream, but without a returned ts we
            // cannot stop it. The fallback can leave an orphan plan.
            yield* log("stream start", result.failure);

            return false;
          }

          ts = result.success.ts;
          sent = progress;
          lastPlanAt = now();

          return true;
        }),
      ),
    change,
    text: (value: string) =>
      permit.withPermit(
        Effect.gen(function* () {
          snapshot = value;
          yield* render();
        }),
      ),
    finish: (outcome: "done" | "stopped" | "failed", finalText?: string) =>
      Effect.uninterruptible(
        permit.withPermit(
          Effect.gen(function* () {
            if (closed) return delivered;

            if (progress === undefined) return false;
            progress = reduceTurnProgress(progress, { kind: "finish", atMs: now(), outcome });

            const final =
              slackMessageChunks(
                finalText ??
                  (outcome === "stopped" ? "Stopped." : "I couldn't complete that request."),
              ).join("") || "Done.";

            if (ts === undefined || transport.stopStream === undefined) return false;
            const streamTs = ts;

            // Preserve the plan and partial answer. Divergent text needs a separate
            // follow-up, not a chat.update that would erase the stream's plan.
            const extendsStream = !diverged && final.startsWith(appended);
            const remaining = extendsStream ? final.slice(appended.length) : "";
            const suffix = [...remaining].slice(0, 4_000 - [...appended].length).join("");

            const chunks: Array<SlackStreamChunk> = [
              { type: "plan_update", title: progress.headline },
            ];

            for (const step of progress.steps)
              chunks.push({
                type: "task_update",
                id: step.id,
                title: step.title,
                status: step.status,
                ...(step.details !== undefined ? { details: step.details } : undefined),
              });

            const result = yield* transport
              .stopStream(token, channel, streamTs, suffix || undefined, chunks)
              .pipe(Effect.result);

            closed = true;

            if (Result.isFailure(result)) yield* log("stream stop", result.failure);

            // The stream owns the prefix; post only the rest, never chunk zero
            // again after its boundary shifted during streaming.
            delivered = extendsStream && (Result.isSuccess(result) || appended === final);

            if (delivered) {
              for (const chunk of slackMessageChunks(remaining.slice(suffix.length))) {
                const post = yield* transport
                  .postMessage(token, channel, chunk, threadTs)
                  .pipe(Effect.result);

                if (Result.isFailure(post)) {
                  yield* log("stream overflow follow-up", post.failure);
                  delivered = false;
                  break;
                }
              }
            }

            if (!delivered && outcome === "done" && !extendsStream) {
              delivered = true;

              for (const chunk of slackMessageChunks(final)) {
                const correction = yield* transport
                  .postMessage(token, channel, chunk, threadTs)
                  .pipe(Effect.result);

                if (Result.isFailure(correction)) {
                  yield* log("stream final follow-up", correction.failure);
                  delivered = false;
                  break;
                }
              }
            }

            return delivered;
          }),
        ),
      ),
  };
};
