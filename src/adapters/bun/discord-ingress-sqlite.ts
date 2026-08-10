import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import {
  DiscordIngressAttachmentReference,
  DiscordIngressDatabaseError,
  type DiscordIngressPayload,
  type DiscordIngressTerminalState,
} from "../../domain/discord-ingress";

const DATABASE_NAME = "discord-ingress.sqlite";
const MAX_TERMINAL_ROWS = 1_000;
const EMPTY_ATTACHMENTS_JSON = '{"attachments":[],"omittedAttachmentCount":0}';
const SCHEMA_V1 = `
CREATE TABLE discord_ingress (
  message_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('received', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
  owner_id TEXT,
  source_channel_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  author_id TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('user', 'group')),
  context_id TEXT NOT NULL,
  text TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  started_at_ms INTEGER CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms >= 0),
  CHECK (length(message_id) > 0 AND length(source_channel_id) > 0 AND length(channel_id) > 0
    AND length(author_id) > 0 AND length(chat_key) > 0 AND length(context_id) > 0),
  CHECK (guild_id IS NULL OR length(guild_id) > 0),
  CHECK ((state IN ('received', 'running') AND length(trim(text)) > 0)
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown') AND length(text) = 0)),
  CHECK (owner_id IS NULL OR length(owner_id) > 0),
  CHECK ((state = 'received' AND owner_id IS NULL AND started_at_ms IS NULL AND finished_at_ms IS NULL)
    OR (state = 'running' AND owner_id IS NOT NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NULL)
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown') AND owner_id IS NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NOT NULL))
) STRICT;
CREATE INDEX discord_ingress_replay ON discord_ingress(received_at_ms, message_id)
  WHERE state = 'received';
CREATE INDEX discord_ingress_terminal ON discord_ingress(finished_at_ms DESC, message_id)
  WHERE state IN ('completed', 'failed', 'cancelled', 'unknown');
PRAGMA user_version = 1;`;
const SCHEMA_V2 = `
CREATE TABLE "discord_ingress" (
  message_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('received', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
  owner_id TEXT,
  source_channel_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  author_id TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('user', 'group')),
  context_id TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  started_at_ms INTEGER CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms >= 0),
  CHECK (length(message_id) > 0 AND length(source_channel_id) > 0 AND length(channel_id) > 0
    AND length(author_id) > 0 AND length(chat_key) > 0 AND length(context_id) > 0),
  CHECK (guild_id IS NULL OR length(guild_id) > 0),
  CHECK (json_valid(attachments_json) AND json_type(attachments_json) = 'object'
    AND json_type(attachments_json, '$.attachments') = 'array'
    AND json_array_length(attachments_json, '$.attachments') <= 4
    AND json_type(attachments_json, '$.omittedAttachmentCount') = 'integer'
    AND json_extract(attachments_json, '$.omittedAttachmentCount') >= 0),
  CHECK ((state IN ('received', 'running') AND (length(trim(text)) > 0
      OR json_array_length(attachments_json, '$.attachments') > 0
      OR json_extract(attachments_json, '$.omittedAttachmentCount') > 0))
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown')
      AND length(text) = 0 AND attachments_json = '{"attachments":[],"omittedAttachmentCount":0}')),
  CHECK (owner_id IS NULL OR length(owner_id) > 0),
  CHECK ((state = 'received' AND owner_id IS NULL AND started_at_ms IS NULL AND finished_at_ms IS NULL)
    OR (state = 'running' AND owner_id IS NOT NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NULL)
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown') AND owner_id IS NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NOT NULL))
) STRICT;
CREATE INDEX discord_ingress_replay ON discord_ingress(received_at_ms, message_id)
  WHERE state = 'received';
CREATE INDEX discord_ingress_terminal ON discord_ingress(finished_at_ms DESC, message_id)
  WHERE state IN ('completed', 'failed', 'cancelled', 'unknown');
PRAGMA user_version = 2;`;
const MIGRATE_V1_TO_V2 = `
CREATE TABLE discord_ingress_v2 (
  message_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('received', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
  owner_id TEXT,
  source_channel_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  author_id TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('user', 'group')),
  context_id TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  started_at_ms INTEGER CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms >= 0),
  CHECK (length(message_id) > 0 AND length(source_channel_id) > 0 AND length(channel_id) > 0
    AND length(author_id) > 0 AND length(chat_key) > 0 AND length(context_id) > 0),
  CHECK (guild_id IS NULL OR length(guild_id) > 0),
  CHECK (json_valid(attachments_json) AND json_type(attachments_json) = 'object'
    AND json_type(attachments_json, '$.attachments') = 'array'
    AND json_array_length(attachments_json, '$.attachments') <= 4
    AND json_type(attachments_json, '$.omittedAttachmentCount') = 'integer'
    AND json_extract(attachments_json, '$.omittedAttachmentCount') >= 0),
  CHECK ((state IN ('received', 'running') AND (length(trim(text)) > 0
      OR json_array_length(attachments_json, '$.attachments') > 0
      OR json_extract(attachments_json, '$.omittedAttachmentCount') > 0))
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown')
      AND length(text) = 0 AND attachments_json = '{"attachments":[],"omittedAttachmentCount":0}')),
  CHECK (owner_id IS NULL OR length(owner_id) > 0),
  CHECK ((state = 'received' AND owner_id IS NULL AND started_at_ms IS NULL AND finished_at_ms IS NULL)
    OR (state = 'running' AND owner_id IS NOT NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NULL)
    OR (state IN ('completed', 'failed', 'cancelled', 'unknown') AND owner_id IS NULL AND started_at_ms IS NOT NULL AND finished_at_ms IS NOT NULL))
) STRICT;
INSERT INTO discord_ingress_v2
  (message_id,state,owner_id,source_channel_id,channel_id,guild_id,author_id,chat_key,context_kind,context_id,text,attachments_json,received_at_ms,started_at_ms,finished_at_ms)
  SELECT message_id,state,owner_id,source_channel_id,channel_id,guild_id,author_id,chat_key,context_kind,context_id,text,
    '${EMPTY_ATTACHMENTS_JSON}',received_at_ms,started_at_ms,finished_at_ms FROM discord_ingress;
DROP TABLE discord_ingress;
ALTER TABLE discord_ingress_v2 RENAME TO discord_ingress;
CREATE INDEX discord_ingress_replay ON discord_ingress(received_at_ms, message_id)
  WHERE state = 'received';
CREATE INDEX discord_ingress_terminal ON discord_ingress(finished_at_ms DESC, message_id)
  WHERE state IN ('completed', 'failed', 'cancelled', 'unknown');
PRAGMA user_version = 2;`;

const VersionRow = Schema.Struct({ userVersion: Schema.Int });
const MasterRow = Schema.Struct({ name: Schema.String, type: Schema.String, sql: Schema.String });
const ReplayRow = Schema.Struct({
  messageId: Schema.String,
  sourceChannelId: Schema.String,
  channelId: Schema.String,
  guildId: Schema.NullOr(Schema.String),
  authorId: Schema.String,
  chatKey: Schema.String,
  contextKind: Schema.Literals(["user", "group"]),
  contextId: Schema.String,
  text: Schema.String,
  attachmentsJson: Schema.String,
});
const StoredAttachments = Schema.Struct({
  attachments: Schema.Array(DiscordIngressAttachmentReference).check(
    Schema.makeFilter((attachments) => attachments.length <= 4, {
      expected: "at most four Discord attachments",
    }),
  ),
  omittedAttachmentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const decodeVersion = Schema.decodeUnknownSync(VersionRow, { onExcessProperty: "error" });
const decodeMaster = Schema.decodeUnknownSync(Schema.Array(MasterRow), {
  onExcessProperty: "error",
});
const decodeReplayRows = Schema.decodeUnknownSync(Schema.Array(ReplayRow), {
  onExcessProperty: "error",
});
const decodeStoredAttachmentsJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(StoredAttachments),
);

export type DiscordIngressAdmission = "accepted" | "duplicate";

export const discordIngressDatabasePath = (profilePath: string): string =>
  join(profilePath, ".runtime", DATABASE_NAME);

const databaseError = (operation: string, path: string, cause: unknown) =>
  new DiscordIngressDatabaseError({
    operation,
    path,
    message: `Discord ingress database ${operation} failed at ${path}`,
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
const expectedObjects = ["discord_ingress", "discord_ingress_replay", "discord_ingress_terminal"];
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

export const initializeDiscordIngressDatabase = (
  profilePath: string,
): Effect.Effect<void, DiscordIngressDatabaseError> => {
  const path = discordIngressDatabasePath(profilePath);
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
              }
              validateSchema(db, path);
            },
            catch: (cause) =>
              cause instanceof DiscordIngressDatabaseError
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
): Effect.Effect<A, DiscordIngressDatabaseError> => {
  const path = discordIngressDatabasePath(profilePath);
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
        cause instanceof DiscordIngressDatabaseError ? cause : databaseError("open", path, cause),
    }),
    (db) =>
      Effect.try({
        try: () => use(db),
        catch: (cause) =>
          cause instanceof DiscordIngressDatabaseError
            ? cause
            : databaseError(operation, path, cause),
      }),
    (db) => Effect.sync(() => db.close(false)),
  );
};

const pruneTerminalRows = (db: Database): void => {
  db.query(
    `DELETE FROM discord_ingress WHERE message_id IN (
      SELECT message_id FROM discord_ingress WHERE state IN ('completed','failed','cancelled','unknown')
      ORDER BY finished_at_ms DESC,message_id DESC LIMIT -1 OFFSET ?
    )`,
  ).run(MAX_TERMINAL_ROWS);
};

const storedAttachmentsJson = (payload: DiscordIngressPayload): string =>
  JSON.stringify({
    attachments: payload.attachments ?? [],
    omittedAttachmentCount: payload.omittedAttachmentCount ?? 0,
  });

export const admitDiscordIngress = (
  profilePath: string,
  payload: DiscordIngressPayload,
  atMs: number,
): Effect.Effect<DiscordIngressAdmission, DiscordIngressDatabaseError> =>
  withDatabase(profilePath, "admit", (db) =>
    db
      .transaction(() => {
        const duplicate =
          db
            .query("SELECT 1 FROM discord_ingress WHERE message_id=? LIMIT 1")
            .get(payload.messageId) !== null;
        if (duplicate) return "duplicate";
        const contextId =
          payload.context.kind === "user" ? payload.context.userId : payload.context.groupId;
        db.query(
          `INSERT INTO discord_ingress
            (message_id,state,owner_id,source_channel_id,channel_id,guild_id,author_id,chat_key,context_kind,context_id,text,attachments_json,received_at_ms,started_at_ms,finished_at_ms)
           VALUES (?,'received',NULL,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
        ).run(
          payload.messageId,
          payload.sourceChannelId,
          payload.channelId,
          payload.guildId ?? null,
          payload.authorId,
          payload.chatKey,
          payload.context.kind,
          contextId,
          payload.text,
          storedAttachmentsJson(payload),
          atMs,
        );
        pruneTerminalRows(db);
        return "accepted";
      })
      .immediate(),
  );

export const recoverDiscordIngress = (
  profilePath: string,
  ownerId: string,
): Effect.Effect<void, DiscordIngressDatabaseError> =>
  withDatabase(profilePath, "recover", (db) =>
    db
      .transaction(() => {
        db.query(
          `UPDATE discord_ingress SET state='received',owner_id=NULL,started_at_ms=NULL
           WHERE state='running' AND owner_id<>?`,
        ).run(ownerId);
      })
      .immediate(),
  );

export const readReplayableDiscordIngress = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<DiscordIngressPayload>, DiscordIngressDatabaseError> =>
  withDatabase(profilePath, "read replayable", (db) =>
    decodeReplayRows(
      db
        .query(
          `SELECT message_id messageId,source_channel_id sourceChannelId,channel_id channelId,
            guild_id guildId,author_id authorId,chat_key chatKey,context_kind contextKind,
            context_id contextId,text,attachments_json attachmentsJson
           FROM discord_ingress WHERE state='received' ORDER BY received_at_ms,message_id`,
        )
        .all(),
    ).map((row): DiscordIngressPayload => {
      const storedAttachments = decodeStoredAttachmentsJson(row.attachmentsJson);
      return {
        messageId: row.messageId,
        sourceChannelId: row.sourceChannelId,
        channelId: row.channelId,
        ...(row.guildId === null ? {} : { guildId: row.guildId }),
        authorId: row.authorId,
        text: row.text,
        ...(storedAttachments.attachments.length === 0
          ? {}
          : { attachments: storedAttachments.attachments }),
        ...(storedAttachments.omittedAttachmentCount === 0
          ? {}
          : { omittedAttachmentCount: storedAttachments.omittedAttachmentCount }),
        chatKey: row.chatKey,
        context:
          row.contextKind === "user"
            ? { kind: "user", userId: row.contextId }
            : { kind: "group", groupId: row.contextId },
      };
    }),
  );

export const startDiscordIngress = (
  profilePath: string,
  payload: DiscordIngressPayload,
  ownerId: string,
  atMs: number,
): Effect.Effect<boolean, DiscordIngressDatabaseError> =>
  withDatabase(profilePath, "start", (db) =>
    db
      .transaction(
        () =>
          db
            .query(
              `UPDATE discord_ingress SET state='running',owner_id=?,started_at_ms=?
               WHERE message_id=? AND state='received'`,
            )
            .run(ownerId, atMs, payload.messageId).changes === 1,
      )
      .immediate(),
  );

export const requeueDiscordIngress = (
  profilePath: string,
  payload: DiscordIngressPayload,
  ownerId: string,
): Effect.Effect<void, DiscordIngressDatabaseError> =>
  withDatabase(profilePath, "requeue", (db) => {
    const changed = db
      .query(
        `UPDATE discord_ingress SET state='received',owner_id=NULL,started_at_ms=NULL
         WHERE message_id=? AND state='running' AND owner_id=?`,
      )
      .run(payload.messageId, ownerId).changes;
    if (changed !== 1) {
      throw databaseError("requeue owned row", discordIngressDatabasePath(profilePath), {
        messageId: payload.messageId,
      });
    }
  });

export const finishDiscordIngress = (
  profilePath: string,
  payload: DiscordIngressPayload,
  ownerId: string,
  state: DiscordIngressTerminalState,
  atMs: number,
): Effect.Effect<void, DiscordIngressDatabaseError> =>
  withDatabase(profilePath, "finish", (db) =>
    db
      .transaction(() => {
        const changed = db
          .query(
            `UPDATE discord_ingress SET state=?,owner_id=NULL,text='',attachments_json=?,finished_at_ms=?
             WHERE message_id=? AND state='running' AND owner_id=?`,
          )
          .run(state, EMPTY_ATTACHMENTS_JSON, atMs, payload.messageId, ownerId).changes;
        if (changed !== 1) {
          throw databaseError("finish owned row", discordIngressDatabasePath(profilePath), {
            messageId: payload.messageId,
          });
        }
        pruneTerminalRows(db);
      })
      .immediate(),
  );
