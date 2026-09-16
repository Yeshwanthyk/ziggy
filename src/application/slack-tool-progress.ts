import type { ChatProgressEvent } from "./agent";

type ToolProgress = Extract<ChatProgressEvent, { kind: "tool" }>;

export const slackTaskTitle = (toolName: string, detail?: string): string => {
  if (toolName === "bash") {
    const command = detail?.trim() ?? "";

    if (/^(?:bun|npm|pnpm|yarn) (?:run )?test\b|^(?:pytest|cargo test|go test)\b/u.test(command))
      return "Running tests";

    if (/^(?:bun|npm|pnpm|yarn) (?:run )?(?:typecheck|check|lint|fmt|format)\b/u.test(command))
      return "Checking code";

    if (/^(?:bun|npm|pnpm|yarn) (?:run )?build\b|^cargo build\b/u.test(command))
      return "Building the project";

    if (/^git (?:status|diff|log|show)\b/u.test(command)) return "Inspecting Git changes";

    if (/^(?:rg|grep|find|fd)\b/u.test(command)) return "Searching files";

    if (/^(?:ls|pwd|tree)\b/u.test(command)) return "Exploring files";

    return "Running a command";
  }

  if (toolName === "read") return "Reading a file";

  if (toolName === "write") return "Writing a file";

  if (toolName === "edit") return "Editing a file";

  if (["grep", "find", "rg"].includes(toolName)) return "Searching files";

  if (toolName === "ls") return "Exploring files";

  if (toolName === "agent_run" || toolName === "bridge_worker") return "Consulting a specialist";

  if (toolName === "agent_discuss") return "Gathering specialist perspectives";

  if (toolName.startsWith("apple_reminders")) return "Checking reminders";

  if (toolName === "memory_write") return "Updating memory";

  return `Using ${toolName}`;
};

export const slackToolStatus = (event: Pick<ToolProgress, "toolName" | "detail">): string => {
  const title = slackTaskTitle(event.toolName, event.detail);
  // Reuse only the adapter's bounded detail projection, never raw tool arguments or output.
  const detail = event.detail?.replace(/\s+/gu, " ").trim();

  return detail ? `${title}: ${[...detail].slice(0, 120).join("")}…` : `${title}…`;
};
