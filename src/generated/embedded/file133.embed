/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution is this package's required Promise adapter boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Pi requires thrown tool errors to mark failed executions. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Pi's tool boundary accepts Error failures, not Effect errors. */
/* oxlint-disable ziggy-effect/no-json-parse -- MCP wire boundary; every parsed message is checked against a TypeBox schema before use. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const DEFAULT_URL = "http://127.0.0.1:4312/mcp";

/** The macOS Keychain item that holds the Executor personal access token. */
export const KEYCHAIN_SERVICE = "ziggy-executor";

const PROTOCOL_VERSION = "2025-06-18";

const OUTPUT_LIMIT = 32 * 1024;

/** Executor stops a program after five minutes; leave room for the response. */
const CALL_TIMEOUT_MS = 330_000;

const SETUP_HINT = `Executor is not set up: start the local server (\`executor serve\`), copy the API key from its dashboard Connect card, then store it with \`security add-generic-password -U -a executor -s ${KEYCHAIN_SERVICE} -w\` or set EXECUTOR_API_KEY. Never paste the token into chat.`;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

type ClientOptions = {
  readonly url: string;
  readonly token: () => Promise<string>;
  readonly fetch: Fetch;
};

/** Every Executor MCP tool this package calls takes string arguments. */
export type ToolArguments = Readonly<Record<string, string>>;

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: Readonly<
    Record<
      string,
      string | ToolArguments | Readonly<Record<string, string>> | Readonly<Record<string, never>>
    >
  >;
};

const JsonRpcResponse = Type.Object({
  id: Type.Number(),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Object({ message: Type.Optional(Type.String()) })),
});

const CallToolResult = Type.Object({
  content: Type.Optional(
    Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) })),
  ),
  structuredContent: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()),
});

type JsonRpcResponse = Static<typeof JsonRpcResponse>;

type CallToolResult = Static<typeof CallToolResult>;

/** The response to request `id` among the parsed payloads, if the server sent one. */
const findResponse = (bodies: readonly string[], id: number): JsonRpcResponse | undefined => {
  for (const body of bodies) {
    const candidate = JSON.parse(body);

    if (Check(JsonRpcResponse, candidate) && candidate.id === id) return candidate;
  }

  return undefined;
};

const truncate = (text: string): string => {
  if (text.length <= OUTPUT_LIMIT) return text;

  return `${text.slice(0, OUTPUT_LIMIT)}\n… ${text.length - OUTPUT_LIMIT} characters omitted`;
};

/** The JSON-RPC payloads of a JSON body or of each server-sent event. */
const payloads = async (response: Response): Promise<readonly string[]> => {
  const body = await response.text();

  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return body.trim().length === 0 ? [] : [body];
  }

  return body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data.length > 0);
};

const renderResult = (result: CallToolResult): string => {
  const text = (result.content ?? [])
    .map((block) =>
      block.type === "text" && block.text !== undefined ? block.text : JSON.stringify(block),
    )
    .join("\n");

  if (text.length > 0) return text;

  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);

  return "Executor returned no content.";
};

/**
 * One MCP session over Streamable HTTP. The session is kept for the Pi session, because a
 * paused `execute` can only be resumed on the session that started it.
 */
export const createExecutorClient = (options: ClientOptions) => {
  let sessionId: string | undefined;
  let nextId = 1;

  const post = async (message: JsonRpcRequest, signal: AbortSignal) => {
    const session =
      sessionId === undefined
        ? {}
        : { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION };

    return options.fetch(options.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await options.token()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...session,
      },
      body: JSON.stringify(message),
      signal,
    });
  };

  const request = async (
    method: string,
    params: NonNullable<JsonRpcRequest["params"]>,
    signal: AbortSignal,
  ) => {
    const id = nextId++;
    const response = await post({ jsonrpc: "2.0", id, method, params }, signal);

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();

      throw new Error(
        `Executor refused the token (HTTP ${response.status}). It may be expired, revoked, or scoped to another organization. ${SETUP_HINT}`,
      );
    }

    // A 404 on an established session means the server forgot it.
    if (response.status === 404 && sessionId !== undefined) {
      await response.body?.cancel();

      return "session-expired" as const;
    }

    if (!response.ok) {
      throw new Error(`Executor HTTP ${response.status}: ${truncate(await response.text())}`);
    }

    const message = findResponse(await payloads(response), id);

    if (message === undefined) throw new Error(`Executor sent no response to ${method}.`);

    if (message.error !== undefined) {
      throw new Error(`Executor ${method} failed: ${message.error.message ?? "unknown error"}`);
    }

    return { response, result: message.result };
  };

  const initialize = async (signal: AbortSignal) => {
    sessionId = undefined;

    const initialized = await request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ziggy-executor", version: "0.2.0" },
      },
      signal,
    );

    if (initialized === "session-expired") throw new Error("Executor refused a new session.");

    sessionId = initialized.response.headers.get("mcp-session-id") ?? undefined;

    const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);

    await notified.body?.cancel();
  };

  const callTool = async (name: string, args: ToolArguments, signal: AbortSignal) => {
    const call = () => request("tools/call", { name, arguments: args }, signal);

    if (sessionId === undefined) await initialize(signal);

    let outcome = await call();

    if (outcome === "session-expired") {
      await initialize(signal);
      outcome = await call();
    }

    if (outcome === "session-expired") throw new Error("Executor dropped the session twice.");

    if (!Check(CallToolResult, outcome.result))
      throw new Error(`Executor ${name} returned an unexpected result.`);

    const text = truncate(renderResult(outcome.result));

    if (outcome.result.isError === true) throw new Error(text);

    return text;
  };

  /** Best effort: tell the server this session is over. */
  const close = async () => {
    if (sessionId === undefined) return;

    const session = sessionId;

    sessionId = undefined;

    try {
      const response = await options.fetch(options.url, {
        method: "DELETE",
        headers: { authorization: `Bearer ${await options.token()}`, "mcp-session-id": session },
        signal: AbortSignal.timeout(5_000),
      });

      await response.body?.cancel();
    } catch {
      // The server expires abandoned sessions on its own.
    }
  };

  return { callTool, close };
};

/** EXECUTOR_API_KEY wins; otherwise read the token from the macOS Keychain. */
const readToken = async (exec: ExtensionAPI["exec"]): Promise<string> => {
  const fromEnv = process.env.EXECUTOR_API_KEY?.trim() ?? "";

  if (fromEnv.length > 0) return fromEnv;

  if (process.platform === "darwin") {
    const result = await exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      timeout: 10_000,
    });

    const token = result.stdout.trim();

    if (result.code === 0 && token.length > 0) return token;
  }

  throw new Error(SETUP_HINT);
};

const Skills = Type.Object(
  {
    app: Type.Optional(
      Type.String({ description: "App slug, to list or read that app's skills." }),
    ),
    name: Type.Optional(Type.String({ description: 'Skill name, e.g. "execute". Omit to list.' })),
  },
  { additionalProperties: false },
);

const Execute = Type.Object(
  {
    code: Type.String({
      description:
        "JavaScript body run in Executor's sandbox. Call app tools as `await tools.<app>.<tool>(input)` and `return` only what you need.",
      minLength: 1,
      maxLength: 65_536,
    }),
  },
  { additionalProperties: false },
);

const Resume = Type.Object(
  {
    executionId: Type.String({ description: "executionId from the paused execute result." }),
    action: Type.Union([Type.Literal("accept"), Type.Literal("decline"), Type.Literal("cancel")], {
      description: "The user's decision. Use accept only after the user approved in chat.",
    }),
    content: Type.Optional(
      Type.String({ description: "JSON-encoded form answers, when the pause asked for input." }),
    ),
    persist: Type.Optional(
      Type.String({ description: "One of interaction.meta.persist, when offered and chosen." }),
    ),
  },
  { additionalProperties: false },
);

/** Drop omitted optional keys so the server applies its own defaults. */
const defined = (input: Readonly<Record<string, string | undefined>>): ToolArguments =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );

export default function executor(pi: ExtensionAPI): void {
  const client = createExecutorClient({
    url: process.env.EXECUTOR_MCP_URL?.trim() || DEFAULT_URL,
    token: () => readToken(pi.exec.bind(pi)),
    fetch: (input, init) => fetch(input, init),
  });

  pi.on("session_shutdown", async () => {
    await client.close();
  });

  const run = async (
    name: string,
    args: Readonly<Record<string, string | undefined>>,
    signal: AbortSignal | undefined,
  ) => {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);

    const text = await client.callTool(
      name,
      defined(args),
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    );

    return { content: [{ type: "text" as const, text }], details: { tool: name } };
  };

  pi.registerTool({
    name: "executor_skills",
    label: "executor_skills",
    description:
      'Read Executor\'s own guides and app skills. No arguments lists them; { name: "execute" } is the guide for writing execute programs. Runs no code.',
    parameters: Skills,
    async execute(_toolCallId, params, signal) {
      return run("skills", params, signal);
    },
  });

  pi.registerTool({
    name: "executor_execute",
    label: "executor_execute",
    description:
      "Run a JavaScript program over the user's Executor apps (credentials stay in Executor). Discover first with `return await tools.search({ query })`. No fetch, imports or filesystem. May pause for approval; then relay the request and use executor_resume.",
    parameters: Execute,
    async execute(_toolCallId, params, signal) {
      return run("execute", params, signal);
    },
  });

  pi.registerTool({
    name: "executor_resume",
    label: "executor_resume",
    description:
      "Continue a paused executor_execute program with the user's explicit decision. Never accept on the user's behalf, and never rerun the program to get past a decline.",
    parameters: Resume,
    async execute(_toolCallId, params, signal) {
      return run("resume", params, signal);
    },
  });
}
