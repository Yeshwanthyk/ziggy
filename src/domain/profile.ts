import * as path from "node:path";
import { Schema } from "effect";

export interface ProfileResolutionOptions {
  readonly cwd: string;
  readonly homedir: string;
  readonly ziggyHome?: string | undefined;
}

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

export class ProfileSkillInvalid extends Schema.TaggedErrorClass<ProfileSkillInvalid>()(
  "ProfileSkillInvalid",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class ProfileSkillNotFound extends Schema.TaggedErrorClass<ProfileSkillNotFound>()(
  "ProfileSkillNotFound",
  {
    source: Schema.String,
    message: Schema.String,
  },
) {}

export class ProfileSkillExists extends Schema.TaggedErrorClass<ProfileSkillExists>()(
  "ProfileSkillExists",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

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

export const resolveZiggyHome = (options: ProfileResolutionOptions): string =>
  path.resolve(options.cwd, options.ziggyHome ?? path.join(options.homedir, ".ziggy"));

export const resolveProfilesDirectory = (options: ProfileResolutionOptions): string =>
  path.join(resolveZiggyHome(options), "profiles");

export const resolveProfilesRegistry = (options: ProfileResolutionOptions): string =>
  path.join(resolveZiggyHome(options), "profiles.list");

export const resolveProfileTarget = (
  value: string,
  options: ProfileResolutionOptions,
): ProfileTarget => {
  const targetPath = hasPathSyntax(value)
    ? path.resolve(options.cwd, expandLeadingTilde(value, options.homedir))
    : path.join(resolveProfilesDirectory(options), value);
  const basename = path.basename(targetPath);

  return {
    path: targetPath,
    name: basename.length === 0 ? basename : basename.charAt(0).toUpperCase() + basename.slice(1),
  };
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
