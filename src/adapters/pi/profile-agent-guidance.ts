import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ProfileAgent } from "../../domain/profile";

const agentPromptGuidance = (agents: ReadonlyArray<ProfileAgent>): string =>
  agents.length === 0
    ? "No Profile specialists are available. Do not attempt to call agent_run."
    : [
        "Profile specialist dispatch (model-guided):",
        "Use agent_run when one specialist clearly matches the user's task; use agent_discuss for a real multi-view question needing 2-4 perspectives; otherwise answer normally without delegation.",
        "Match the user's ask to a listed specialist and agent_run it; do not wait for @.",
        "agent_discuss is bounded and reasoning-only: use it for discussion, not research or edits. Research or edits remain separate single-agent agent_run work.",
        "A leading @agent-id is a selection hint, not a bypass of the core model: call agent_run for that named agent, then use its result to answer.",
        "Available agents:",
        ...agents.map((agent) => `- ${agent.id}: ${agent.description}`),
      ].join("\n");

export const createProfileAgentGuidanceExtension = (
  agents: ReadonlyArray<ProfileAgent>,
): InlineExtension => ({
  name: "ziggy-profile-agents",
  hidden: true,
  factory: (pi) => {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${agentPromptGuidance(agents)}`,
    }));
  },
});
