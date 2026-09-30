import { Schema } from "effect";

export class ProfileExtensionInvalid extends Schema.TaggedErrorClass<ProfileExtensionInvalid>()(
  "ProfileExtensionInvalid",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.UndefinedOr(Schema.Defect()),
  },
) {}

export class ProfileAgentInvalid extends Schema.TaggedErrorClass<ProfileAgentInvalid>()(
  "ProfileAgentInvalid",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.UndefinedOr(Schema.Defect()),
  },
) {}

export class ProfileAgentEditConflict extends Schema.TaggedErrorClass<ProfileAgentEditConflict>()(
  "ProfileAgentEditConflict",
  {
    id: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class ProfileAgentMentionInvalid extends Schema.TaggedErrorClass<ProfileAgentMentionInvalid>()(
  "ProfileAgentMentionInvalid",
  {
    profilePath: Schema.String,
    message: Schema.String,
  },
) {}

export const ProfileAgentId = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));

export const ProfileAgentThinking = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ProfileAgentThinking = typeof ProfileAgentThinking.Type;

export const ProfileAgent = Schema.Struct({
  id: ProfileAgentId,
  version: Schema.Literal(1),
  description: Schema.NonEmptyString,
  provider: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.optionalKey(Schema.NonEmptyString),
  thinking: Schema.optionalKey(ProfileAgentThinking),
  tools: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  body: Schema.NonEmptyString,
}).pipe(
  Schema.check(
    Schema.makeFilter((agent) => (agent.provider === undefined) === (agent.model === undefined), {
      expected: "provider and model must be provided together",
    }),
  ),
);

export type ProfileAgent = typeof ProfileAgent.Type;

export type LeadingProfileAgentMention =
  | { readonly kind: "untagged" }
  | { readonly kind: "tagged"; readonly agentId: string; readonly task: string }
  | { readonly kind: "invalid"; readonly message: string };

const profileAgentIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Apply the one leading @agent-id policy shared by chat and automation bodies. */
export const parseLeadingProfileAgentMention = (text: string): LeadingProfileAgentMention => {
  if (!text.startsWith("@")) return { kind: "untagged" };
  const tokenEnd = text.search(/\s/u);
  const token = (tokenEnd === -1 ? text : text.slice(0, tokenEnd)).slice(1);

  if (!profileAgentIdPattern.test(token)) {
    return {
      kind: "invalid",
      message: "a leading Profile agent mention must use lowercase kebab-case @agent-id",
    };
  }

  const task = text.slice(tokenEnd === -1 ? text.length : tokenEnd).trim();

  if (task.length === 0) {
    return {
      kind: "invalid",
      message: "a leading Profile agent mention must be followed by a non-empty task",
    };
  }

  return { kind: "tagged", agentId: token, task };
};

export type PreparedProfileAgentPrompt =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

/** Validate and prepare the one leading mention policy used by every conversational face. */
export const prepareProfileAgentPrompt = (
  text: string,
  agents: ReadonlyArray<ProfileAgent>,
): PreparedProfileAgentPrompt => {
  const mention = parseLeadingProfileAgentMention(text);

  if (mention.kind === "untagged") return { ok: true, text };

  if (mention.kind === "invalid") return { ok: false, message: mention.message };
  const agent = agents.find((candidate) => candidate.id === mention.agentId);

  if (agent === undefined) {
    return { ok: false, message: `unknown Profile agent: ${mention.agentId}` };
  }

  return {
    ok: true,
    text: `${text}\n\n[Ziggy dispatch guidance: call agent_run for the named agent "${agent.id}" with the user's task, then use the result to answer. This is model-guided; @ syntax does not bypass the core model.]`,
  };
};
