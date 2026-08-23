/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-promise-catch, ziggy-effect/no-json-parse, ziggy/no-unknown-parameters -- Test-only native stdio JSON-RPC fixture. */
export {};

const decoder = new TextDecoder();
const marker = process.env.MCP_MARKER;
const mode = process.env.MCP_MODE;

const mark = async (event: string) => {
  if (marker === undefined) return;
  await Bun.write(
    marker,
    `${await Bun.file(marker)
      .text()
      .catch(() => "")}${event}\n`,
  );
};

await mark(`start:${process.pid}`);

if (mode === "ignore-term") {
  process.on("SIGTERM", () => {
    void mark(`term-ignored:${process.pid}`);
  });
}

if (process.env.MCP_DESCENDANT === "1") {
  await new Promise(() => undefined);
}

if (mode === "ignore-term" || mode === "descendant-ignore-term") {
  Bun.spawn([process.execPath, import.meta.path], {
    env: { MCP_MODE: "ignore-term", MCP_MARKER: marker ?? "", MCP_DESCENDANT: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

const send = (message: unknown) => Bun.write(Bun.stdout, `${JSON.stringify(message)}\n`);
const tools = [
  {
    name: "echo",
    description: "Echo plain input for composition tests.",
    inputSchema: { type: "object" },
  },
  { name: "slow", description: "Wait until cancelled.", inputSchema: { type: "object" } },
  { name: "fail", description: "Return an MCP isError result.", inputSchema: { type: "object" } },
  {
    name: "secretStatus",
    description: "Report whether the host supplied a credential without returning it.",
    inputSchema: { type: "object" },
  },
];

let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  while (true) {
    const newline = buffered.indexOf("\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (process.env.MCP_MODE === "malformed") {
        await Bun.write(Bun.stdout, "not-json\n");
        continue;
      }
      await send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        },
      });
      continue;
    }
    if (message.method === "tools/list") {
      if (process.env.MCP_MODE === "repeat-cursor") {
        await send({ jsonrpc: "2.0", id: message.id, result: { tools: [], nextCursor: "same" } });
      } else if (process.env.MCP_MODE === "duplicate") {
        await send({ jsonrpc: "2.0", id: message.id, result: { tools: [tools[0], tools[0]] } });
      } else {
        await send({ jsonrpc: "2.0", id: message.id, result: { tools } });
      }
      continue;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      if (name === "slow") {
        setTimeout(() => {
          void send({ jsonrpc: "2.0", id: message.id, result: { content: [] } });
        }, 1_000);
      } else if (name === "fail") {
        await send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "fixture failure" }], isError: true },
        });
      } else if (name === "secretStatus") {
        await send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [],
            structuredContent: { present: process.env.CODEMODE_SECRET !== undefined },
          },
        });
      } else {
        await send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [], structuredContent: message.params?.arguments ?? null },
        });
      }
      continue;
    }
    if (message.method === "notifications/cancelled") await mark("cancelled");
  }
}

await mark("exit");
