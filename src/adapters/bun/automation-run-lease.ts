import { Database, SQLiteError } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import type { ProfileTarget } from "../../domain/profile";

export class AutomationRunLeaseError extends Schema.TaggedErrorClass<AutomationRunLeaseError>()(
  "AutomationRunLeaseError",
  {
    automationId: Schema.String,
    path: Schema.String,
    busy: Schema.Boolean,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

interface AutomationRunLease {
  readonly database: Database;
  readonly path: string;
}

const acquire = (
  target: ProfileTarget,
  automationId: string,
): Effect.Effect<AutomationRunLease, AutomationRunLeaseError> =>
  Effect.tryPromise({
    try: async () => {
      const path = join(
        target.path,
        ".runtime",
        "automations",
        "run-leases",
        `${encodeURIComponent(automationId)}.sqlite`,
      );
      await mkdir(dirname(path), { recursive: true });
      const database = new Database(path, { create: true });
      try {
        database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
        return { database, path };
      } catch (cause) {
        database.close();
        throw cause;
      }
    },
    catch: (cause) => {
      const path = join(
        target.path,
        ".runtime",
        "automations",
        "run-leases",
        `${encodeURIComponent(automationId)}.sqlite`,
      );
      const busy = cause instanceof SQLiteError && cause.code?.startsWith("SQLITE_BUSY") === true;
      return new AutomationRunLeaseError({
        automationId,
        path,
        busy,
        message: busy
          ? `automation ${automationId} is already running`
          : `could not acquire the run lease for automation ${automationId}`,
        cause,
      });
    },
  });

const release = (lease: AutomationRunLease): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      if (lease.database.inTransaction) {
        lease.database.exec("ROLLBACK");
      }
    } finally {
      lease.database.close();
    }
  });

export const withAutomationRunLease = <A, E>(
  target: ProfileTarget,
  automationId: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E | AutomationRunLeaseError> =>
  Effect.acquireUseRelease(acquire(target, automationId), () => effect, release);
