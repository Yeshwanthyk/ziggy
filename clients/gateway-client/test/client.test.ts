import { describe, expect, test } from "bun:test";
import {
  connectZiggy,
  ZiggyGatewayError,
  type ZiggyGatewayEvent,
  type ZiggySocket,
} from "../src/index";

type Listener = (event: never) => void;

class FakeSocket implements ZiggySocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(name: string, listener: (event: never) => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", new CloseEvent("close"));
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  message(value: unknown): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  private emit(name: string, event: Event): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event as never);
  }
}

const frame = (socket: FakeSocket, index: number) =>
  JSON.parse(socket.sent[index] ?? "null") as {
    readonly id: string;
    readonly method: string;
    readonly params: unknown;
  };

const waitFor = async (check: () => boolean): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 500) throw new Error("condition timed out");
    await Bun.sleep(1);
  }
};

describe("gateway client", () => {
  test("matches concurrent responses by id and includes the auth token", async () => {
    const sockets: FakeSocket[] = [];
    const client = connectZiggy({
      url: "ws://127.0.0.1:1234/ws?source=test",
      token: "secret token",
      socketFactory: (url) => {
        expect(url).toContain("source=test&token=secret+token");
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const socket = sockets[0] as FakeSocket;
    const ping = client.request("ping", {});
    const list = client.request("session.list", {});
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(socket.sent).toHaveLength(2);

    const first = frame(socket, 0);
    const second = frame(socket, 1);
    socket.message({ id: second.id, ok: true, result: { live: [], stored: [] } });
    socket.message({ id: first.id, ok: true, result: { pong: true } });

    expect(await ping).toEqual({ pong: true });
    expect(await list).toEqual({ live: [], stored: [] });
    client.close();
  });

  test("dispatches named and catch-all gateway events", () => {
    const socket = new FakeSocket();
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      socketFactory: () => socket,
    });
    const named: string[] = [];
    const all: ZiggyGatewayEvent[] = [];
    client.on("assistant-text", (event) => named.push(event.payload.snapshot));
    client.onAny((event) => all.push(event));
    socket.open();
    socket.message({ event: "settled", session: "ui/main", payload: [] });
    socket.message({ event: "assistant-text", session: "ui/main", payload: {} });
    socket.message({
      event: "assistant-text",
      session: "ui/main",
      payload: { delta: "hi", snapshot: "hi" },
    });

    expect(named).toEqual(["hi"]);
    expect(all.map((event) => event.event)).toEqual(["connection-state", "assistant-text"]);
    client.close();
  });

  test("supports extension operations through typed client methods", async () => {
    const socket = new FakeSocket();
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      socketFactory: () => socket,
    });
    socket.open();

    const listing = client.listExtensionsForProfile();
    const added = client.addExtension("weather");
    const removed = client.removeExtension("weather");
    const validation = client.validateExtensions();

    expect(socket.sent.map((value) => JSON.parse(value).method)).toEqual([
      "extension.list-for-profile",
      "extension.add",
      "extension.remove",
      "extension.validate",
    ]);
    expect(socket.sent.map((value) => JSON.parse(value).params)).toEqual([
      {},
      { id: "weather" },
      { id: "weather" },
      {},
    ]);

    socket.message({
      id: frame(socket, 0).id,
      ok: true,
      result: {
        available: [{ id: "weather", description: "Weather", kind: "skill", source: "bundled" }],
        selected: ["weather"],
      },
    });
    socket.message({
      id: frame(socket, 1).id,
      ok: true,
      result: { id: "weather", profilePath: "/profile", changed: true, selected: true },
    });
    socket.message({
      id: frame(socket, 2).id,
      ok: true,
      result: { id: "weather", profilePath: "/profile", changed: true, selected: false },
    });
    socket.message({
      id: frame(socket, 3).id,
      ok: true,
      result: {
        selected: ["weather"],
        preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
      },
    });

    expect(await listing).toEqual({
      available: [{ id: "weather", description: "Weather", kind: "skill", source: "bundled" }],
      selected: ["weather"],
    });
    expect(await added).toEqual({
      id: "weather",
      profilePath: "/profile",
      changed: true,
      selected: true,
    });
    expect(await removed).toEqual({
      id: "weather",
      profilePath: "/profile",
      changed: true,
      selected: false,
    });
    expect(await validation).toEqual({
      selected: ["weather"],
      preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
    });
    client.close();
  });

  test("preserves bounded structured extension rejection details", async () => {
    const socket = new FakeSocket();
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      socketFactory: () => socket,
    });
    socket.open();
    const request = client.addExtension("weather");
    const message = "x".repeat(360);
    socket.message({
      id: frame(socket, 0).id,
      ok: false,
      error: {
        code: "internal",
        message: "could not add Profile extensions",
        details: {
          operation: "add",
          stage: "extensions",
          code: "preflight_failed",
          message,
          id: "weather",
          source: "profile",
          selectionChanged: false,
        },
      },
    });

    await expect(request).rejects.toBeInstanceOf(ZiggyGatewayError);
    await expect(request).rejects.toMatchObject({
      code: "internal",
      message: "could not add Profile extensions",
      details: {
        operation: "add",
        stage: "extensions",
        code: "preflight_failed",
        message,
        id: "weather",
        source: "profile",
        selectionChanged: false,
      },
    });
    client.close();
  });

  test("keeps legacy gateway rejection handling when details are not structured", async () => {
    const socket = new FakeSocket();
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      socketFactory: () => socket,
    });
    socket.open();
    const request = client.request("extension.validate", {});
    socket.message({
      id: frame(socket, 0).id,
      ok: false,
      error: {
        code: "internal",
        message: "validation failed",
        details: { operation: "validate", selectionChanged: false },
      },
    });

    await expect(request).rejects.toMatchObject({
      code: "internal",
      message: "validation failed",
      details: undefined,
    });
    client.close();
  });

  test("rejects malformed results before they reach typed callers", async () => {
    const socket = new FakeSocket();
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      socketFactory: () => socket,
    });
    socket.open();
    const list = client.request("session.list", {});
    socket.message({ id: frame(socket, 0).id, ok: true, result: {} });
    await expect(list).rejects.toThrow("Invalid Ziggy gateway response for session.list");
    client.close();
  });

  test("reconnects and restores successful watches", async () => {
    const sockets: FakeSocket[] = [];
    const states: string[] = [];
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    client.on("connection-state", (event) => states.push(event.payload.state));
    const first = sockets[0] as FakeSocket;
    first.open();
    const watch = client.request("session.watch", { session: "slack/channel" });
    const watchFrame = frame(first, 0);
    first.message({ id: watchFrame.id, ok: true, result: {} });
    await watch;
    first.close();

    await waitFor(() => sockets.length === 2);
    const second = sockets[1] as FakeSocket;
    second.open();
    await waitFor(() => second.sent.length === 1);
    expect(frame(second, 0)).toMatchObject({
      method: "session.watch",
      params: { session: "slack/channel" },
    });
    expect(states).toEqual(["open", "reconnecting", "open"]);
    client.close();
  });

  test("rejects requests that exceed their timeout", async () => {
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      requestTimeoutMs: 5,
      socketFactory: () => new FakeSocket(),
    });
    await expect(client.request("ping", {})).rejects.toThrow(
      "Ziggy gateway request timed out: ping",
    );
    client.close();
  });
});
