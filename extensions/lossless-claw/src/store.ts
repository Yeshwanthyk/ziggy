import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { Option, Predicate, Schema } from "effect";

const INDEX_RELATIVE_PATH = join(".runtime", "lossless-claw", "index.sqlite");
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_SNIPPET_CHARS = 600;

const ContentItemSchema = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Unknown),
});

const MessageSchema = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(ContentItemSchema)]),
  toolName: Schema.optional(Schema.String),
});

const JsonLineSchema = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  message: Schema.optional(MessageSchema),
  summary: Schema.optional(Schema.String),
});

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(JsonLineSchema));

interface DiscoveredFile {
  readonly absolutePath: string;
  readonly sourcePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface ProjectedEntry {
  readonly ordinal: number;
  readonly entryId: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly kind: "message" | "compaction" | "branch_summary";
  readonly role: string;
  readonly text: string;
  readonly active: boolean;
}

interface FileProjection {
  readonly file: DiscoveredFile;
  readonly sessionId: string;
  readonly headerTimestamp: string;
  readonly headerCwd: string;
  readonly latestTimestamp: string;
  readonly leafId: string | null;
  readonly entries: ReadonlyArray<ProjectedEntry>;
}

interface FileStateRow {
  readonly source_path: string;
  readonly size: number;
  readonly mtime_ms: number;
}

interface SearchDatabaseRow {
  readonly row_id: number;
  readonly session_id: string;
  readonly source_path: string;
  readonly entry_id: string;
  readonly parent_id: string | null;
  readonly timestamp: string;
  readonly kind: string;
  readonly role: string;
  readonly active: number;
  readonly snippet: string;
  readonly rank: number;
}

interface NeighborDatabaseRow {
  readonly entry_id: string;
  readonly parent_id: string | null;
  readonly timestamp: string;
  readonly kind: string;
  readonly role: string;
  readonly active: number;
  readonly text: string;
}

interface SessionDatabaseRow {
  readonly session_id: string;
  readonly source_path: string;
  readonly header_timestamp: string;
  readonly header_cwd: string;
  readonly latest_timestamp: string;
  readonly leaf_id: string | null;
  readonly size: number;
  readonly mtime_ms: number;
  readonly searchable_entries: number;
  readonly active_entries: number;
  readonly compactions: number;
  readonly branch_summaries: number;
}

interface RoleCountRow {
  readonly role: string;
  readonly entries: number;
}

interface ActiveEntryRow {
  readonly entry_id: string;
  readonly parent_id: string | null;
  readonly kind: string;
  readonly role: string;
  readonly timestamp: string;
}

export interface RefreshResult {
  readonly discoveredFiles: number;
  readonly changedFiles: number;
  readonly deletedFiles: number;
  readonly indexedFiles: number;
}

export interface SessionListInput {
  readonly limit?: number;
  readonly since?: string;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly path: string;
  readonly headerTimestamp: string;
  readonly headerCwd: string;
  readonly latestTimestamp: string;
  readonly activeLeafId: string | null;
  readonly size: number;
  readonly searchableEntries: number;
  readonly activeEntries: number;
  readonly compactions: number;
  readonly branchSummaries: number;
}

export interface SessionDescription {
  readonly sessionId: string;
  readonly path: string;
  readonly headerTimestamp: string;
  readonly headerCwd: string;
  readonly latestTimestamp: string;
  readonly activeLeafId: string | null;
  readonly size: number;
  readonly searchableEntries: number;
  readonly activeEntries: number;
  readonly compactions: number;
  readonly branchSummaries: number;
  readonly roles: ReadonlyArray<{ readonly role: string; readonly entries: number }>;
  readonly activeBranch: ReadonlyArray<{
    readonly entryId: string;
    readonly parentId: string | null;
    readonly kind: string;
    readonly role: string;
    readonly timestamp: string;
  }>;
}

export interface SearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly role?: string;
  readonly session?: string;
  readonly since?: string;
  readonly until?: string;
  readonly activeOnly?: boolean;
}

export interface SearchResult {
  readonly sessionId: string;
  readonly path: string;
  readonly entryId: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly kind: string;
  readonly role: string;
  readonly active: boolean;
  readonly snippet: string;
  readonly score: number;
  readonly match: "and" | "or";
}

export interface ExpandInput extends SearchInput {
  readonly context?: number;
}

export interface ExpandedMatch {
  readonly match: SearchResult;
  readonly evidence: ReadonlyArray<{
    readonly entryId: string;
    readonly parentId: string | null;
    readonly timestamp: string;
    readonly kind: string;
    readonly role: string;
    readonly active: boolean;
    readonly text: string;
  }>;
}

const boundedInteger = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(maximum, Math.floor(value)));
};

const boundedText = (value: string, maximum: number = MAX_SNIPPET_CHARS): string => {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
};

const discoverSessionFiles = (profile: string): ReadonlyArray<DiscoveredFile> => {
  const sessionsRoot = join(profile, "sessions");
  const paths: string[] = [];
  const visitedDirectories = new Set<string>();

  const visit = (directory: string): void => {
    const directoryMetadata = statSync(directory);
    const directoryIdentity = `${directoryMetadata.dev}:${directoryMetadata.ino}`;
    if (visitedDirectories.has(directoryIdentity)) {
      return;
    }
    visitedDirectories.add(directoryIdentity);

    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const childPath = join(directory, child.name);
      if (child.isDirectory()) {
        visit(childPath);
      } else if (child.isFile() && child.name.endsWith(".jsonl")) {
        paths.push(childPath);
      } else if (existsSync(childPath)) {
        const targetMetadata = statSync(childPath);
        if (targetMetadata.isDirectory()) {
          visit(childPath);
        } else if (targetMetadata.isFile() && child.name.endsWith(".jsonl")) {
          paths.push(childPath);
        }
      }
    }
  };

  if (!existsSync(sessionsRoot)) {
    return [];
  }
  visit(sessionsRoot);
  paths.sort((left, right) => left.localeCompare(right));

  return paths.map((absolutePath) => {
    const metadata = statSync(absolutePath);
    return {
      absolutePath,
      sourcePath: relative(profile, absolutePath),
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    };
  });
};

const stringifyArguments = (value: unknown): string => {
  if (value === undefined) {
    return "";
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "" : encoded;
};

const messageText = (
  message: Schema.Schema.Type<typeof MessageSchema>,
): { readonly role: string; readonly text: string } | undefined => {
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length === 0 ? undefined : { role: message.role, text };
  }

  const parts: string[] = [];
  for (const item of message.content) {
    if (item.type === "text" && item.text !== undefined) {
      parts.push(item.text);
    } else if (item.type === "toolCall" && item.name !== undefined) {
      const argumentsText = stringifyArguments(item.arguments);
      parts.push(`tool call ${item.name}${argumentsText.length === 0 ? "" : ` ${argumentsText}`}`);
    }
  }

  if (message.role === "toolResult" && message.toolName !== undefined) {
    parts.unshift(`tool result ${message.toolName}`);
  }

  const text = parts.join("\n").trim();
  return text.length === 0 ? undefined : { role: message.role, text };
};

const projectFile = (file: DiscoveredFile): FileProjection | undefined => {
  const contents = readFileSync(file.absolutePath, "utf8");
  const lines = contents.split(/\r?\n/);
  const headerLine = lines.find((line) => line.trim().length > 0);
  if (headerLine === undefined) {
    return undefined;
  }

  const decodedHeader = decodeJsonLine(headerLine);
  if (Option.isNone(decodedHeader)) {
    return undefined;
  }

  const header = decodedHeader.value;
  const sessionId = header.id;
  const headerTimestamp = header.timestamp;
  if (header.type !== "session" || sessionId === undefined || headerTimestamp === undefined) {
    return undefined;
  }
  const decodedEntries: Array<{
    readonly ordinal: number;
    readonly type: string;
    readonly id: string;
    readonly parentId: string | null;
    readonly timestamp: string;
    readonly message: Schema.Schema.Type<typeof MessageSchema> | undefined;
    readonly summary: string | undefined;
  }> = [];
  const parentById = new Map<string, string | null>();
  let leafId: string | null = null;

  for (const [lineIndex, line] of lines.entries()) {
    if (line.trim().length === 0 || line === headerLine) {
      continue;
    }
    const decoded = decodeJsonLine(line);
    if (Option.isNone(decoded)) {
      continue;
    }

    const entry = decoded.value;
    const entryId = entry.id;
    const parentId = entry.parentId;
    if (entry.type === "session" || entryId === undefined || parentId === undefined) {
      continue;
    }
    decodedEntries.push({
      ordinal: lineIndex,
      type: entry.type,
      id: entryId,
      parentId,
      timestamp: entry.timestamp ?? headerTimestamp,
      message: entry.message,
      summary: entry.summary,
    });
    parentById.set(entryId, parentId);
    leafId = entryId;
  }

  const activeIds = new Set<string>();
  let cursor: string | null | undefined = leafId;
  while (cursor !== undefined && cursor !== null && !activeIds.has(cursor)) {
    activeIds.add(cursor);
    cursor = parentById.get(cursor);
  }

  const projectedEntries: ProjectedEntry[] = [];
  for (const entry of decodedEntries) {
    if (entry.type === "message" && entry.message !== undefined) {
      const extracted = messageText(entry.message);
      if (extracted !== undefined) {
        projectedEntries.push({
          ordinal: entry.ordinal,
          entryId: entry.id,
          parentId: entry.parentId,
          timestamp: entry.timestamp,
          kind: "message",
          role: extracted.role,
          text: extracted.text,
          active: activeIds.has(entry.id),
        });
      }
    } else if (
      (entry.type === "compaction" || entry.type === "branch_summary") &&
      entry.summary !== undefined &&
      entry.summary.trim().length > 0
    ) {
      projectedEntries.push({
        ordinal: entry.ordinal,
        entryId: entry.id,
        parentId: entry.parentId,
        timestamp: entry.timestamp,
        kind: entry.type,
        role: entry.type,
        text: entry.summary,
        active: activeIds.has(entry.id),
      });
    }
  }

  const latestTimestamp =
    decodedEntries.length === 0
      ? headerTimestamp
      : (decodedEntries[decodedEntries.length - 1]?.timestamp ?? headerTimestamp);

  return {
    file,
    sessionId,
    headerTimestamp,
    headerCwd: header.cwd ?? "",
    latestTimestamp,
    leafId,
    entries: projectedEntries,
  };
};

const openIndex = (profile: string): Database => {
  const indexPath = join(profile, INDEX_RELATIVE_PATH);
  mkdirSync(join(profile, ".runtime", "lossless-claw"), { recursive: true });
  const database = new Database(indexPath, { create: true, readwrite: true, strict: true });
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS source_files (
      source_path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      session_id TEXT NOT NULL,
      header_timestamp TEXT NOT NULL,
      header_cwd TEXT NOT NULL,
      latest_timestamp TEXT NOT NULL,
      leaf_id TEXT
    );
    CREATE INDEX IF NOT EXISTS source_files_session_id
      ON source_files(session_id);
    CREATE TABLE IF NOT EXISTS entries (
      source_path TEXT NOT NULL REFERENCES source_files(source_path) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      parent_id TEXT,
      timestamp TEXT NOT NULL,
      kind TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      active INTEGER NOT NULL,
      UNIQUE(source_path, ordinal)
    );
    CREATE INDEX IF NOT EXISTS entries_source_ordinal
      ON entries(source_path, ordinal);
    CREATE INDEX IF NOT EXISTS entries_session
      ON entries(session_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS entry_search
      USING fts5(text, tokenize = 'unicode61');
  `);
  return database;
};

const removeProjection = (database: Database, sourcePath: string): void => {
  database
    .query<unknown, [string]>(
      "DELETE FROM entry_search WHERE rowid IN (SELECT rowid FROM entries WHERE source_path = ?)",
    )
    .run(sourcePath);
  database.query<unknown, [string]>("DELETE FROM entries WHERE source_path = ?").run(sourcePath);
  database
    .query<unknown, [string]>("DELETE FROM source_files WHERE source_path = ?")
    .run(sourcePath);
};

const insertProjection = (database: Database, projection: FileProjection): void => {
  database
    .query<unknown, [string, number, number, string, string, string, string, string | null]>(
      `INSERT INTO source_files (
        source_path, size, mtime_ms, session_id, header_timestamp, header_cwd,
        latest_timestamp, leaf_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projection.file.sourcePath,
      projection.file.size,
      projection.file.mtimeMs,
      projection.sessionId,
      projection.headerTimestamp,
      projection.headerCwd,
      projection.latestTimestamp,
      projection.leafId,
    );

  const insertEntry = database.query<
    unknown,
    [string, number, string, string, string | null, string, string, string, string, number]
  >(
    `INSERT INTO entries (
      source_path, ordinal, session_id, entry_id, parent_id, timestamp, kind, role, text, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSearch = database.query<unknown, [number | bigint, string]>(
    "INSERT INTO entry_search(rowid, text) VALUES (?, ?)",
  );

  for (const entry of projection.entries) {
    const inserted = insertEntry.run(
      projection.file.sourcePath,
      entry.ordinal,
      projection.sessionId,
      entry.entryId,
      entry.parentId,
      entry.timestamp,
      entry.kind,
      entry.role,
      entry.text,
      entry.active ? 1 : 0,
    );
    insertSearch.run(inserted.lastInsertRowid, entry.text);
  }
};

const refreshDatabase = (profile: string, database: Database): RefreshResult => {
  const discovered = discoverSessionFiles(profile);
  const existingRows = database
    .query<FileStateRow, []>("SELECT source_path, size, mtime_ms FROM source_files")
    .all();
  const existing = new Map(existingRows.map((row) => [row.source_path, row]));
  const currentPaths = new Set(discovered.map((file) => file.sourcePath));
  const deletedPaths = [...existing.keys()].filter((sourcePath) => !currentPaths.has(sourcePath));
  const changedFiles = discovered.filter((file) => {
    const previous = existing.get(file.sourcePath);
    return (
      previous === undefined || previous.size !== file.size || previous.mtime_ms !== file.mtimeMs
    );
  });
  const projections = changedFiles.map(projectFile);

  const replace = database.transaction(() => {
    for (const sourcePath of deletedPaths) {
      removeProjection(database, sourcePath);
    }
    for (const [index, file] of changedFiles.entries()) {
      removeProjection(database, file.sourcePath);
      const projection = projections[index];
      if (projection !== undefined) {
        insertProjection(database, projection);
      }
    }
  });
  replace.immediate();

  return {
    discoveredFiles: discovered.length,
    changedFiles: changedFiles.length,
    deletedFiles: deletedPaths.length,
    indexedFiles: projections.filter(Predicate.isNotUndefined).length,
  };
};

const withFreshIndex = <Result>(profile: string, use: (database: Database) => Result): Result => {
  using database = openIndex(profile);
  refreshDatabase(profile, database);
  return use(database);
};

export const refreshProfileIndex = (profile: string): RefreshResult => {
  using database = openIndex(profile);
  return refreshDatabase(profile, database);
};

export const listProfileSessions = (
  profile: string,
  input: SessionListInput = {},
): ReadonlyArray<SessionSummary> =>
  withFreshIndex(profile, (database) => {
    const limit = boundedInteger(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const bindings: Record<string, string | number | null> = {
      since: input.since ?? null,
      limit,
    };
    const rows = database
      .query<SessionDatabaseRow, Record<string, string | number | null>>(
        `SELECT
          sf.session_id,
          sf.source_path,
          sf.header_timestamp,
          sf.header_cwd,
          sf.latest_timestamp,
          sf.leaf_id,
          sf.size,
          sf.mtime_ms,
          COUNT(e.rowid) AS searchable_entries,
          COALESCE(SUM(e.active), 0) AS active_entries,
          COALESCE(SUM(CASE WHEN e.kind = 'compaction' THEN 1 ELSE 0 END), 0) AS compactions,
          COALESCE(SUM(CASE WHEN e.kind = 'branch_summary' THEN 1 ELSE 0 END), 0)
            AS branch_summaries
        FROM source_files sf
        LEFT JOIN entries e ON e.source_path = sf.source_path
        WHERE ($since IS NULL OR sf.latest_timestamp >= $since)
        GROUP BY sf.source_path
        ORDER BY sf.latest_timestamp DESC, sf.source_path ASC
        LIMIT $limit`,
      )
      .all(bindings);

    return rows.map((row) => ({
      sessionId: row.session_id,
      path: join(profile, row.source_path),
      headerTimestamp: row.header_timestamp,
      headerCwd: row.header_cwd,
      latestTimestamp: row.latest_timestamp,
      activeLeafId: row.leaf_id,
      size: row.size,
      searchableEntries: row.searchable_entries,
      activeEntries: row.active_entries,
      compactions: row.compactions,
      branchSummaries: row.branch_summaries,
    }));
  });

const sessionSelectorPath = (profile: string, selector: string): string =>
  isAbsolute(selector) ? relative(profile, selector) : selector;

export const describeProfileSession = (
  profile: string,
  selector: string,
): SessionDescription | undefined =>
  withFreshIndex(profile, (database) => {
    const selectorPath = sessionSelectorPath(profile, selector);
    const row = database
      .query<SessionDatabaseRow, [string, string]>(
        `SELECT
          sf.session_id,
          sf.source_path,
          sf.header_timestamp,
          sf.header_cwd,
          sf.latest_timestamp,
          sf.leaf_id,
          sf.size,
          sf.mtime_ms,
          COUNT(e.rowid) AS searchable_entries,
          COALESCE(SUM(e.active), 0) AS active_entries,
          COALESCE(SUM(CASE WHEN e.kind = 'compaction' THEN 1 ELSE 0 END), 0) AS compactions,
          COALESCE(SUM(CASE WHEN e.kind = 'branch_summary' THEN 1 ELSE 0 END), 0)
            AS branch_summaries
        FROM source_files sf
        LEFT JOIN entries e ON e.source_path = sf.source_path
        WHERE sf.session_id = ? OR sf.source_path = ?
        GROUP BY sf.source_path
        ORDER BY sf.latest_timestamp DESC
        LIMIT 1`,
      )
      .get(selector, selectorPath);
    if (row === null) {
      return undefined;
    }

    const roles = database
      .query<RoleCountRow, [string]>(
        `SELECT role, COUNT(*) AS entries
        FROM entries
        WHERE source_path = ?
        GROUP BY role
        ORDER BY role`,
      )
      .all(row.source_path);
    const activeBranch = database
      .query<ActiveEntryRow, [string]>(
        `SELECT entry_id, parent_id, kind, role, timestamp
        FROM entries
        WHERE source_path = ? AND active = 1
        ORDER BY ordinal`,
      )
      .all(row.source_path);

    return {
      sessionId: row.session_id,
      path: join(profile, row.source_path),
      headerTimestamp: row.header_timestamp,
      headerCwd: row.header_cwd,
      latestTimestamp: row.latest_timestamp,
      activeLeafId: row.leaf_id,
      size: row.size,
      searchableEntries: row.searchable_entries,
      activeEntries: row.active_entries,
      compactions: row.compactions,
      branchSummaries: row.branch_summaries,
      roles: roles.map((role) => ({ role: role.role, entries: role.entries })),
      activeBranch: activeBranch.map((entry) => ({
        entryId: entry.entry_id,
        parentId: entry.parent_id,
        kind: entry.kind,
        role: entry.role,
        timestamp: entry.timestamp,
      })),
    };
  });

const searchTerms = (query: string): ReadonlyArray<string> => {
  const matches = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const unique = new Map(matches.map((term) => [term.toLocaleLowerCase(), term]));
  return [...unique.values()].map((term) => `"${term}"`);
};

const runSearch = (
  profile: string,
  database: Database,
  input: SearchInput,
): ReadonlyArray<SearchResult> => {
  const terms = searchTerms(input.query);
  if (terms.length === 0) {
    return [];
  }

  const limit = boundedInteger(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const bindingsBase: Record<string, string | number | null> = {
    session: input.session ?? null,
    role: input.role ?? null,
    since: input.since ?? null,
    until: input.until ?? null,
    active_only: input.activeOnly === true ? 1 : 0,
    limit,
  };
  const statement = database.query<SearchDatabaseRow, Record<string, string | number | null>>(
    `SELECT
      e.rowid AS row_id,
      e.session_id,
      e.source_path,
      e.entry_id,
      e.parent_id,
      e.timestamp,
      e.kind,
      e.role,
      e.active,
      snippet(entry_search, 0, '[', ']', ' … ', 32) AS snippet,
      bm25(entry_search) AS rank
    FROM entry_search
    JOIN entries e ON e.rowid = entry_search.rowid
    WHERE entry_search MATCH $match
      AND ($session IS NULL OR e.session_id = $session)
      AND ($role IS NULL OR e.role = $role)
      AND ($since IS NULL OR e.timestamp >= $since)
      AND ($until IS NULL OR e.timestamp <= $until)
      AND ($active_only = 0 OR e.active = 1)
    ORDER BY rank ASC, e.timestamp DESC, e.rowid ASC
    LIMIT $limit`,
  );
  const selected = new Map<number, SearchResult>();

  const collect = (match: "and" | "or", expression: string): void => {
    const bindings: Record<string, string | number | null> = {
      ...bindingsBase,
      match: expression,
    };
    for (const row of statement.all(bindings)) {
      if (!selected.has(row.row_id) && selected.size < limit) {
        selected.set(row.row_id, {
          sessionId: row.session_id,
          path: join(profile, row.source_path),
          entryId: row.entry_id,
          parentId: row.parent_id,
          timestamp: row.timestamp,
          kind: row.kind,
          role: row.role,
          active: row.active === 1,
          snippet: boundedText(row.snippet),
          score: row.rank,
          match,
        });
      }
    }
  };

  collect("and", terms.join(" AND "));
  if (selected.size < limit && terms.length > 1) {
    collect("or", terms.join(" OR "));
  }

  return [...selected.values()];
};

export const searchProfileSessions = (
  profile: string,
  input: SearchInput,
): ReadonlyArray<SearchResult> =>
  withFreshIndex(profile, (database) => runSearch(profile, database, input));

export const expandProfileQuery = (
  profile: string,
  input: ExpandInput,
): ReadonlyArray<ExpandedMatch> =>
  withFreshIndex(profile, (database) => {
    const context = boundedInteger(input.context, 2, 10);
    const matches = runSearch(profile, database, {
      ...input,
      limit: boundedInteger(input.limit, 5, 20),
    });
    const neighborStatement = database.query<
      NeighborDatabaseRow,
      [number, number, number, number, number]
    >(
      `SELECT entry_id, parent_id, timestamp, kind, role, active, text
      FROM entries
      WHERE source_path = (
        SELECT source_path FROM entries WHERE rowid = ?
      )
        AND ordinal BETWEEN (
          SELECT ordinal - ? FROM entries WHERE rowid = ?
        ) AND (
          SELECT ordinal + ? FROM entries WHERE rowid = ?
        )
      ORDER BY ordinal`,
    );
    const rowIdStatement = database.query<{ readonly row_id: number }, [string, string]>(
      "SELECT rowid AS row_id FROM entries WHERE source_path = ? AND entry_id = ? LIMIT 1",
    );

    return matches.map((match) => {
      const sourcePath = sessionSelectorPath(profile, match.path);
      const rowId = rowIdStatement.get(sourcePath, match.entryId);
      const evidence =
        rowId === null
          ? []
          : neighborStatement
              .all(rowId.row_id, context, rowId.row_id, context, rowId.row_id)
              .map((entry) => ({
                entryId: entry.entry_id,
                parentId: entry.parent_id,
                timestamp: entry.timestamp,
                kind: entry.kind,
                role: entry.role,
                active: entry.active === 1,
                text: boundedText(entry.text, 900),
              }));
      return { match, evidence };
    });
  });
