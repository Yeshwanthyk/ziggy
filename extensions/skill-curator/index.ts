/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution is this package's required Promise and filesystem boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- The Pi boundary validates filesystem input and reports stable tool failures. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Pi's tool boundary accepts Error failures, not Effect errors. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

const MAX_SKILL_BYTES = 64 * 1024;
const MAX_LIST_RESULTS = 200;
const SKILL_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

const SkillName = Type.String({
  description: "Profile skill directory name.",
  maxLength: 64,
  minLength: 1,
  pattern: SKILL_NAME_PATTERN,
});

const SkillFrontmatter = Type.Object(
  {
    name: SkillName,
    description: Type.String({ maxLength: 1024, minLength: 1 }),
  },
  { additionalProperties: true },
);

const NodeError = Type.Object(
  { code: Type.Optional(Type.String()) },
  { additionalProperties: true },
);

const NameParameters = Type.Object({ name: SkillName }, { additionalProperties: false });

const WriteParameters = Type.Object(
  {
    name: SkillName,
    body: Type.String({
      description: "Complete SKILL.md content, including Agent Skill YAML frontmatter.",
      maxLength: MAX_SKILL_BYTES,
      minLength: 1,
    }),
    replace: Type.Optional(
      Type.Boolean({
        description: "Set true to replace an existing Profile SKILL.md.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ProfileSkill = {
  readonly name: string;
  readonly description: string;
};

const errorCode = (cause: unknown): string | undefined =>
  Check(NodeError, cause) ? cause.code : undefined;

const skillFilePath = (profilePath: string, name: string): string =>
  join(profilePath, "skills", name, "SKILL.md");

type SkillDirectory = {
  readonly path: string;
  readonly realPath: string;
};

const assertContained = (root: string, candidate: string): void => {
  const remainder = relative(root, candidate);
  if (
    remainder === ".." ||
    remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(remainder)
  ) {
    throw new Error("Profile skill path escapes the Profile");
  }
};

const checkedDirectory = async (
  directoryPath: string,
  containmentRoot: string,
): Promise<SkillDirectory> => {
  const metadata = await lstat(directoryPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Profile skill path must be a regular directory: ${directoryPath}`);
  }
  const canonicalPath = await realpath(directoryPath);
  assertContained(containmentRoot, canonicalPath);
  return { path: directoryPath, realPath: canonicalPath };
};

const checkedSkillsRoot = async (
  profilePath: string,
  create: boolean,
): Promise<SkillDirectory | undefined> => {
  const profileRoot = await realpath(profilePath);
  const skillsPath = join(profilePath, "skills");
  if (create) {
    try {
      await mkdir(skillsPath);
    } catch (cause: unknown) {
      if (errorCode(cause) !== "EEXIST") throw cause;
    }
  }
  try {
    return await checkedDirectory(skillsPath, profileRoot);
  } catch (cause: unknown) {
    if (!create && errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  }
};

const checkedSkillDirectory = async (
  profilePath: string,
  name: string,
  create: boolean,
): Promise<SkillDirectory | undefined> => {
  const skillsRoot = await checkedSkillsRoot(profilePath, create);
  if (skillsRoot === undefined) return undefined;
  const skillPath = join(skillsRoot.path, name);
  if (create) {
    try {
      await mkdir(skillPath);
    } catch (cause: unknown) {
      if (errorCode(cause) !== "EEXIST") throw cause;
    }
  }
  try {
    return await checkedDirectory(skillPath, skillsRoot.realPath);
  } catch (cause: unknown) {
    if (!create && errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  }
};

const validateSkillName = (name: string): void => {
  if (!Check(SkillName, name)) {
    throw new Error(
      "Profile skill name must be 1-64 lowercase letters, numbers, or single hyphens",
    );
  }
};

const readBoundedText = async (filePath: string): Promise<string> => {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Profile SKILL.md must be a regular file: ${filePath}`);
  }
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SKILL_BYTES) {
      throw new Error(`SKILL.md exceeds the ${MAX_SKILL_BYTES}-byte read limit`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
};

export const validateProfileSkillBody = (name: string, body: string): ProfileSkill => {
  validateSkillName(name);
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BYTES) {
    throw new Error(`SKILL.md exceeds the ${MAX_SKILL_BYTES}-byte write limit`);
  }
  const { frontmatter } = parseFrontmatter(body);
  if (!Check(SkillFrontmatter, frontmatter)) {
    throw new Error(
      "SKILL.md requires valid Agent Skill frontmatter with a kebab-case name and nonempty description",
    );
  }
  if (frontmatter.name !== name) {
    throw new Error(
      `SKILL.md frontmatter name "${frontmatter.name}" does not match Profile skill "${name}"`,
    );
  }
  if (frontmatter.description.trim().length === 0) {
    throw new Error("SKILL.md frontmatter description must be nonempty");
  }
  return { name: frontmatter.name, description: frontmatter.description };
};

export const readProfileSkill = async (
  profilePath: string,
  name: string,
): Promise<{ readonly skill: ProfileSkill; readonly body: string }> => {
  validateSkillName(name);
  const skillDirectory = await checkedSkillDirectory(profilePath, name, false);
  if (skillDirectory === undefined) {
    throw new Error(`Profile skill "${name}" does not exist`);
  }
  const targetPath = skillFilePath(profilePath, name);
  const canonicalTarget = await realpath(targetPath);
  assertContained(skillDirectory.realPath, canonicalTarget);
  const body = await readBoundedText(targetPath);
  return { skill: validateProfileSkillBody(name, body), body };
};

export const listProfileSkills = async (
  profilePath: string,
): Promise<ReadonlyArray<ProfileSkill>> => {
  const skillsRoot = await checkedSkillsRoot(profilePath, false);
  if (skillsRoot === undefined) return [];
  const entries = await readdir(skillsRoot.path, { withFileTypes: true });

  const skills: ProfileSkill[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!Check(SkillName, entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const { skill } = await readProfileSkill(profilePath, entry.name);
      skills.push(skill);
      if (skills.length === MAX_LIST_RESULTS) break;
    } catch {
      // Listing exposes only valid direct Profile skills.
    }
  }
  return skills;
};

const profileSkillExists = async (targetPath: string): Promise<boolean> => {
  try {
    const metadata = await lstat(targetPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Profile SKILL.md must be a regular file: ${targetPath}`);
    }
    return true;
  } catch (cause: unknown) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const atomicWrite = async (
  targetPath: string,
  body: string,
  replace: boolean,
  verifyParent: () => Promise<SkillDirectory | undefined>,
): Promise<void> => {
  const temporaryPath = join(dirname(targetPath), `.${randomUUID()}.skill-curator.tmp`);
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryFile = await open(temporaryPath, "wx");
    await temporaryFile.writeFile(body, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    const parent = await verifyParent();
    if (parent === undefined) {
      throw new Error("Profile skill directory disappeared during write");
    }
    assertContained(parent.realPath, await realpath(temporaryPath));
    if (replace) {
      await rename(temporaryPath, targetPath);
    } else {
      await link(temporaryPath, targetPath);
      try {
        await rm(temporaryPath);
      } catch {
        // The target is already published; a stale temporary link must not turn success into failure.
      }
    }
  } catch (cause: unknown) {
    if (temporaryFile !== undefined) {
      try {
        await temporaryFile.close();
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw cause;
  }
};

export const writeProfileSkill = async (
  profilePath: string,
  name: string,
  body: string,
  replace = false,
): Promise<{ readonly name: string; readonly action: "created" | "replaced" }> => {
  validateProfileSkillBody(name, body);
  const skillDirectory = await checkedSkillDirectory(profilePath, name, true);
  if (skillDirectory === undefined) {
    throw new Error("Profile skill directory could not be created");
  }
  const targetPath = skillFilePath(profilePath, name);
  const exists = replace ? await profileSkillExists(targetPath) : false;

  try {
    await atomicWrite(targetPath, body, replace, () =>
      checkedSkillDirectory(profilePath, name, false),
    );
  } catch (cause: unknown) {
    if (!replace && errorCode(cause) === "EEXIST") {
      throw new Error(`Profile skill "${name}" already exists; set replace:true to replace it`);
    }
    throw cause;
  }
  return { name, action: exists ? "replaced" : "created" };
};

const jsonResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export default function skillCurator(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "skill_curator_list",
    label: "skill_curator_list",
    description: "List valid skills directly beneath the current Profile's skills directory.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
      return jsonResult({ skills: await listProfileSkills(ctx.cwd) });
    },
  });

  pi.registerTool({
    name: "skill_curator_read",
    label: "skill_curator_read",
    description: "Read one valid named SKILL.md from the current Profile's skills directory.",
    parameters: NameParameters,
    executionMode: "sequential",
    async execute(_toolCallId, { name }, _signal, _onUpdate, ctx) {
      return jsonResult(await readProfileSkill(ctx.cwd, name));
    },
  });

  pi.registerTool({
    name: "skill_curator_write",
    label: "skill_curator_write",
    description:
      "Atomically create or explicitly replace one complete SKILL.md beneath the current Profile's skills directory.",
    parameters: WriteParameters,
    executionMode: "sequential",
    async execute(_toolCallId, { name, body, replace }, _signal, _onUpdate, ctx) {
      return jsonResult(await writeProfileSkill(ctx.cwd, name, body, replace ?? false));
    },
  });
}
