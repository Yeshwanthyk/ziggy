import { Schema } from "effect";
import type { SessionMetadata, SessionReferenceMetadata, SessionUsage } from "../domain/session";

const SessionReferenceJson = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
});

const SessionUsageJson = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  reasoning: Schema.optional(Schema.Finite),
  totalTokens: Schema.Finite,
  cost: Schema.Finite,
});

export const SessionMetadataJson = Schema.Struct({
  path: Schema.String,
  id: Schema.String,
  kind: Schema.Literals(["root", "child"]),
  createdAt: Schema.String,
  entryCount: Schema.Finite,
  parent: Schema.optional(SessionReferenceJson),
  parentUnknown: Schema.Boolean,
  children: Schema.Array(SessionReferenceJson),
  modelChanges: Schema.Array(
    Schema.Struct({
      at: Schema.String,
      provider: Schema.String,
      model: Schema.String,
    }),
  ),
  thinkingChanges: Schema.Array(
    Schema.Struct({
      at: Schema.String,
      level: Schema.String,
    }),
  ),
  usage: SessionUsageJson,
  terminalState: Schema.Literals(["completed", "aborted", "failed", "incomplete"]),
});
export type SessionMetadataJson = typeof SessionMetadataJson.Type;

export const SessionsJson = Schema.Array(SessionMetadataJson);
export type SessionsJson = typeof SessionsJson.Type;
const encodeSessions = Schema.encodeSync(SessionsJson);
const encodeSession = Schema.encodeSync(SessionMetadataJson);

const parentLabel = (session: SessionMetadata): string =>
  session.parent === undefined ? (session.parentUnknown ? "unknown" : "-") : session.parent.id;

const reference = (value: SessionReferenceMetadata): string => `${value.id}\t${value.path}`;

const usage = (value: SessionUsage): string =>
  [
    `${value.input} input`,
    `${value.output} output`,
    `${value.cacheRead} cache-read`,
    `${value.cacheWrite} cache-write`,
    ...(value.reasoning === undefined ? [] : [`${value.reasoning} reasoning`]),
    `${value.totalTokens} total`,
    `$${value.cost.toFixed(6)}`,
  ].join(" · ");

export const renderSessionList = (sessions: ReadonlyArray<SessionMetadata>): string => {
  if (sessions.length === 0) return "no sessions";
  return sessions
    .map(
      (session) =>
        `${session.path}\t${session.id}\t${session.kind}\t${session.createdAt}\t${session.entryCount} entries\tparent ${parentLabel(session)}\t${session.children.length} children\t${session.terminalState}`,
    )
    .join("\n");
};

export const renderSessionListJson = (sessions: ReadonlyArray<SessionMetadataJson>): string =>
  JSON.stringify(encodeSessions(sessions));

export const renderSession = (session: SessionMetadata): string => {
  const lines = [
    `path\t${session.path}`,
    `id\t${session.id}`,
    `kind\t${session.kind}`,
    `created\t${session.createdAt}`,
    `entries\t${session.entryCount}`,
    `state\t${session.terminalState}`,
    `parent\t${parentLabel(session)}`,
    `usage\t${usage(session.usage)}`,
  ];
  if (session.parent !== undefined) lines.push(`parent-path\t${session.parent.path}`);
  for (const child of session.children) lines.push(`child\t${reference(child)}`);
  for (const change of session.modelChanges)
    lines.push(`model\t${change.at}\t${change.provider}/${change.model}`);
  for (const change of session.thinkingChanges)
    lines.push(`thinking\t${change.at}\t${change.level}`);
  return lines.join("\n");
};

export const renderSessionJson = (session: SessionMetadataJson): string =>
  JSON.stringify(encodeSession(session));
