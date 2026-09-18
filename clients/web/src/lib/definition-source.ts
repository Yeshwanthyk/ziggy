export const automationFieldKeys = [
  "version",
  "owner",
  "cron",
  "timezone",
  "gate",
  "broadcast",
  "origin",
  "provider",
  "model",
  "thinking",
] as const;

export const agentFieldKeys = [
  "version",
  "description",
  "provider",
  "model",
  "thinking",
  "tools",
] as const;

type AutomationFieldKey = (typeof automationFieldKeys)[number];
type AgentFieldKey = (typeof agentFieldKeys)[number];
export type DefinitionFieldKey = AutomationFieldKey | AgentFieldKey;
export type DefinitionFields = Readonly<Record<DefinitionFieldKey, string>>;

export interface ParsedDefinitionSource {
  readonly fields: DefinitionFields;
  readonly structured: boolean;
  readonly task: string;
}

const emptyFields = (): Record<DefinitionFieldKey, string> => ({
  version: "",
  owner: "",
  cron: "",
  timezone: "",
  gate: "",
  broadcast: "",
  origin: "",
  provider: "",
  model: "",
  thinking: "",
  description: "",
  tools: "",
});

const isDefinitionFieldKey = (
  value: string,
  fieldKeys: ReadonlyArray<DefinitionFieldKey>,
): value is DefinitionFieldKey => fieldKeys.some((key) => key === value);

export const parseDefinitionSource = (
  source: string,
  fieldKeys: ReadonlyArray<DefinitionFieldKey> = automationFieldKeys,
): ParsedDefinitionSource => {
  const normalized = source.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) return { fields: emptyFields(), structured: false, task: source };
  const fields = emptyFields();
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (!isDefinitionFieldKey(key, fieldKeys)) continue;
    const raw = line.slice(separator + 1);
    fields[key] = raw.startsWith(" ") ? raw.slice(1) : raw;
  }
  return {
    fields,
    structured: true,
    task: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
};

export const updateDefinitionSource = (
  original: string,
  fields: DefinitionFields,
  task: string,
  fieldKeys: ReadonlyArray<DefinitionFieldKey> = automationFieldKeys,
): string => {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.replaceAll("\r\n", "\n").split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) return original;
  const seen = new Set<DefinitionFieldKey>();
  const frontmatter = lines.slice(1, end).flatMap((line): string[] => {
    const separator = line.indexOf(":");
    if (separator <= 0) return [line];
    const key = line.slice(0, separator);
    if (!isDefinitionFieldKey(key, fieldKeys)) return [line];
    seen.add(key);
    const value = fields[key].trim();
    if (value.length === 0 && key !== "version") return [];
    const originalRaw = line.slice(separator + 1);
    const originalValue = originalRaw.startsWith(" ") ? originalRaw.slice(1) : originalRaw;
    return value === originalValue ? [line] : [`${key}: ${value}`];
  });
  for (const key of fieldKeys) {
    const value = fields[key].trim();
    if (!seen.has(key) && value.length > 0) frontmatter.push(`${key}: ${value}`);
  }
  return ["---", ...frontmatter, "---", "", task.trim(), ""].join(newline);
};

export const addAutomationBroadcastTarget = (source: string, target: string): string => {
  const parsed = parseDefinitionSource(source);
  if (!parsed.structured) return source;
  const current = parsed.fields.broadcast.trim();
  const targets = current.length === 0 || current === "none" ? [] : current.split(",");
  const broadcast = targets.includes(target) ? targets.join(",") : [...targets, target].join(",");
  return updateDefinitionSource(source, { ...parsed.fields, broadcast }, parsed.task);
};

export const removeAutomationBroadcastTarget = (source: string, target: string): string => {
  const parsed = parseDefinitionSource(source);
  if (!parsed.structured) return source;
  const targets = parsed.fields.broadcast
    .trim()
    .split(",")
    .filter((candidate) => candidate.length > 0 && candidate !== "none" && candidate !== target);
  return updateDefinitionSource(
    source,
    { ...parsed.fields, broadcast: targets.length === 0 ? "none" : targets.join(",") },
    parsed.task,
  );
};
