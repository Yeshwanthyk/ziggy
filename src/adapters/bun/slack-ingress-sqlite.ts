import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import {
  SlackIngressDatabaseError,
  SlackIngressFileReference,
  type SlackIngressPayload,
  type SlackIngressRecord,
  type SlackIngressTerminalState,
} from "../../domain/slack-ingress";

const DATABASE_NAME = "slack-ingress.sqlite";
const MAX_TERMINAL_ROWS = 1_000;
const EMPTY_FILES_JSON = '{"files":[],"omittedFileCount":0}';
const SCHEMA_V1 = `
CREATE TABLE slack_ingress (
  channel TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  event_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('received', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
  owner_id TEXT,
  chat_key TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('user', 'group')),
  context_id TEXT NOT NULL,
  status_thread_ts TEXT NOT NULL,
  text TEXT NOT NULL,
  thread_ts TEXT,
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  started_at_ms INTEGER CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms >= 0),
  PRIMARY KEY (channel, source_ts),
  CHECK (length(channel) > 0 AND length(source_ts) > 0 AND length(chat_key) > 0
    AND length(context_id) > 0 AND length(status_thread_ts) > 0),
  CHECK ((state IN ('received', 'running') AND length(text) > 0)
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown') AND length(text) = 0)),
  CHECK (owner_id IS NULL OR length(owner_id) > 0),
  CHECK ((state = 'received' AND owner_id IS NULL AND started_at_ms IS NULL AND finished_at_ms IS NULL)
    OR (state = 'running' AND owner_id IS NOT NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NULL)
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown') AND owner_id IS NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NOT NULL))
) STRICT;
CREATE INDEX slack_ingress_replay ON slack_ingress(received_at_ms, channel, source_ts)
  WHERE state = 'received';
CREATE INDEX slack_ingress_terminal ON slack_ingress(finished_at_ms DESC, channel, source_ts)
  WHERE state IN ('completed', 'failed', 'cancelled', 'unknown');
PRAGMA user_version = 1;`;
const SCHEMA_V2 = `
CREATE TABLE "slack_ingress" (
  channel TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  event_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('received', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
  owner_id TEXT,
  chat_key TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('user', 'group')),
  context_id TEXT NOT NULL,
  status_thread_ts TEXT NOT NULL,
  text TEXT NOT NULL,
  files_json TEXT NOT NULL,
  thread_ts TEXT,
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  started_at_ms INTEGER CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms >= 0),
  PRIMARY KEY (channel, source_ts),
  CHECK (length(channel) > 0 AND length(source_ts) > 0 AND length(chat_key) > 0
    AND length(context_id) > 0 AND length(status_thread_ts) > 0),
  CHECK (json_valid(files_json) AND json_type(files_json) = 'object'
    AND json_type(files_json, '$.files') = 'array'
    AND json_array_length(files_json, '$.files') <= 4
    AND json_type(files_json, '$.omittedFileCount') = 'integer'
    AND json_extract(files_json, '$.omittedFileCount') >= 0),
  CHECK ((state IN ('received', 'running') AND (length(text) > 0
      OR json_array_length(files_json, '$.files') > 0
      OR json_extract(files_json, '$.omittedFileCount') > 0))
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown')
      AND length(text) = 0 AND files_json = '{"files":[],"omittedFileCount":0}')),
  CHECK (owner_id IS NULL OR length(owner_id) > 0),
  CHECK ((state = 'received' AND owner_id IS NULL AND started_at_ms IS NULL AND finished_at_ms IS NULL)
    OR (state = 'running' AND owner_id IS NOT NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NULL)
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown') AND owner_id IS NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NOT NULL))
) STRICT;
CREATE INDEX slack_ingress_replay ON slack_ingress(received_at_ms, channel, source_ts)
  WHERE state = 'received';
CREATE INDEX slack_ingress_terminal ON slack_ingress(finished_at_ms DESC, channel, source_ts)
  WHERE state IN ('completed', 'failed', 'cancelled', 'unknown');
PRAGMA user_version = 2;`;

const MIGRATE_V1_TO_V2 = `
CREATE TABLE slack_ingress_v2 (
  channel TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  event_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('received', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
  owner_id TEXT,
  chat_key TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('user', 'group')),
  context_id TEXT NOT NULL,
  status_thread_ts TEXT NOT NULL,
  text TEXT NOT NULL,
  files_json TEXT NOT NULL,
  thread_ts TEXT,
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  started_at_ms INTEGER CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms >= 0),
  PRIMARY KEY (channel, source_ts),
  CHECK (length(channel) > 0 AND length(source_ts) > 0 AND length(chat_key) > 0
    AND length(context_id) > 0 AND length(status_thread_ts) > 0),
  CHECK (json_valid(files_json) AND json_type(files_json) = 'object'
    AND json_type(files_json, '$.files') = 'array'
    AND json_array_length(files_json, '$.files') <= 4
    AND json_type(files_json, '$.omittedFileCount') = 'integer'
    AND json_extract(files_json, '$.omittedFileCount') >= 0),
  CHECK ((state IN ('received', 'running') AND (length(text) > 0
      OR json_array_length(files_json, '$.files') > 0
      OR json_extract(files_json, '$.omittedFileCount') > 0))
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown')
      AND length(text) = 0 AND files_json = '{"files":[],"omittedFileCount":0}')),
  CHECK (owner_id IS NULL OR length(owner_id) > 0),
  CHECK ((state = 'received' AND owner_id IS NULL AND started_at_ms IS NULL AND finished_at_ms IS NULL)
    OR (state = 'running' AND owner_id IS NOT NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NULL)
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown') AND owner_id IS NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NOT NULL))
) STRICT;
INSERT INTO slack_ingress_v2
  (channel,source_ts,event_id,state,owner_id,chat_key,context_kind,context_id,status_thread_ts,text,files_json,thread_ts,received_at_ms,started_at_ms,finished_at_ms)
  SELECT channel,source_ts,event_id,state,owner_id,chat_key,context_kind,context_id,status_thread_ts,text,
    '${EMPTY_FILES_JSON}',thread_ts,received_at_ms,started_at_ms,finished_at_ms FROM slack_ingress;
DROP TABLE slack_ingress;
ALTER TABLE slack_ingress_v2 RENAME TO slack_ingress;
CREATE INDEX slack_ingress_replay ON slack_ingress(received_at_ms, channel, source_ts)
  WHERE state = 'received';
CREATE INDEX slack_ingress_terminal ON slack_ingress(finished_at_ms DESC, channel, source_ts)
  WHERE state IN ('completed', 'failed', 'cancelled', 'unknown');
PRAGMA user_version = 2;`;

const VersionRow = Schema.Struct({ userVersion: Schema.Int });
const MasterRow = Schema.Struct({ name: Schema.String, type: Schema.String, sql: Schema.String });
const ReplayRow = Schema.Struct({
  channel: Schema.String,
  sourceTs: Schema.String,
  eventId: Schema.NullOr(Schema.String),
  chatKey: Schema.String,
  contextKind: Schema.Literals(["user", "group"]),
  contextId: Schema.String,
  statusThreadTs: Schema.String,
  text: Schema.String,
  filesJson: Schema.String,
  threadTs: Schema.NullOr(Schema.String),
});
const StoredFiles = Schema.Struct({
  files: Schema.Array(SlackIngressFileReference).check(
    Schema.makeFilter((files) => files.length <= 4, { expected: "at most four Slack files" }),
  ),
  omittedFileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const decodeVersion = Schema.decodeUnknownSync(VersionRow, { onExcessProperty: "error" });
const decodeMaster = Schema.decodeUnknownSync(Schema.Array(MasterRow), {
  onExcessProperty: "error",
});
const decodeReplayRows = Schema.decodeUnknownSync(Schema.Array(ReplayRow), {
  onExcessProperty: "error",
});
const decodeStoredFilesJson = Schema.decodeUnknownSync(Schema.fromJsonString(StoredFiles));

export const slackIngressDatabasePath = (profilePath: string): string =>
  join(profilePath, ".runtime", DATABASE_NAME);

const databaseError = (operation: string, path: string, cause: unknown) =>
  new SlackIngressDatabaseError({
    operation,
    path,
    message: `Slack ingress database ${operation} failed at ${path}`,
    cause,
  });

const schemaObjects = (db: Database) =>
  decodeMaster(
    db
      .query(
        "SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(),
  );
const schemaShape = (objects: ReadonlyArray<typeof MasterRow.Type>) =>
  createHash("sha256").update(JSON.stringify(objects)).digest("hex");
const expectedObjects = ["slack_ingress", "slack_ingress_replay", "slack_ingress_terminal"];
const expectedShape = (schema: string) => {
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec(schema);
    return schemaShape(schemaObjects(db));
  } finally {
    db.close(false);
  }
};
const expectedShapeV1 = expectedShape(SCHEMA_V1);
const expectedShapeV2 = expectedShape(SCHEMA_V2);

const validateSchemaVersion = (db: Database, path: string, expectedVersion: 1 | 2): void => {
  const actualVersion = decodeVersion(
    db.query("SELECT user_version userVersion FROM pragma_user_version").get(),
  ).userVersion;
  const objects = schemaObjects(db);
  if (
    actualVersion !== expectedVersion ||
    objects.map((row) => row.name).join("|") !== expectedObjects.join("|") ||
    schemaShape(objects) !== (expectedVersion === 1 ? expectedShapeV1 : expectedShapeV2)
  ) {
    throw databaseError("validate schema", path, { actualVersion, objects });
  }
};

const validateSchema = (db: Database, path: string): void => validateSchemaVersion(db, path, 2);

const configure = (db: Database): void => {
  db.exec(
    "PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;",
  );
};

export const initializeSlackIngressDatabase = (
  profilePath: string,
): Effect.Effect<void, SlackIngressDatabaseError> => {
  const path = slackIngressDatabasePath(profilePath);
  return Effect.tryPromise({
    try: () => mkdir(join(profilePath, ".runtime"), { recursive: true }),
    catch: (cause) => databaseError("create runtime directory", path, cause),
  }).pipe(
    Effect.andThen(
      Effect.acquireUseRelease(
        Effect.try({
          try: () => {
            const db = new Database(path, { create: true, readwrite: true, strict: true });
            try {
              configure(db);
              return db;
            } catch (cause) {
              db.close(false);
              throw cause;
            }
          },
          catch: (cause) => databaseError("open", path, cause),
        }),
        (db) =>
          Effect.try({
            try: () => {
              const version = decodeVersion(
                db.query("SELECT user_version userVersion FROM pragma_user_version").get(),
              ).userVersion;
              const objects = schemaObjects(db);
              if (version === 0 && objects.length === 0) {
                db.transaction(() => db.exec(SCHEMA_V2)).immediate();
              } else if (version === 1) {
                validateSchemaVersion(db, path, 1);
                db.transaction(() => db.exec(MIGRATE_V1_TO_V2)).immediate();
                validateSchema(db, path);
              } else {
                validateSchema(db, path);
              }
            },
            catch: (cause) =>
              cause instanceof SlackIngressDatabaseError
                ? cause
                : databaseError("initialize", path, cause),
          }),
        (db) => Effect.sync(() => db.close(false)),
      ),
    ),
  );
};

const withDatabase = <A>(
  profilePath: string,
  operation: string,
  use: (db: Database) => A,
): Effect.Effect<A, SlackIngressDatabaseError> => {
  const path = slackIngressDatabasePath(profilePath);
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const db = new Database(path, { create: false, readwrite: true, strict: true });
        try {
          configure(db);
          validateSchema(db, path);
          return db;
        } catch (cause) {
          db.close(false);
          throw cause;
        }
      },
      catch: (cause) =>
        cause instanceof SlackIngressDatabaseError ? cause : databaseError("open", path, cause),
    }),
    (db) =>
      Effect.try({
        try: () => use(db),
        catch: (cause) =>
          cause instanceof SlackIngressDatabaseError
            ? cause
            : databaseError(operation, path, cause),
      }),
    (db) => Effect.sync(() => db.close(false)),
  );
};

const pruneTerminalRows = (db: Database): void => {
  db.query(
    `DELETE FROM slack_ingress WHERE (channel,source_ts) IN (
      SELECT channel,source_ts FROM slack_ingress WHERE state IN ('completed','failed','cancelled','unknown')
      ORDER BY finished_at_ms DESC,channel DESC,source_ts DESC LIMIT -1 OFFSET ?
    )`,
  ).run(MAX_TERMINAL_ROWS);
};

const storedFilesJson = (payload: SlackIngressPayload): string =>
  JSON.stringify({
    files: payload.files ?? [],
    omittedFileCount: payload.omittedFileCount ?? 0,
  });

export type SlackIngressAdmission = "accepted" | "duplicate";

export const admitSlackIngress = (
  profilePath: string,
  record: SlackIngressRecord,
  atMs: number,
): Effect.Effect<SlackIngressAdmission, SlackIngressDatabaseError> =>
  withDatabase(profilePath, "admit", (db) =>
    db
      .transaction(() => {
        const { payload } = record;
        const contextId =
          payload.context.kind === "user" ? payload.context.userId : payload.context.groupId;
        const duplicate =
          db
            .query(
              `SELECT 1 FROM slack_ingress
               WHERE (channel=? AND source_ts=?) OR (? IS NOT NULL AND event_id=?) LIMIT 1`,
            )
            .get(
              payload.channel,
              payload.sourceTs,
              record.eventId ?? null,
              record.eventId ?? null,
            ) !== null;
        if (duplicate) return "duplicate";
        db.query(
          `INSERT INTO slack_ingress
              (channel,source_ts,event_id,state,owner_id,chat_key,context_kind,context_id,status_thread_ts,text,files_json,thread_ts,received_at_ms,started_at_ms,finished_at_ms)
              VALUES (?,?,?,'received',NULL,?,?,?,?,?,?,?,?,NULL,NULL)`,
        ).run(
          payload.channel,
          payload.sourceTs,
          record.eventId ?? null,
          payload.chatKey,
          payload.context.kind,
          contextId,
          payload.statusThreadTs,
          payload.text,
          storedFilesJson(payload),
          payload.threadTs ?? null,
          atMs,
        );
        pruneTerminalRows(db);
        return "accepted";
      })
      .immediate(),
  );

export const recoverSlackIngress = (
  profilePath: string,
  ownerId: string,
): Effect.Effect<void, SlackIngressDatabaseError> =>
  withDatabase(profilePath, "recover", (db) =>
    db
      .transaction(() => {
        db.query(
          `UPDATE slack_ingress SET state='received',owner_id=NULL,started_at_ms=NULL
           WHERE state='running' AND owner_id<>?`,
        ).run(ownerId);
      })
      .immediate(),
  );

export const readReplayableSlackIngress = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<SlackIngressRecord>, SlackIngressDatabaseError> =>
  withDatabase(profilePath, "read replayable", (db) =>
    decodeReplayRows(
      db
        .query(
          `SELECT channel,source_ts sourceTs,event_id eventId,chat_key chatKey,context_kind contextKind,
            context_id contextId,status_thread_ts statusThreadTs,text,files_json filesJson,thread_ts threadTs
           FROM slack_ingress WHERE state='received' ORDER BY received_at_ms,channel,source_ts`,
        )
        .all(),
    ).map((row): SlackIngressRecord => {
      const storedFiles = decodeStoredFilesJson(row.filesJson);
      return {
        ...(row.eventId === null ? {} : { eventId: row.eventId }),
        payload: {
          chatKey: row.chatKey,
          channel: row.channel,
          context:
            row.contextKind === "user"
              ? { kind: "user", userId: row.contextId }
              : { kind: "group", groupId: row.contextId },
          ...(storedFiles.files.length === 0 ? {} : { files: storedFiles.files }),
          ...(storedFiles.omittedFileCount === 0
            ? {}
            : { omittedFileCount: storedFiles.omittedFileCount }),
          statusThreadTs: row.statusThreadTs,
          sourceTs: row.sourceTs,
          text: row.text,
          ...(row.threadTs === null ? {} : { threadTs: row.threadTs }),
        },
      };
    }),
  );

export const startSlackIngress = (
  profilePath: string,
  payload: SlackIngressPayload,
  ownerId: string,
  atMs: number,
): Effect.Effect<boolean, SlackIngressDatabaseError> =>
  withDatabase(profilePath, "start", (db) =>
    db
      .transaction(
        () =>
          db
            .query(
              `UPDATE slack_ingress SET state='running',owner_id=?,started_at_ms=?
             WHERE channel=? AND source_ts=? AND state='received'`,
            )
            .run(ownerId, atMs, payload.channel, payload.sourceTs).changes === 1,
      )
      .immediate(),
  );

export const finishSlackIngress = (
  profilePath: string,
  payload: SlackIngressPayload,
  ownerId: string,
  state: SlackIngressTerminalState,
  atMs: number,
): Effect.Effect<void, SlackIngressDatabaseError> =>
  withDatabase(profilePath, "finish", (db) =>
    db
      .transaction(() => {
        const changed = db
          .query(
            `UPDATE slack_ingress SET state=?,owner_id=NULL,text='',files_json=?,finished_at_ms=?
             WHERE channel=? AND source_ts=? AND state='running' AND owner_id=?`,
          )
          .run(state, EMPTY_FILES_JSON, atMs, payload.channel, payload.sourceTs, ownerId).changes;
        if (changed !== 1) {
          throw databaseError("finish owned row", slackIngressDatabasePath(profilePath), {
            channel: payload.channel,
            sourceTs: payload.sourceTs,
          });
        }
        pruneTerminalRows(db);
      })
      .immediate(),
  );
