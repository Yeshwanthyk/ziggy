import * as path from "node:path";
import { Schema } from "effect";
import type { ZiggyPathsApi } from "../platform/paths";

export interface ProfileTarget {
  readonly path: string;
  readonly name: string;
}

export class ProfileTargetNotDirectory extends Schema.TaggedErrorClass<ProfileTargetNotDirectory>()(
  "ProfileTargetNotDirectory",
  {
    path: Schema.String,
  },
) {}

export class ProfileFileSystemError extends Schema.TaggedErrorClass<ProfileFileSystemError>()(
  "ProfileFileSystemError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    code: Schema.UndefinedOr(Schema.String),
    cause: Schema.Defect(),
  },
) {}

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

const hasPathSyntax = (value: string): boolean =>
  value.includes("/") ||
  value.includes("\\") ||
  value.startsWith(".") ||
  value.startsWith("~") ||
  value.startsWith("/");

const expandLeadingTilde = (value: string, homedir: string): string => {
  if (value.startsWith("~")) {
    return path.join(homedir, value.slice(1));
  }

  return value;
};

/** Resolve a CLI Profile argument: a path, or a name under `profilesDirectory`. */
export const resolveProfileTarget = (
  value: string,
  paths: Pick<ZiggyPathsApi, "cwd" | "homedir" | "profilesDirectory">,
): ProfileTarget => {
  const targetPath = hasPathSyntax(value)
    ? path.resolve(paths.cwd, expandLeadingTilde(value, paths.homedir))
    : path.join(paths.profilesDirectory, value);

  const basename = path.basename(targetPath);

  return {
    path: targetPath,
    name: basename.length === 0 ? basename : basename.charAt(0).toUpperCase() + basename.slice(1),
  };
};

/**
 * The shortest CLI argument that resolves back to `profilePath`: the folder name when the
 * Profile lives directly under `profilesDirectory`, otherwise the absolute path. Round-trip
 * invariant: `resolveProfileTarget(profileCliTarget(p, dir), paths).path === p` whenever
 * `dir === paths.profilesDirectory` and `p` is absolute.
 */
export const profileCliTarget = (profilePath: string, profilesDirectory: string): string => {
  const name = path.basename(profilePath);

  return name.length > 0 &&
    !hasPathSyntax(name) &&
    path.join(profilesDirectory, name) === profilePath
    ? name
    : profilePath;
};

export const soulTemplate = (name: string): string => `# ${name}

You are ${name}. You live in this folder — it is your whole world: your soul, memory,
sessions, and skills are all plain files here.

## Voice

Warm, direct, brief. No filler, no corporate tone.

## Behavior

- Help with whatever your person brings you. Act when intent is clear; ask when it isn't.
- Remember what matters: durable facts go to memory, not the transcript.
- Never invent facts about people. If it isn't in memory or the conversation, say so.

Shape this file however you like — it is yours.
`;
