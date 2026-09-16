import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { isZiggyHelpTopic, renderZiggyHelp, ziggyHelpTopics } from "../../domain/cli-help";

const helpTopicSchema = Type.String({ enum: ziggyHelpTopics });

export const ziggyHelpParameters = Type.Object(
  { topic: Type.Optional(helpTopicSchema) },
  { additionalProperties: false },
);

export type ZiggyHelpInput = Static<typeof ziggyHelpParameters>;

export const createZiggyHelpTool = (): ToolDefinition<typeof ziggyHelpParameters> => ({
  name: "ziggy_help",
  label: "ziggy_help",
  description:
    "Read version-matched Ziggy CLI help from the same authority as `ziggy help`. Omit topic for the command index or pass one listed topic for exact usage.",
  promptSnippet: "Version-matched Ziggy CLI help lookup.",
  promptGuidelines: ["Use ziggy_help before guessing Ziggy CLI commands or flags."],
  parameters: ziggyHelpParameters,
  execute(_toolCallId, params) {
    const topic =
      params.topic === undefined || isZiggyHelpTopic(params.topic) ? params.topic : undefined;

    return Promise.resolve({
      content: [{ type: "text" as const, text: renderZiggyHelp(topic) }],
      details: undefined,
    });
  },
});

export const createZiggyHelpExtension = (): InlineExtension => ({
  name: "ziggy_help",
  hidden: true,
  factory: (pi) => {
    pi.registerTool(createZiggyHelpTool());
  },
});
