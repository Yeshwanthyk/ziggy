/* eslint-disable ziggy-effect/no-native-promise-ownership -- This executable owns its HTTP Promise boundary. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- This executable converts process failures into JSON and exit codes. */
/* eslint-disable ziggy-effect/no-error-constructor -- HTTP and protocol failures terminate this executable boundary. */
/* eslint-disable ziggy-effect/no-json-parse -- TypeBox validates every parsed unknown value immediately. */
/* eslint-disable ziggy-effect/no-instanceof-error -- The executable normalizes unknown top-level failures for stderr-safe output. */
import { Type } from "typebox";
import { Check } from "typebox/value";

const MCP_URL = "https://mcp.exa.ai/mcp";
const REQUEST_TIMEOUT_MS = 30_000;

const McpMessage = Type.Object(
  {
    error: Type.Optional(Type.Object({ message: Type.String() }, { additionalProperties: true })),
    result: Type.Optional(
      Type.Object(
        {
          content: Type.Array(Type.Object({ text: Type.String() }, { additionalProperties: true })),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const ExaResults = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        {
          title: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          summary: Type.Optional(Type.String()),
          highlights: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

interface SearchResult {
  title: string;
  url: string;
  highlight: string;
}

interface SearchOutput {
  query: string;
  answer: string;
  results: SearchResult[];
}

const parseArgs = (args: string[]): { query: string; count: number } => {
  let count = 5;
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--n") {
      const value = args[index + 1];
      if (value !== undefined) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) count = parsed;
        index += 1;
      }
    } else if (argument !== undefined && !argument.startsWith("--")) {
      words.push(argument);
    }
  }
  return { query: words.join(" ").trim(), count: Math.max(1, count) };
};

const clip = (value: string, maximum: number): string => value.slice(0, maximum);

const canned = (query: string, count: number): SearchOutput => ({
  query,
  answer: `(offline) Top result for: ${query}`,
  results: Array.from({ length: Math.min(3, count) }, (_, index) => ({
    title: `Result ${index + 1} for ${query}`,
    url: `https://example.com/${index + 1}`,
    highlight: "...",
  })),
});

const parseJsonResults = (text: string, count: number): SearchResult[] => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Check(ExaResults, value)) return [];
  return value.results.slice(0, count).map((item) => ({
    title: item.title ?? "",
    url: item.url ?? "",
    highlight: clip(item.highlights?.[0] ?? item.text ?? item.summary ?? "", 300),
  }));
};

const parseDigest = (text: string, count: number): SearchResult[] => {
  const results: SearchResult[] = [];
  for (const block of text.split("\n---\n")) {
    let title = "";
    let url = "";
    let inHighlights = false;
    const highlights: string[] = [];
    for (const line of block.split("\n")) {
      const value = line.trim();
      if (value.startsWith("Title:")) {
        title = value.slice(6).trim();
        inHighlights = false;
      } else if (value.startsWith("URL:")) {
        url = value.slice(4).trim();
        inHighlights = false;
      } else if (value.startsWith("Published:") || value.startsWith("Author:")) {
        inHighlights = false;
      } else if (value.startsWith("Highlights:")) {
        inHighlights = true;
      } else if (inHighlights && value && value !== "[...]") {
        highlights.push(value);
      }
    }
    if (url) results.push({ title, url, highlight: clip(highlights.join(" "), 300) });
    if (results.length >= count) break;
  }
  return results;
};

const mcpCall = async (endpoint: string, query: string, count: number): Promise<string> => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, numResults: count, type: "auto", livecrawl: "fallback" },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Exa MCP status ${response.status}: ${clip(body.trim(), 200)}`);
  }
  let payload = "";
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed.slice(5).trim());
    } catch {
      continue;
    }
    if (!Check(McpMessage, value)) continue;
    if (value.error) throw new Error(value.error.message);
    const text = value.result?.content[0]?.text;
    if (text) payload = text;
  }
  if (!payload) throw new Error("no content in Exa response");
  return payload;
};

const search = async (query: string, count: number, key: string): Promise<SearchOutput> => {
  if (key.startsWith("fake")) return canned(query, count);
  const endpoint = key ? `${MCP_URL}?exaApiKey=${encodeURIComponent(key)}` : MCP_URL;
  const text = await mcpCall(endpoint, query, count);
  const results = parseJsonResults(text, count);
  const parsed = results.length > 0 ? results : parseDigest(text, count);
  return { query, answer: parsed.length > 0 ? "" : text, results: parsed };
};

const { query, count } = parseArgs(process.argv.slice(2));
if (!query) {
  process.stdout.write(`${JSON.stringify({ error: "empty query" }, null, 2)}\n`);
  process.exit(2);
}

try {
  const result = await search(query, count, process.env.EXA_API_KEY?.trim() ?? "");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (cause: unknown) {
  const message = cause instanceof Error ? cause.message : "unknown search failure";
  process.stdout.write(`${JSON.stringify({ error: `search failed: ${message}` }, null, 2)}\n`);
  process.exit(1);
}
