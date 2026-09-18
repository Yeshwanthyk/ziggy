import type {
  InlineExtension,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const normalizedName = (value: string, limit: number): string =>
  [
    ...value
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  ]
    .slice(0, limit)
    .join("");

const initialName = (
  entries: ReadonlyArray<SessionEntry>,
  semanticName: string | undefined,
  firstUserMessage: string,
): string | undefined => {
  if (entries.some((entry) => entry.type === "session_info")) return undefined;

  const semantic = normalizedName(semanticName ?? "", 40);
  const topic = normalizedName(firstUserMessage, 80);
  const name = normalizedName(semantic && topic ? `${semantic} · ${topic}` : semantic || topic, 80);

  return name.length > 0 ? name : undefined;
};

export const ensurePiSessionName = (
  manager: Pick<SessionManager, "appendSessionInfo" | "getEntries">,
  semanticName: string | undefined,
  firstUserMessage: string,
): void => {
  const name = initialName(manager.getEntries(), semanticName, firstUserMessage);

  if (name !== undefined) manager.appendSessionInfo(name);
};

export const createSessionNamingExtension = (): InlineExtension => ({
  name: "ziggy-session-name",
  hidden: true,
  factory: (pi) => {
    pi.on("before_agent_start", (event, context) => {
      const name = initialName(context.sessionManager.getEntries(), undefined, event.prompt);

      if (name !== undefined) pi.setSessionName(name);
    });
  },
});
