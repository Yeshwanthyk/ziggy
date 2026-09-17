import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Option, Schema } from "effect";
import { WebAccessError } from "../../domain/web-access";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairing (
  token_hash TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS browser_session (
  token_hash TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms), revoked_at_ms INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS browser_session_expiry ON browser_session(expires_at_ms);`;

const PAIRING_TTL_MS = 10 * 60 * 1_000;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export const webAccessDatabasePath = (profilePath: string): string =>
  join(profilePath, ".gateway", "web-access.sqlite");

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

const token = (): string => randomBytes(32).toString("hex");

const NonNegativeInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

const PairingRow = Schema.Struct({ expiresAtMs: NonNegativeInteger });

const SessionRow = Schema.Struct({ ok: Schema.Literal(1) });

const VersionRow = Schema.Struct({ userVersion: NonNegativeInteger });

const MasterRow = Schema.Struct({ name: Schema.String });

const decodePairing = Schema.decodeUnknownOption(Schema.NullOr(PairingRow), {
  onExcessProperty: "error",
});

const decodeSession = Schema.decodeUnknownOption(Schema.NullOr(SessionRow), {
  onExcessProperty: "error",
});

const decodeVersion = Schema.decodeUnknownSync(VersionRow, { onExcessProperty: "error" });

const decodeMaster = Schema.decodeUnknownSync(Schema.Array(MasterRow), {
  onExcessProperty: "error",
});

export interface WebAccessStore {
  readonly issuePairing: (now?: number) => { readonly token: string; readonly expiresAtMs: number };
  readonly redeemPairing: (
    pairingToken: string,
    now?: number,
  ) => { readonly token: string; readonly expiresAtMs: number } | undefined;
  readonly sessionValid: (sessionToken: string, now?: number) => boolean;
  readonly revokeAll: (now?: number) => number;
  readonly close: () => void;
}

export const openWebAccessStore = (profilePath: string): WebAccessStore => {
  const path = webAccessDatabasePath(profilePath);

  try {
    const directory = join(profilePath, ".gateway");

    if (!existsSync(directory)) mkdirSync(directory, { recursive: false, mode: 0o700 });
    const directoryStatus = lstatSync(directory);

    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink())
      throw new Error("web access directory must be a physical directory");

    if (existsSync(path)) {
      const databaseStatus = lstatSync(path);

      if (!databaseStatus.isFile() || databaseStatus.isSymbolicLink())
        throw new Error("web access database must be a physical file");
    }

    const db = new Database(path, { create: true, readwrite: true, strict: true });
    chmodSync(path, 0o600);

    const version = decodeVersion(
      db.query("SELECT user_version userVersion FROM pragma_user_version").get(),
    ).userVersion;

    const objects = decodeMaster(
      db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    ).map((row) => row.name);

    if (version === 0 && objects.length === 0) {
      db.exec(SCHEMA);
      db.exec("PRAGMA user_version = 1");
    } else if (
      version !== 1 ||
      objects.join("|") !== "browser_session|browser_session_expiry|pairing"
    ) {
      db.close(false);
      throw new Error("unsupported or malformed web access database schema");
    }

    const issue = db.query("INSERT INTO pairing (token_hash, expires_at_ms) VALUES (?, ?)");

    const selectPairing = db.query(
      "SELECT expires_at_ms expiresAtMs FROM pairing WHERE token_hash = ?",
    );

    const consumePairing = db.query("DELETE FROM pairing WHERE token_hash = ?");

    const insertSession = db.query(
      "INSERT INTO browser_session (token_hash, created_at_ms, expires_at_ms, revoked_at_ms) VALUES (?, ?, ?, NULL)",
    );

    const selectSession = db.query(
      "SELECT 1 ok FROM browser_session WHERE token_hash = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?",
    );

    const revoke = db.query(
      "UPDATE browser_session SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL AND expires_at_ms > ?",
    );

    const redeem = db.transaction((pairingToken: string, now: number) => {
      const pairingHash = hash(pairingToken);
      const decoded = decodePairing(selectPairing.get(pairingHash));

      if (Option.isNone(decoded) || decoded.value === null || decoded.value.expiresAtMs <= now)
        return undefined;
      consumePairing.run(pairingHash);
      const sessionToken = token();
      const expiresAtMs = now + SESSION_TTL_MS;
      insertSession.run(hash(sessionToken), now, expiresAtMs);

      return { token: sessionToken, expiresAtMs };
    });

    return {
      issuePairing: (now = Date.now()) => {
        const pairingToken = token();
        const expiresAtMs = now + PAIRING_TTL_MS;
        issue.run(hash(pairingToken), expiresAtMs);

        return { token: pairingToken, expiresAtMs };
      },
      redeemPairing: (pairingToken, now = Date.now()) => redeem(pairingToken, now),
      sessionValid: (sessionToken, now = Date.now()) =>
        /^[0-9a-f]{64}$/u.test(sessionToken) &&
        Option.match(decodeSession(selectSession.get(hash(sessionToken), now)), {
          onNone: () => false,
          onSome: (row) => row !== null,
        }),
      revokeAll: (now = Date.now()) => Number(revoke.run(now, now).changes),
      close: () => db.close(false),
    };
  } catch (cause) {
    throw new WebAccessError({
      operation: "open database",
      path,
      message: "could not open web access database",
      cause,
    });
  }
};
