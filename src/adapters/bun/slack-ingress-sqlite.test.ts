/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Result } from "effect";
import type { SlackIngressRecord } from "../../domain/slack-ingress";
import {
  admitSlackIngress,
  finishSlackIngress,
  initializeSlackIngressDatabase,
  readReplayableSlackIngress,
  recoverSlackIngress,
  slackIngressDatabasePath,
  startSlackIngress,
} from "./slack-ingress-sqlite";

const profile = () => mkdtemp(join(tmpdir(), "ziggy-slack-ingress-"));
const record = (sourceTs: string, eventId = `event-${sourceTs}`): SlackIngressRecord => ({
  eventId,
  payload: {
    chatKey: "user-U1",
    channel: "D1",
    context: { kind: "user", userId: "owner" },
    statusThreadTs: sourceTs,
    sourceTs,
    text: `prompt ${sourceTs}`,
  },
});
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("Slack durable ingress SQLite boundary", () => {
  test("commits one row per logical source or Slack event ID", async () => {
    const path = await profile();
    await run(initializeSlackIngressDatabase(path));
    const first = record("1.0");

    expect(await run(admitSlackIngress(path, first, 10))).toBe("accepted");
    expect(await run(admitSlackIngress(path, first, 11))).toBe("duplicate");
    expect(
      await run(admitSlackIngress(path, { ...record("2.0"), eventId: first.eventId }, 12)),
    ).toBe("duplicate");
    expect(await run(readReplayableSlackIngress(path))).toEqual([first]);
  });

  test("fences running and terminal transitions to the claiming resident owner", async () => {
    const path = await profile();
    const item = record("1.0");
    await run(initializeSlackIngressDatabase(path));
    await run(admitSlackIngress(path, item, 10));

    expect(await run(startSlackIngress(path, item.payload, "owner-a", 20))).toBe(true);
    expect(await run(startSlackIngress(path, item.payload, "owner-b", 21))).toBe(false);
    const stale = await run(
      finishSlackIngress(path, item.payload, "owner-b", "completed", 30).pipe(Effect.result),
    );
    expect(Result.isFailure(stale) && stale.failure.operation).toBe("finish owned row");
    await run(finishSlackIngress(path, item.payload, "owner-a", "completed", 31));
    expect(await run(readReplayableSlackIngress(path))).toEqual([]);
    const inspected = new Database(slackIngressDatabasePath(path), { readonly: true });
    expect(
      inspected
        .query("SELECT state,text FROM slack_ingress WHERE channel='D1' AND source_ts='1.0'")
        .get(),
    ).toEqual({ state: "completed", text: "" });
    inspected.close(false);
  });

  test("recovers only foreign running rows and never replays terminal rows", async () => {
    const path = await profile();
    const foreign = record("1.0");
    const current = record("2.0");
    const terminal = record("3.0");
    await run(initializeSlackIngressDatabase(path));
    for (const [index, item] of [foreign, current, terminal].entries()) {
      await run(admitSlackIngress(path, item, index));
    }
    await run(startSlackIngress(path, foreign.payload, "old-owner", 10));
    await run(startSlackIngress(path, current.payload, "new-owner", 11));
    await run(startSlackIngress(path, terminal.payload, "old-owner", 12));
    await run(finishSlackIngress(path, terminal.payload, "old-owner", "failed", 13));

    await run(recoverSlackIngress(path, "new-owner"));
    expect(await run(readReplayableSlackIngress(path))).toEqual([foreign]);
  });

  test("fails closed for an unknown schema version", async () => {
    const path = await profile();
    await run(initializeSlackIngressDatabase(path));
    const dbPath = slackIngressDatabasePath(path);
    const db = new Database(dbPath);
    db.exec("PRAGMA user_version = 99");
    db.close(false);

    const result = await run(initializeSlackIngressDatabase(path).pipe(Effect.result));
    expect(Result.isFailure(result) && result.failure.operation).toBe("validate schema");
    const unchanged = new Database(dbPath, { readonly: true });
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    unchanged.close(false);
  });

  test("bounds terminal retention without pruning replayable work", async () => {
    const path = await profile();
    await run(initializeSlackIngressDatabase(path));
    const dbPath = slackIngressDatabasePath(path);
    const db = new Database(dbPath);
    const insert = db.query(
      `INSERT INTO slack_ingress
       (channel,source_ts,event_id,state,owner_id,chat_key,context_kind,context_id,status_thread_ts,text,thread_ts,received_at_ms,started_at_ms,finished_at_ms)
       VALUES ('D1',?,NULL,'completed',NULL,'user-U1','user','owner',?,'',NULL,?,?,?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) {
        const ts = String(index);
        insert.run(ts, ts, index, index, index);
      }
    }).immediate();
    db.close(false);

    const pending = record("pending");
    expect(await run(admitSlackIngress(path, pending, 2_000))).toBe("accepted");
    const inspected = new Database(dbPath, { readonly: true });
    expect(
      inspected
        .query(
          "SELECT count(*) count FROM slack_ingress WHERE state IN ('completed','failed','cancelled','unknown')",
        )
        .get(),
    ).toEqual({ count: 1_000 });
    inspected.close(false);
    expect(await run(readReplayableSlackIngress(path))).toEqual([pending]);
  });
});
