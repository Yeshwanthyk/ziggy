/* oxlint-disable ziggy-effect/no-raw-fetch -- this test substitutes the Discord adapter's required global fetch boundary */
import { expect, test } from "bun:test";
import { openDiscordSocket } from "./socket";

test("invalid Discord credentials fail startup instead of reconnecting forever", async () => {
  const originalFetch = globalThis.fetch;
  const unauthorizedFetch: typeof globalThis.fetch = Object.assign(
    (_input: string | URL | Request, _init?: BunFetchRequestInit) =>
      Promise.resolve(new Response("", { status: 401 })),
    { preconnect: (_url: string | URL) => undefined },
  );
  globalThis.fetch = unauthorizedFetch;

  const socket = openDiscordSocket("invalid-token", 0);
  try {
    await expect(socket.next()).rejects.toMatchObject({
      name: "DiscordSocketError",
      reason: "authentication failed (HTTP 401)",
    });
  } finally {
    await socket.close();
    globalThis.fetch = originalFetch;
  }
});
