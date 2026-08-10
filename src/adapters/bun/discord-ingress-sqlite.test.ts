/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Result } from "effect";
import type { DiscordIngressPayload } from "../../domain/discord-ingress";
import {
  admitDiscordIngress,
  discordIngressDatabasePath,
  finishDiscordIngress,
  initializeDiscordIngressDatabase,
  readReplayableDiscordIngress,
  requeueDiscordIngress,
  recoverDiscordIngress,
  startDiscordIngress,
} from "./discord-ingress-sqlite";

const profile = () => mkdtemp(join(tmpdir(), "ziggy-discord-ingress-"));
const payload = (messageId: string): DiscordIngressPayload => ({
  messageId,
  sourceChannelId: "source-1",
  channelId: "thread-1",
  guildId: "guild-1",
  authorId: "owner-1",
  text: `prompt ${messageId}`,
  chatKey: "group-dcsource-1-thread-thread-1",
  context: { kind: "group", groupId: "dcsource-1" },
});
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const SCHEMA_V1_FIXTURE = `
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

describe("Discord durable ingress SQLite boundary", () => {
  test("commits one replayable row per Discord source message ID", async () => {
    const path = await profile();
    const item = payload("message-1");
    await run(initializeDiscordIngressDatabase(path));

    expect(await run(admitDiscordIngress(path, item, 10))).toBe("accepted");
    expect(await run(admitDiscordIngress(path, item, 11))).toBe("duplicate");
    expect(await run(readReplayableDiscordIngress(path))).toEqual([item]);
  });

  test("fences running and terminal transitions to the claiming resident owner", async () => {
    const path = await profile();
    const item: DiscordIngressPayload = {
      ...payload("message-1"),
      text: "",
      attachments: [
        {
          id: "attachment-1",
          filename: "image.png",
          mimeType: "image/png",
          size: 3,
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
        },
      ],
    };
    await run(initializeDiscordIngressDatabase(path));
    await run(admitDiscordIngress(path, item, 10));

    expect(await run(startDiscordIngress(path, item, "owner-a", 20))).toBe(true);
    expect(await run(startDiscordIngress(path, item, "owner-b", 21))).toBe(false);
    const stale = await run(
      finishDiscordIngress(path, item, "owner-b", "completed", 30).pipe(Effect.result),
    );
    expect(Result.isFailure(stale) && stale.failure.operation).toBe("finish owned row");
    await run(finishDiscordIngress(path, item, "owner-a", "completed", 31));

    expect(await run(readReplayableDiscordIngress(path))).toEqual([]);
    const inspected = new Database(discordIngressDatabasePath(path), { readonly: true });
    expect(
      inspected
        .query(
          "SELECT state,text,attachments_json attachmentsJson,owner_id ownerId FROM discord_ingress WHERE message_id=?",
        )
        .get(item.messageId),
    ).toEqual({
      state: "completed",
      text: "",
      attachmentsJson: '{"attachments":[],"omittedAttachmentCount":0}',
      ownerId: null,
    });
    inspected.close(false);
  });

  test("recovers only foreign running rows and never replays terminal rows", async () => {
    const path = await profile();
    const foreign = payload("message-1");
    const current = payload("message-2");
    const terminal = payload("message-3");
    await run(initializeDiscordIngressDatabase(path));
    for (const [index, item] of [foreign, current, terminal].entries()) {
      await run(admitDiscordIngress(path, item, index));
    }
    await run(startDiscordIngress(path, foreign, "old-owner", 10));
    await run(startDiscordIngress(path, current, "new-owner", 11));
    await run(startDiscordIngress(path, terminal, "old-owner", 12));
    await run(finishDiscordIngress(path, terminal, "old-owner", "failed", 13));

    await run(recoverDiscordIngress(path, "new-owner"));
    expect(await run(readReplayableDiscordIngress(path))).toEqual([foreign]);
  });

  test("requeues an interrupted owned row without erasing its replay payload", async () => {
    const path = await profile();
    const item = payload("message-1");
    await run(initializeDiscordIngressDatabase(path));
    await run(admitDiscordIngress(path, item, 10));
    await run(startDiscordIngress(path, item, "owner-a", 20));

    await run(requeueDiscordIngress(path, item, "owner-a"));

    expect(await run(readReplayableDiscordIngress(path))).toEqual([item]);
    const inspected = new Database(discordIngressDatabasePath(path), { readonly: true });
    expect(
      inspected
        .query(
          "SELECT state,text,owner_id ownerId,started_at_ms startedAtMs,finished_at_ms finishedAtMs FROM discord_ingress WHERE message_id=?",
        )
        .get(item.messageId),
    ).toEqual({
      state: "received",
      text: item.text,
      ownerId: null,
      startedAtMs: null,
      finishedAtMs: null,
    });
    inspected.close(false);
  });

  test("fails closed for an unknown schema version", async () => {
    const path = await profile();
    await run(initializeDiscordIngressDatabase(path));
    const databasePath = discordIngressDatabasePath(path);
    const db = new Database(databasePath);
    db.exec("PRAGMA user_version = 99");
    db.close(false);

    const result = await run(initializeDiscordIngressDatabase(path).pipe(Effect.result));
    expect(Result.isFailure(result) && result.failure.operation).toBe("validate schema");
    const unchanged = new Database(databasePath, { readonly: true });
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    unchanged.close(false);
  });

  test("migrates the exact v1 schema and preserves replayable text", async () => {
    const path = await profile();
    const databasePath = discordIngressDatabasePath(path);
    await mkdir(join(path, ".runtime"));
    const db = new Database(databasePath, { create: true });
    db.exec(SCHEMA_V1_FIXTURE);
    db.query(
      `INSERT INTO discord_ingress
       (message_id,state,owner_id,source_channel_id,channel_id,guild_id,author_id,chat_key,context_kind,context_id,text,received_at_ms,started_at_ms,finished_at_ms)
       VALUES ('message-1','received',NULL,'source-1','thread-1','guild-1','owner-1','group-dcsource-1-thread-thread-1','group','dcsource-1','prompt message-1',10,NULL,NULL)`,
    ).run();
    db.close(false);

    await run(initializeDiscordIngressDatabase(path));

    expect(await run(readReplayableDiscordIngress(path))).toEqual([payload("message-1")]);
    const migrated = new Database(databasePath, { readonly: true });
    expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    migrated.close(false);
  });

  test("bounds terminal retention without pruning replayable work", async () => {
    const path = await profile();
    await run(initializeDiscordIngressDatabase(path));
    const databasePath = discordIngressDatabasePath(path);
    const db = new Database(databasePath);
    const insert = db.query(
      `INSERT INTO discord_ingress
       (message_id,state,owner_id,source_channel_id,channel_id,guild_id,author_id,chat_key,context_kind,context_id,text,attachments_json,received_at_ms,started_at_ms,finished_at_ms)
       VALUES (?,'completed',NULL,'source-1','thread-1','guild-1','owner-1','chat-1','group','group-1','','{"attachments":[],"omittedAttachmentCount":0}',?,?,?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) {
        insert.run(`terminal-${index}`, index, index, index);
      }
    }).immediate();
    db.close(false);

    const pending = payload("pending");
    expect(await run(admitDiscordIngress(path, pending, 2_000))).toBe("accepted");
    const inspected = new Database(databasePath, { readonly: true });
    expect(
      inspected
        .query(
          "SELECT count(*) count FROM discord_ingress WHERE state IN ('completed','failed','cancelled','unknown')",
        )
        .get(),
    ).toEqual({ count: 1_000 });
    inspected.close(false);
    expect(await run(readReplayableDiscordIngress(path))).toEqual([pending]);
  });
});
