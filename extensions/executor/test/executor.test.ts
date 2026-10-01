/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests exercise the Pi Promise adapter boundary. */
/* oxlint-disable ziggy-effect/no-json-parse -- The fake server decodes request bodies with a TypeBox Parse. */
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
