/**
 * Device chat on live sessions: each device talks to the Profile in its own session under
 * `sessions/device/<id>`, kept live as `device/<id>` so the web UI can watch it.
 */
import { join } from "node:path";
import { Effect } from "effect";
import type { ZiggyAgentError } from "../domain/agent";
import type { ProfileTarget } from "../profile";
import { type DeviceChat, type DeviceChatEvent, DeviceChatRefused } from "../devices";
import type { ChatHandle, ZiggyAgentApi } from "../session";
import type { LiveSessionsApi } from "./live-sessions";

const ABORTED = "the turn was aborted";

const failureText = (cause: ZiggyAgentError) =>
  cause.message.length > 0 ? cause.message.slice(0, 360) : "the turn failed";

export const makeDeviceChat = (
  target: ProfileTarget,
  agent: ZiggyAgentApi,
  live: LiveSessionsApi,
): DeviceChat => {
  /** Devices whose running turn was aborted, so it ends with an error whatever Pi returns. */
  const aborted = new Set<string>();

  const turn = (
    deviceId: string,
    text: string,
    emit: (event: DeviceChatEvent) => void,
    handle: ChatHandle,
  ) =>
    Effect.suspend(() => {
      let ended = false;

      let state: "thinking" | "tool" | "text" = "thinking";

      const end = (event: DeviceChatEvent) => {
        if (ended) return;

        ended = true;
        emit(aborted.delete(deviceId) ? { kind: "error", message: ABORTED } : event);
      };

      aborted.delete(deviceId);
      emit({ kind: "thinking" });

      return handle
        .prompt(text, {
          onProgress: (event) => {
            if (event.kind === "assistant-text" && event.delta.length > 0) {
              state = "text";
              emit({ kind: "delta", text: event.delta });
            } else if (event.kind === "tool" && event.phase === "start") {
              state = "tool";
              emit({ kind: "tool", tool: event.toolName });
            } else if (event.kind === "tool" && event.phase === "end" && state === "tool") {
              state = "thinking";
              emit({ kind: "thinking" });
            }
          },
        })
        .pipe(
          Effect.tap((reply) => Effect.sync(() => end({ kind: "done", text: reply }))),
          Effect.catch((cause) =>
            Effect.sync(() => end({ kind: "error", message: failureText(cause) })).pipe(
              Effect.andThen(Effect.logWarning("device chat turn failed", { deviceId, cause })),
            ),
          ),
          Effect.ensuring(Effect.sync(() => end({ kind: "error", message: ABORTED }))),
        );
    });

  return {
    start: (device, text, emit) => {
      const key = `device/${device.id}`;

      const open = agent.open({
        target,
        context: { kind: "user", userId: "owner" },
        directory: join(target.path, "sessions", "device", device.id),
        session: "continue",
        name: `Device · ${device.name}`,
      });

      return live.acquire(key, "device", open).pipe(
        Effect.andThen(live.runExclusive(key, (handle) => turn(device.id, text, emit, handle))),
        Effect.mapError(
          (refused) =>
            new DeviceChatRefused({
              reason: refused.reason === "busy" ? "busy" : "unavailable",
              message: refused.reason === "busy" ? "a turn is running" : refused.message,
            }),
        ),
      );
    },
    abort: (device) => {
      const key = `device/${device.id}`;

      return live.get(key).pipe(
        Effect.flatMap((entry) =>
          entry.idle
            ? Effect.void
            : Effect.sync(() => aborted.add(device.id)).pipe(
                Effect.andThen(entry.handle.abort),
                Effect.ensuring(live.interrupt(key)),
              ),
        ),
        Effect.catch((cause) => Effect.logWarning("device chat abort failed", { key, cause })),
      );
    },
  };
};
