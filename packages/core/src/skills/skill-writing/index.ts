import skillWritingMarkdown from "./SKILL.md" with { type: "text" };
import { Effect, Schema } from "effect";

export const CORE_SKILL_WRITING_ID = "skill-writing";

class CoreSkillWritingLoadError extends Schema.TaggedErrorClass<CoreSkillWritingLoadError>()(
  "CoreSkillWritingLoadError",
  { message: Schema.String },
) {}

export const loadCoreSkillWriting = Effect.gen(function* () {
  const metadata = readFrontmatter(skillWritingMarkdown);
  if (
    metadata === undefined ||
    metadata.name !== CORE_SKILL_WRITING_ID ||
    metadata.description.length === 0
  ) {
    return yield* new CoreSkillWritingLoadError({
      message: "Baked-in skill-writing Skill has invalid identity or metadata",
    });
  }
  return {
    id: CORE_SKILL_WRITING_ID,
    description: metadata.description,
    content: skillWritingMarkdown,
  };
});

function readFrontmatter(
  content: string,
): { readonly name: string; readonly description: string } | undefined {
  const lines = content.split("\n");
  if (lines[0] !== "---") return undefined;
  const closing = lines.indexOf("---", 1);
  if (closing < 2) return undefined;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, closing)) {
    const separator = line.indexOf(":");
    if (separator < 1) return undefined;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0 || fields.has(key)) return undefined;
    fields.set(key, value);
  }
  if (fields.size !== 2) return undefined;
  const name = fields.get("name");
  const description = fields.get("description");
  return name === undefined || description === undefined ? undefined : { name, description };
}
