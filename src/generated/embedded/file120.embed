/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution is this package's required Promise adapter boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Pi requires thrown tool errors to mark failed executions. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Pi's tool boundary accepts Error failures, not Effect errors. */
/* oxlint-disable ziggy-effect/no-json-parse -- MCP wire boundary; every parsed message is checked against a TypeBox schema before use. */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const DEFAULT_URL = "http://127.0.0.1:4312/mcp";

/** The macOS Keychain item that holds the Executor personal access token. */
export const KEYCHAIN_SERVICE = "ziggy-executor";

const PROTOCOL_VERSION = "2025-06-18";

const OUTPUT_LIMIT = 32 * 1024;

/** Executor stops a program after five minutes; leave room for the response. */
const CALL_TIMEOUT_MS = 330_000;

const SETUP_HINT =
  "Start the local server (`executor serve`), then retry for a sign-in link; no API key is needed. EXECUTOR_API_KEY or the ziggy-executor Keychain item overrides OAuth for hosted or other setups.";

export const OAUTH_KEYCHAIN_SERVICE = "ziggy-executor-oauth";

const OAuthState = Type.Object({
  url: Type.String(),
  issuer: Type.String(),
  tokenEndpoint: Type.String(),
  clientId: Type.String(),
  redirectUri: Type.String(),
  refreshToken: Type.String(),
});

type OAuthState = Static<typeof OAuthState>;

type OAuthStore = {
  readonly read: () => Promise<OAuthState | undefined>;
  readonly write: (state: OAuthState) => Promise<void>;
  readonly clear: () => Promise<void>;
};

type CallbackReply = { readonly status: number; readonly html: string };

type Listener = { readonly redirectUri: string; readonly close: () => void };

type Listen = (
  callback: (method: string, url: string) => Promise<CallbackReply>,
) => Promise<Listener>;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

type ClientOptions = {
  readonly url: string;
  readonly token: () => Promise<string | undefined>;
  readonly fetch: Fetch;
  readonly oauthStore?: OAuthStore;
  readonly listen?: Listen;
};

/** Feed Keychain writes through stdin; credentials never become process arguments. */
const security = (args: readonly string[], input?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: ["pipe", "pipe", "ignore"], timeout: 10_000 });
    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => reject(new Error("Executor could not access Keychain.")));
    child.on("close", (code) => {
      if (code === 0 || (code === 44 && args[0] === "delete-generic-password"))
        resolve(stdout.trim());
      else reject(new Error("Executor could not access Keychain."));
    });
    child.stdin.on("error", () => {
      /* Process failure is reported by close. */
    });
    child.stdin.end(input);
  });

const createOAuthStore = (): OAuthStore => {
  let memory: OAuthState | undefined;

  return {
    async read() {
      if (process.platform !== "darwin") return memory;

      try {
        const encoded = await security([
          "find-generic-password",
          "-s",
          OAUTH_KEYCHAIN_SERVICE,
          "-w",
        ]);

        const state = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));

        return Check(OAuthState, state) ? state : undefined;
      } catch {
        return undefined;
      }
    },
    async write(state) {
      if (process.platform !== "darwin") {
        memory = state;

        return;
      }

      const encoded = Buffer.from(JSON.stringify(state)).toString("base64");

      await security(
        ["-i"],
        `add-generic-password -U -a executor -s ${OAUTH_KEYCHAIN_SERVICE} -w ${encoded}\n`,
      );

      // Interactive security can exit successfully after a failed command; verify the write.
      const persisted = await security([
        "find-generic-password",
        "-s",
        OAUTH_KEYCHAIN_SERVICE,
        "-w",
      ]);

      if (persisted !== encoded) throw new Error("Executor could not save its OAuth credentials.");
    },
    async clear() {
      memory = undefined;

      if (process.platform !== "darwin") return;

      await security(["delete-generic-password", "-a", "executor", "-s", OAUTH_KEYCHAIN_SERVICE]);
    },
  };
};

const LoopbackAddress = Type.Object({ port: Type.Number() });

const listenLoopback: Listen = (callback) =>
  new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const reply = await callback(request.method ?? "", request.url ?? "");

        response.writeHead(reply.status, { "content-type": "text/html; charset=utf-8" });
        response.end(reply.html);
      } catch {
        response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
        response.end("Executor sign-in failed. Ask Ziggy again.");
      }
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!Check(LoopbackAddress, address)) {
        server.close();
        reject(new Error("Executor could not start its sign-in listener."));

        return;
      }

      server.unref();
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        close: () => {
          server.close();
          server.closeIdleConnections();
        },
      });
    });
  });

const ProtectedResource = Type.Object({
  resource: Type.String(),
  authorization_servers: Type.Array(Type.String(), { minItems: 1 }),
});

const AuthorizationServer = Type.Object({
  issuer: Type.String(),
  authorization_endpoint: Type.String(),
  token_endpoint: Type.String(),
  registration_endpoint: Type.String(),
});

const Registration = Type.Object({ client_id: Type.String({ minLength: 1 }) });

const Tokens = Type.Object({
  access_token: Type.String({ minLength: 1 }),
  token_type: Type.String(),
  expires_in: Type.Number({ minimum: 0 }),
  refresh_token: Type.Optional(Type.String({ minLength: 1 })),
});

const OAuthError = Type.Object({ error: Type.String() });

/** Malformed OAuth responses must not expose credential bytes in parser errors. */
const oauthBody = async <Schema extends TSchema>(
  response: Response,
  schema: Schema,
): Promise<Static<Schema>> => {
  try {
    const body = await response.json();

    if (Check(schema, body)) return body;
  } catch {
    // Report only the boundary failure, never the response body.
  }

  throw new Error("Executor returned invalid OAuth metadata or credentials.");
};

/** OAuth owns one pending approval and one cached access token per Pi session. */
const createOAuth = (options: ClientOptions) => {
  const store = options.oauthStore ?? createOAuthStore();
  const listen = options.listen ?? listenLoopback;
  let state: OAuthState | undefined;
  let loaded = false;
  let access: { token: string; expires: number } | undefined;

  let pending:
    | { url: string; listener: Listener; timer: ReturnType<typeof setTimeout> }
    | undefined;

  let acquiring: Promise<string> | undefined;
  let stopped = false;

  const close = () => {
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.listener.close();
      pending = undefined;
    }
  };

  const signIn = async (): Promise<string> => {
    if (pending !== undefined) throw new Error(signInHint(pending.url));

    if (stopped) throw new Error("Executor session has shut down.");

    const probe = await options.fetch(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "ziggy-executor", version: "0.3.0" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const metadataUrl =
      /resource_metadata="([^"]+)"/.exec(probe.headers.get("www-authenticate") ?? "")?.[1] ??
      new URL("/.well-known/oauth-protected-resource", options.url).href;

    await probe.body?.cancel();

    const resourceResponse = await options.fetch(metadataUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });

    const resource = await oauthBody(resourceResponse, ProtectedResource);

    if (!resourceResponse.ok || resource.resource !== options.url)
      throw new Error(`Executor OAuth discovery failed. ${SETUP_HINT}`);

    const issuer = resource.authorization_servers[0];

    if (issuer === undefined) throw new Error("Executor advertised no OAuth issuer.");

    const issuerUrl = new URL(issuer);
    const metadataPath = `/.well-known/oauth-authorization-server${issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "")}`;

    let metadataResponse = await options.fetch(new URL(metadataPath, issuerUrl).href, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });

    if (
      metadataResponse.status === 404 &&
      metadataPath !== "/.well-known/oauth-authorization-server"
    ) {
      await metadataResponse.body?.cancel();
      metadataResponse = await options.fetch(
        new URL("/.well-known/oauth-authorization-server", issuerUrl).href,
        { method: "GET", signal: AbortSignal.timeout(10_000) },
      );
    }

    const metadata = await oauthBody(metadataResponse, AuthorizationServer);

    if (!metadataResponse.ok || metadata.issuer !== issuer)
      throw new Error("Executor OAuth issuer discovery failed.");

    const verifier = randomBytes(32).toString("base64url");
    const callbackState = randomBytes(32).toString("base64url");
    let consumed = false;
    let registration: OAuthState | undefined;

    const listener = await listen(async (method, callbackUrl) => {
      const query = new URL(callbackUrl, "http://127.0.0.1");
      const fail = (status: number, message: string): CallbackReply => ({ status, html: message });

      if (method !== "GET" || query.pathname !== "/callback")
        return fail(404, "Executor callback not found.");

      if (query.searchParams.get("state") !== callbackState)
        return fail(400, "Executor sign-in state did not match.");

      if (consumed || registration === undefined)
        return fail(409, "Executor callback already used or not ready.");

      consumed = true;

      try {
        if (query.searchParams.has("error") || !query.searchParams.get("code"))
          return fail(400, "Executor sign-in was not approved. Ask Ziggy again.");

        const code = query.searchParams.get("code");

        if (code === null) return fail(400, "Executor callback needs a code.");

        const tokens = await exchange(registration, {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: registration.redirectUri,
        });

        if (tokens === undefined || tokens.refresh_token === undefined)
          return fail(400, "Executor sign-in failed. Ask Ziggy again.");

        if (stopped || pending?.listener !== listener)
          return fail(400, "Executor sign-in expired. Ask Ziggy again.");

        const connected = { ...registration, refreshToken: tokens.refresh_token };

        await store.write(connected);

        if (stopped || pending?.listener !== listener)
          return fail(400, "Executor sign-in expired. Ask Ziggy again.");
        state = connected;
        cache(tokens);

        return {
          status: 200,
          html: "<!doctype html><title>Executor connected</title><p>Executor connected. You can return to Ziggy.</p>",
        };
      } catch {
        return fail(400, "Executor sign-in failed. Ask Ziggy again.");
      } finally {
        if (pending?.listener === listener) close();
      }
    });

    const timer = setTimeout(close, 10 * 60_000);

    timer.unref();
    pending = { url: "", listener, timer };

    try {
      if (stopped) throw new Error("Executor session has shut down.");

      const redirectUri = listener.redirectUri;
      let clientId = state?.redirectUri === redirectUri ? state.clientId : undefined;

      if (clientId === undefined) {
        const response = await options.fetch(new URL(metadata.registration_endpoint, issuer).href, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "Ziggy Executor",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            scope: "mcp offline_access",
          }),
          signal: AbortSignal.timeout(10_000),
        });

        const client = await oauthBody(response, Registration);

        if (!response.ok) throw new Error("Executor OAuth client registration failed.");
        clientId = client.client_id;
      }

      registration = {
        url: options.url,
        issuer,
        tokenEndpoint: new URL(metadata.token_endpoint, issuer).href,
        clientId,
        redirectUri,
        refreshToken: "",
      };
      const authorize = new URL(metadata.authorization_endpoint, issuer);

      authorize.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "mcp offline_access",
        resource: options.url,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: callbackState,
      }).toString();

      if (stopped || pending?.listener !== listener)
        throw new Error("Executor sign-in expired. Ask Ziggy again.");

      pending.url = authorize.href;
    } catch (error) {
      if (pending?.listener === listener) close();
      throw error;
    }

    throw new Error(signInHint(pending.url));
  };

  const cache = (tokens: Static<typeof Tokens>) => {
    access = { token: tokens.access_token, expires: Date.now() + tokens.expires_in * 1000 };
  };

  const exchange = async (credential: OAuthState, fields: Readonly<Record<string, string>>) => {
    const response = await options.fetch(credential.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...fields,
        client_id: credential.clientId,
        resource: options.url,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });

    const body = await oauthBody(response, Type.Union([Tokens, OAuthError]));

    if (!response.ok) {
      if (Check(OAuthError, body) && body.error === "invalid_grant") {
        await store.clear();
        state = undefined;
        access = undefined;

        return undefined;
      }

      throw new Error(
        `Executor OAuth token request failed (HTTP ${response.status}). Ask Ziggy again.`,
      );
    }

    if (!Check(Tokens, body) || body.token_type.toLowerCase() !== "bearer")
      throw new Error("Executor OAuth returned an invalid token response.");

    return body;
  };

  const acquire = async (force: boolean): Promise<string> => {
    if (!loaded) {
      state = await store.read();

      if (state?.url !== options.url) state = undefined;
      loaded = true;
    }

    if (!force && access !== undefined && access.expires > Date.now() + 30_000) return access.token;
    access = undefined;

    if (state !== undefined) {
      const credential = state;

      const tokens = await exchange(credential, {
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      });

      if (tokens !== undefined) {
        state = { ...credential, refreshToken: tokens.refresh_token ?? credential.refreshToken };

        if (tokens.refresh_token !== undefined) await store.write(state);
        cache(tokens);

        return tokens.access_token;
      }
    }

    return signIn();
  };

  return {
    token(force = false): Promise<string> {
      if (acquiring !== undefined) return acquiring;
      acquiring = acquire(force).finally(() => {
        acquiring = undefined;
      });

      return acquiring;
    },
    close() {
      stopped = true;
      close();
    },
  };
};

const signInHint = (url: string) =>
  `Executor needs you to sign in once. Open ${url} in your browser on this computer, approve, then ask me again.`;

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
  const oauth = createOAuth(options);

  const send = async (init: RequestInit) => {
    const staticToken = await options.token();

    const authenticated = (token: string) =>
      options.fetch(options.url, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          authorization: `Bearer ${token}`,
        },
      });

    let response = await authenticated(staticToken ?? (await oauth.token()));

    if (response.status === 401 && staticToken === undefined) {
      await response.body?.cancel();
      response = await authenticated(await oauth.token(true));
    }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new Error(
        `Executor refused the token (HTTP ${response.status}). It may be expired, revoked, or scoped to another organization. ${SETUP_HINT}`,
      );
    }

    return response;
  };

  const post = (message: JsonRpcRequest, signal: AbortSignal) => {
    const session =
      sessionId === undefined
        ? {}
        : { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION };

    return send({
      method: "POST",
      headers: {
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
        clientInfo: { name: "ziggy-executor", version: "0.3.0" },
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
    oauth.close();

    if (sessionId === undefined) return;

    const session = sessionId;

    sessionId = undefined;

    try {
      const response = await send({
        method: "DELETE",
        headers: { "mcp-session-id": session },
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
const readToken = async (exec: ExtensionAPI["exec"]): Promise<string | undefined> => {
  const fromEnv = process.env.EXECUTOR_API_KEY?.trim() ?? "";

  if (fromEnv.length > 0) return fromEnv;

  if (process.platform === "darwin") {
    const result = await exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      timeout: 10_000,
    });

    const token = result.stdout.trim();

    if (result.code === 0 && token.length > 0) return token;
  }

  return undefined;
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
