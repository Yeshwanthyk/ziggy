import { Context, Effect, Layer } from "effect";
import { listProfileSessions, showProfileSession } from "../adapters/pi/sessions";
import type { ProfileTarget } from "../domain/profile";
import type { SessionMetadata, SessionNotFound, SessionReadFailed } from "../domain/session";

export type SessionsError = SessionReadFailed | SessionNotFound;

export interface SessionsShape {
  readonly list: (
    target: ProfileTarget,
  ) => Effect.Effect<ReadonlyArray<SessionMetadata>, SessionReadFailed>;
  readonly show: (
    target: ProfileTarget,
    reference: string,
  ) => Effect.Effect<SessionMetadata, SessionsError>;
}

export class Sessions extends Context.Service<Sessions, SessionsShape>()("ziggy/Sessions") {}

export const SessionsLive = Layer.succeed(Sessions, {
  list: (target) => listProfileSessions(target.path),
  show: (target, reference) => showProfileSession(target.path, reference),
});
