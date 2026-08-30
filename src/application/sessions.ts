import { Context, Effect, Layer } from "effect";
import { listProfileSessions, showProfileSession } from "../adapters/pi/sessions";
import { readSessionHistory } from "../adapters/pi/session-history";
import type { ProfileTarget } from "../domain/profile";
import { SessionNotFound, type SessionHistoryCursorInvalid, type SessionHistoryPage } from "../domain/session";
import type { SessionMetadata, SessionReadFailed } from "../domain/session";

export type SessionsError = SessionReadFailed | SessionNotFound;

export interface SessionsApi {
  readonly list: (
    target: ProfileTarget,
  ) => Effect.Effect<ReadonlyArray<SessionMetadata>, SessionReadFailed>;
  readonly show: (
    target: ProfileTarget,
    reference: string,
  ) => Effect.Effect<SessionMetadata, SessionsError>;
  readonly resolve: (
    target: ProfileTarget,
    id: string,
  ) => Effect.Effect<SessionMetadata, SessionsError>;
  readonly history?: (
    target: ProfileTarget,
    reference: string,
    before?: string,
  ) => Effect.Effect<SessionHistoryPage, SessionsError | SessionHistoryCursorInvalid>;
}

export class Sessions extends Context.Service<Sessions, SessionsApi>()("ziggy/Sessions") {}

export const SessionsLive = Layer.succeed(Sessions, {
  list: (target) => listProfileSessions(target.path),
  show: (target, reference) => showProfileSession(target.path, reference),
  resolve: (target, id) =>
    Effect.gen(function* () {
      const sessions = yield* listProfileSessions(target.path);
      const session = sessions.find((candidate) => candidate.id === id);
      if (session !== undefined) return session;
      return yield* new SessionNotFound({
        reference: id,
        message: `session not found: ${id}`,
      });
    }),
  history: (target, reference, before) => readSessionHistory(target.path, reference, before),
});
