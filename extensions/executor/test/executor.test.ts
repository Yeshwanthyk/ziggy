/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests exercise the Pi Promise adapter boundary. */
/* oxlint-disable ziggy-effect/no-json-parse -- The fake server decodes request bodies with a TypeBox Parse. */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { createExecutorClient } from "../index.ts";

const Request = Type.Object({ id: Type.Optional(Type.Number()), method: Type.String() });

type ToolResult = {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
};

type Seen = { method: string; session: string | null; auth: string | null };

const sse = (message: { readonly id: number | undefined; readonly result: ToolResult }) =>
  new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", ...message })}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });

/** A fake Executor MCP endpoint that issues session ids and answers tools/call over SSE. */
const fakeServer = (options: { forgetFirstSession?: boolean; toolResult?: ToolResult } = {}) => {
  const seen: Seen[] = [];
  let sessions = 0;
  let forget = options.forgetFirstSession === true;

  const fetch = async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const body = Parse(Request, JSON.parse(String(init.body)));

    seen.push({
      method: body.method,
      session: headers.get("mcp-session-id"),
      auth: headers.get("authorization"),
    });

    if (body.method === "initialize") {
      sessions += 1;

      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        headers: { "content-type": "application/json", "mcp-session-id": `s${sessions}` },
      });
    }

    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });

    if (forget) {
      forget = false;

      return new Response("unknown session", { status: 404 });
    }

    return sse({
      id: body.id,
      result: options.toolResult ?? { content: [{ type: "text", text: "ok" }] },
    });
  };

  return { seen, fetch };
};

const client = (server: ReturnType<typeof fakeServer>) =>
  createExecutorClient({
    url: "https://executor.test/mcp",
    token: async () => "pat",
    fetch: server.fetch,
  });

describe("Executor MCP client", () => {
  test("keeps one session across calls so a paused execution can be resumed", async () => {
    const server = fakeServer();
    const executor = client(server);

    expect(
      await executor.callTool("execute", { code: "return 1" }, new AbortController().signal),
    ).toBe("ok");
    expect(
      await executor.callTool(
        "resume",
        { executionId: "e1", action: "accept" },
        new AbortController().signal,
      ),
    ).toBe("ok");

    expect(server.seen.map((call) => [call.method, call.session])).toEqual([
      ["initialize", null],
      ["notifications/initialized", "s1"],
      ["tools/call", "s1"],
      ["tools/call", "s1"],
    ]);
    expect(server.seen.every((call) => call.auth === "Bearer pat")).toBe(true);
  });

  test("starts a new session once when the server forgot the old one", async () => {
    const server = fakeServer({ forgetFirstSession: true });

    expect(await client(server).callTool("skills", {}, new AbortController().signal)).toBe("ok");
    expect(
      server.seen.filter((call) => call.method === "tools/call").map((call) => call.session),
    ).toEqual(["s1", "s2"]);
  });

  test("turns an MCP tool error into a failed tool call", async () => {
    const server = fakeServer({
      toolResult: { isError: true, content: [{ type: "text", text: "denied by approval" }] },
    });

    expect(
      client(server).callTool("execute", { code: "x" }, new AbortController().signal),
    ).rejects.toThrow("denied by approval");
  });
});

type Options = Parameters<typeof createExecutorClient>[0];

type Store = NonNullable<Options["oauthStore"]>;

type State = NonNullable<Awaited<ReturnType<Store["read"]>>>;

type Listen = NonNullable<Options["listen"]>;

const MCP_URL = "http://executor.test/mcp";

const ISSUER = "http://executor.test/api/auth";

const savedState: State = {
  url: MCP_URL,
  issuer: ISSUER,
  tokenEndpoint: `${ISSUER}/oauth2/token`,
  clientId: "client-1",
  redirectUri: "http://127.0.0.1:12345/callback",
  refreshToken: "refresh-old",
};

/** OAuth and MCP share an injected fetch; no listener, browser or Keychain is opened. */
const oauthServer = (
  options: {
    saved?: State;
    rejectAccessOnce?: boolean;
    rejectAccessAlways?: boolean;
    invalidGrant?: boolean;
    shortLivedFirstToken?: boolean;
  } = {},
) => {
  const mcp = fakeServer();
  const exchanges: URLSearchParams[] = [];
  const writes: State[] = [];
  const attempted: { method: string; auth: string | null }[] = [];
  let stored = options.saved;
  let clears = 0;
  let registrations = 0;
  let listeners = 0;
  let closed = 0;
  let rejectAccess = options.rejectAccessOnce === true;
  let invalidGrant = options.invalidGrant === true;
  let callback: Parameters<Listen>[0] = async () => ({ status: 404, html: "not listening" });

  const store: Store = {
    read: async () => stored,
    async write(state) {
      stored = state;
      writes.push(state);
    },
    async clear() {
      stored = undefined;
      clears += 1;
    },
  };

  const listen: Listen = async (handler) => {
    listeners += 1;
    callback = handler;

    return {
      redirectUri: savedState.redirectUri,
      close: () => {
        closed += 1;
      },
    };
  };

  const json = (
    body: Readonly<Record<string, string | number | readonly string[]>>,
    status = 200,
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetch = async (url: string, init: RequestInit) => {
    if (url === MCP_URL) {
      const headers = new Headers(init.headers);

      if (!headers.has("authorization"))
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="http://executor.test/.well-known/oauth-protected-resource/mcp?elicitation_mode=model", scope="mcp offline_access"',
          },
        });

      if (init.method === "DELETE") return new Response(null, { status: 204 });

      const request = Parse(Request, JSON.parse(String(init.body)));

      attempted.push({ method: request.method, auth: headers.get("authorization") });

      if (
        request.method === "tools/call" &&
        (rejectAccess || options.rejectAccessAlways === true)
      ) {
        rejectAccess = false;

        return new Response(null, { status: 401 });
      }

      return mcp.fetch(url, init);
    }

    if (url.includes("oauth-protected-resource"))
      return json({ resource: MCP_URL, authorization_servers: [ISSUER] });

    if (url.endsWith("oauth-authorization-server/api/auth"))
      return new Response(null, { status: 404 });

    if (url.endsWith("oauth-authorization-server"))
      return json({
        issuer: ISSUER,
        authorization_endpoint: "/api/auth/oauth2/authorize",
        token_endpoint: "/api/auth/oauth2/token",
        registration_endpoint: "/api/auth/oauth2/register",
      });

    if (url.endsWith("/register")) {
      registrations += 1;

      return json({ client_id: "client-1" });
    }

    if (url.endsWith("/token")) {
      exchanges.push(new URLSearchParams(String(init.body)));

      if (invalidGrant) {
        invalidGrant = false;

        return json({ error: "invalid_grant" }, 400);
      }

      return json({
        access_token: `access-${exchanges.length}`,
        token_type: "Bearer",
        expires_in: options.shortLivedFirstToken === true && exchanges.length === 1 ? 20 : 3600,
        refresh_token: `refresh-${exchanges.length}`,
      });
    }

    return new Response(null, { status: 404 });
  };

  const executor = createExecutorClient({
    url: MCP_URL,
    token: async () => undefined,
    fetch,
    oauthStore: store,
    listen,
  });

  return {
    executor,
    exchanges,
    writes,
    mcp,
    attempted,
    callback: (method: string, url: string) => callback(method, url),
    counts: () => ({ clears, registrations, listeners, closed }),
  };
};

const signInUrl = async (executor: ReturnType<typeof createExecutorClient>) => {
  const message = await executor.callTool("skills", {}, new AbortController().signal).then(
    () => "unexpected success",
    (error) => Parse(Type.Object({ message: Type.String() }), error).message,
  );

  const link = /Open (\S+) in your browser/.exec(message)?.[1];

  expect(link).toBeDefined();

  return new URL(link ?? "http://missing.test");
};

const callbackUrl = (authorize: URL, state = authorize.searchParams.get("state") ?? "") =>
  `/callback?${new URLSearchParams({ state, code: "code-for-test" })}`;

describe("Executor OAuth", () => {
  test("rejects wrong state and non-callback requests without consuming the approval", async () => {
    const server = oauthServer();
    const authorize = await signInUrl(server.executor);

    expect(
      await server.callback("GET", callbackUrl(authorize, '<script>alert("x")</script>')),
    ).toEqual({ status: 400, html: "Executor sign-in state did not match." });
    expect((await server.callback("POST", callbackUrl(authorize))).status).toBe(404);
    expect((await server.callback("GET", "/other")).status).toBe(404);
    expect(server.exchanges).toHaveLength(0);
    expect(server.counts().closed).toBe(0);
    expect((await server.callback("GET", callbackUrl(authorize))).status).toBe(200);
    expect((await server.callback("GET", callbackUrl(authorize))).status).toBe(409);
    expect(server.exchanges).toHaveLength(1);
    expect(server.counts().closed).toBe(1);
    await server.executor.close();
  });

  test("exchanges the code with the matching PKCE verifier and resource", async () => {
    const server = oauthServer();
    const authorize = await signInUrl(server.executor);

    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe(MCP_URL);
    expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await server.callback("GET", callbackUrl(authorize))).status).toBe(200);

    const exchange = server.exchanges[0];
    const verifier = exchange?.get("code_verifier") ?? "";
    const digest = createHash("sha256").update(verifier).digest("base64url");

    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digest).toBe(authorize.searchParams.get("code_challenge") ?? "");
    expect(exchange?.get("resource")).toBe(MCP_URL);
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("code")).toBe("code-for-test");
    expect(exchange?.get("redirect_uri")).toBe(savedState.redirectUri);
    expect(exchange?.get("client_id")).toBe("client-1");
    expect(server.writes[0]?.refreshToken).toBe("refresh-1");
    expect(await server.executor.callTool("skills", {}, new AbortController().signal)).toBe("ok");
    expect(server.exchanges).toHaveLength(1);
    await server.executor.close();
  });

  test("keeps one sign-in URL for concurrent and subsequent calls and closes on shutdown", async () => {
    const server = oauthServer();
    const links = await Promise.all([signInUrl(server.executor), signInUrl(server.executor)]);

    expect(links[0]?.href).toBe(links[1]?.href);
    expect((await signInUrl(server.executor)).href).toBe(links[0]?.href);
    expect(server.counts()).toEqual({ clears: 0, registrations: 1, listeners: 1, closed: 0 });
    await server.executor.close();
    expect(server.counts().closed).toBe(1);
  });

  test("refreshes once on a 401, retries, and persists the rotated refresh token", async () => {
    const server = oauthServer({ saved: savedState, rejectAccessOnce: true });

    expect(await server.executor.callTool("skills", {}, new AbortController().signal)).toBe("ok");
    expect(
      server.exchanges.map((body) => [
        body.get("grant_type"),
        body.get("refresh_token"),
        body.get("resource"),
      ]),
    ).toEqual([
      ["refresh_token", "refresh-old", MCP_URL],
      ["refresh_token", "refresh-1", MCP_URL],
    ]);
    expect(server.writes.map((state) => state.refreshToken)).toEqual(["refresh-1", "refresh-2"]);
    expect(server.mcp.seen.at(-1)?.auth).toBe("Bearer access-2");
    expect(server.counts().listeners).toBe(0);
    await server.executor.close();
  });

  test("clears invalid_grant state and starts sign-in again", async () => {
    const server = oauthServer({ saved: savedState, invalidGrant: true });

    await signInUrl(server.executor);
    expect(server.counts()).toEqual({ clears: 1, registrations: 1, listeners: 1, closed: 0 });
    expect(server.writes).toHaveLength(0);
    await server.executor.close();
  });

  test("gives up after one refresh when the retry is also unauthorized", async () => {
    const server = oauthServer({ saved: savedState, rejectAccessAlways: true });

    await expect(
      server.executor.callTool("skills", {}, new AbortController().signal),
    ).rejects.toThrow("Executor refused the token (HTTP 401)");
    expect(server.exchanges).toHaveLength(2);
    expect(
      server.attempted
        .filter((request) => request.method === "tools/call")
        .map((request) => request.auth),
    ).toEqual(["Bearer access-1", "Bearer access-2"]);
    await server.executor.close();
  });

  test("refreshes shortly before expiry even without a 401", async () => {
    const server = oauthServer({ saved: savedState, shortLivedFirstToken: true });

    expect(await server.executor.callTool("skills", {}, new AbortController().signal)).toBe("ok");
    expect(server.exchanges).toHaveLength(2);
    expect(server.attempted.map((request) => request.auth)).toEqual([
      "Bearer access-1",
      "Bearer access-2",
      "Bearer access-2",
    ]);
    await server.executor.close();
  });

  test("a rejected approval closes the listener and echoes no query values", async () => {
    const server = oauthServer();
    const authorize = await signInUrl(server.executor);

    const query = new URLSearchParams({
      state: authorize.searchParams.get("state") ?? "",
      error: '<script>alert("x")</script>',
    });

    expect(await server.callback("GET", `/callback?${query}`)).toEqual({
      status: 400,
      html: "Executor sign-in was not approved. Ask Ziggy again.",
    });
    expect(server.exchanges).toHaveLength(0);
    expect(server.counts().closed).toBe(1);
    expect((await signInUrl(server.executor)).href).not.toBe(authorize.href);
    await server.executor.close();
  });

  test("static credentials override saved OAuth without reading its store", async () => {
    const mcp = fakeServer();

    const executor = createExecutorClient({
      url: MCP_URL,
      token: async () => "static",
      fetch: mcp.fetch,
      oauthStore: {
        read: async () => {
          expect.unreachable("static auth read OAuth state");
        },
        write: async () => {
          expect.unreachable("static auth wrote OAuth state");
        },
        clear: async () => {
          expect.unreachable("static auth cleared OAuth state");
        },
      },
    });

    expect(await executor.callTool("skills", {}, new AbortController().signal)).toBe("ok");
    expect(mcp.seen.every((call) => call.auth === "Bearer static")).toBe(true);
  });
});
