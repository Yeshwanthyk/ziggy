import { readFileSync } from "node:fs";
import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { codePointLength } from "../../domain/memory";
import {
  PI_DOC_FILES,
  PI_DOCS_FINGERPRINT,
  PI_DOCS_PACKAGE,
  PI_DOCS_VERSION,
} from "./generated/pi-docs";

export const PI_DOCS_QUERY_MAX_CODE_POINTS = 256;
export const PI_DOCS_PATH_MAX_CODE_POINTS = 256;
export const PI_DOCS_MAX_RESULTS = 32;
export const PI_DOCS_MAX_OUTPUT_BYTES = 32 * 1024;
export const PI_DOCS_MAX_READ_LINES = 400;
export const PI_DOCS_MAX_LINE = 100_000;
export const PI_DOCS_MATCH_TEXT_MAX_CODE_POINTS = 500;

export interface PiDocDocument {
  readonly path: string;
  readonly content: string;
}

export const piDocsParameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal("list"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("search"),
      query: Type.String({ minLength: 1, maxLength: PI_DOCS_QUERY_MAX_CODE_POINTS }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("read"),
      path: Type.String({ minLength: 1, maxLength: PI_DOCS_PATH_MAX_CODE_POINTS }),
      startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: PI_DOCS_MAX_LINE })),
      endLine: Type.Optional(Type.Integer({ minimum: 1, maximum: PI_DOCS_MAX_LINE })),
    },
    { additionalProperties: false },
  ),
]);

export type PiDocsAction = Static<typeof piDocsParameters>;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const truncateUtf8 = (value: string, maxBytes: number) => {
  if (utf8Bytes(value) <= maxBytes) return { text: value, truncated: false as const };
  return {
    text: Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true as const,
  };
};

const failError = (error: string): string => JSON.stringify({ ok: false, error });

const failPath = (error: string, path: string): string =>
  JSON.stringify({ ok: false, error, path });

const failMax = (error: string, max: number): string => JSON.stringify({ ok: false, error, max });

const boundText = (value: string, maxCodePoints: number): string =>
  [...value].slice(0, maxCodePoints).join("");

export const loadPinnedPiDocs = (): ReadonlyArray<PiDocDocument> =>
  [...PI_DOC_FILES.entries()].map(([path, embeddedPath]) => ({
    path,
    content: readFileSync(embeddedPath, "utf8"),
  }));

export const describePinnedPiDocs = (
  documents: ReadonlyArray<PiDocDocument> = loadPinnedPiDocs(),
): string =>
  `${PI_DOCS_PACKAGE}@${PI_DOCS_VERSION} fingerprint=${PI_DOCS_FINGERPRINT} count=${documents.length}`;

export const listPinnedPiDocs = (documents: ReadonlyArray<PiDocDocument>): string =>
  JSON.stringify({
    action: "list",
    package: PI_DOCS_PACKAGE,
    version: PI_DOCS_VERSION,
    paths: documents.map((document) => document.path),
  });

export const searchPinnedPiDocs = (
  documents: ReadonlyArray<PiDocDocument>,
  query: string,
): string => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return failError("query_empty");
  if (codePointLength(trimmed) > PI_DOCS_QUERY_MAX_CODE_POINTS) {
    return failMax("query_too_long", PI_DOCS_QUERY_MAX_CODE_POINTS);
  }

  const needle = trimmed.toLowerCase();
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let truncated = false;
  for (const document of documents) {
    const lines = document.content.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(needle)) continue;
      if (matches.length >= PI_DOCS_MAX_RESULTS) {
        truncated = true;
        break;
      }
      matches.push({
        path: document.path,
        line: index + 1,
        text: boundText(line, PI_DOCS_MATCH_TEXT_MAX_CODE_POINTS),
      });
    }
    if (truncated) break;
  }

  return JSON.stringify({
    action: "search",
    query: trimmed,
    truncated,
    matches,
  });
};

export const readPinnedPiDocs = (
  documents: ReadonlyArray<PiDocDocument>,
  path: string,
  startLine: number | undefined,
  endLine: number | undefined,
): string => {
  if (codePointLength(path) > PI_DOCS_PATH_MAX_CODE_POINTS) {
    return failMax("path_too_long", PI_DOCS_PATH_MAX_CODE_POINTS);
  }
  const document = documents.find((candidate) => candidate.path === path);
  if (document === undefined) return failPath("unknown_path", path);

  const lines = document.content.split("\n");
  const start = startLine ?? 1;
  const requestedEnd = endLine ?? Math.min(lines.length, start + PI_DOCS_MAX_READ_LINES - 1);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(requestedEnd) ||
    start < 1 ||
    requestedEnd < 1 ||
    start > PI_DOCS_MAX_LINE ||
    requestedEnd > PI_DOCS_MAX_LINE ||
    start > requestedEnd ||
    start > lines.length
  ) {
    return failError("invalid_line_range");
  }

  const fileEnd = Math.min(requestedEnd, lines.length);
  const limitedEnd = Math.min(fileEnd, start + PI_DOCS_MAX_READ_LINES - 1);
  const limited = lines.slice(start - 1, limitedEnd);
  const body = truncateUtf8(limited.join("\n"), PI_DOCS_MAX_OUTPUT_BYTES);
  return JSON.stringify({
    action: "read",
    path,
    startLine: start,
    endLine: start + limited.length - 1,
    truncated: limitedEnd < fileEnd || body.truncated,
    content: body.text,
  });
};

export const runPiDocsAction = (
  documents: ReadonlyArray<PiDocDocument>,
  params: PiDocsAction,
): string => {
  if (params.action === "list") return listPinnedPiDocs(documents);
  if (params.action === "search") return searchPinnedPiDocs(documents, params.query);
  return readPinnedPiDocs(documents, params.path, params.startLine, params.endLine);
};

const toolResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

export const createPiDocsTool = (): ToolDefinition<typeof piDocsParameters> => ({
  name: "pi_docs",
  label: "pi_docs",
  description:
    "Look up the pinned offline Pi documentation compiled into Ziggy (README.md and docs/*.md for @earendil-works/pi-coding-agent@0.84.1). Use list, search, or read. Do not fetch Pi docs from the network.",
  promptSnippet: "Pinned offline Pi README and docs/*.md lookup (list, search, read).",
  promptGuidelines: [
    "Use pi_docs for Pi README and docs/*.md instead of network fetches or source checkout paths.",
  ],
  parameters: piDocsParameters,
  execute(_toolCallId, params) {
    return Promise.resolve(toolResult(runPiDocsAction(loadPinnedPiDocs(), params)));
  },
});

export const createPiDocsExtension = (): InlineExtension => ({
  name: "pi_docs",
  hidden: true,
  factory: (pi) => {
    pi.registerTool(createPiDocsTool());
  },
});
