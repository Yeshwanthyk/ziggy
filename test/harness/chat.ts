/**
 * A fake Slack, Discord and Telegram API. Point a child at it with `env`; every post is recorded
 * with its gateway, path and JSON body, and answered the way the real API answers a success.
 */
interface ChatPost {
  readonly gateway: "slack" | "discord" | "telegram";
  readonly path: string;
  /** The decoded JSON body; compare with `toMatchObject`. */
  readonly body: unknown;
}

export interface ChatServer {
  /** `ZIGGY_*_API_URL` for a `ziggyWith` child. */
  readonly env: Readonly<Record<string, string>>;
  readonly posts: ReadonlyArray<ChatPost>;
  readonly stop: () => void;
}

const success = {
  slack: { ok: true, ts: "1700000000.000100" },
  discord: { id: "1" },
  telegram: { ok: true, result: { message_id: 1 } },
} as const;

export const startChatServer = (): ChatServer => {
  const posts: Array<ChatPost> = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const [, gateway, ...rest] = url.pathname.split("/");

      if (gateway !== "slack" && gateway !== "discord" && gateway !== "telegram")
        return new Response("unknown gateway", { status: 404 });

      const body: unknown = await request.json();
      posts.push({ gateway, path: `/${rest.join("/")}`, body });

      return Response.json(success[gateway]);
    },
  });

  const base = `http://127.0.0.1:${server.port}`;

  return {
    env: {
      ZIGGY_SLACK_API_URL: `${base}/slack`,
      ZIGGY_DISCORD_API_URL: `${base}/discord`,
      ZIGGY_TELEGRAM_API_URL: `${base}/telegram`,
    },
    posts,
    stop: () => void server.stop(true),
  };
};
