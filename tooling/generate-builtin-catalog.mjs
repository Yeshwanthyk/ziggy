#!/usr/bin/env bun
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- catalog generator is a Bun CLI, not an Effect service */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- catalog generator is a Bun CLI, not an Effect service */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath = join(repositoryRoot, "src/generated/builtin-catalog-metadata.ts");
const resourcesPath = join(repositoryRoot, "src/adapters/pi/generated/builtin-resources.ts");
const catalogJsonPath = join(repositoryRoot, "catalog.json");

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const skipNames = new Set(["node_modules", ".git", "test", "tests", "tsconfig.json"]);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const posix = (value) => value.split(sep).join("/");

const isSorted = (values) =>
  values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) <= 0);

const readJson = (path) => Bun.file(path).json();

const parseFrontmatter = (text) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return undefined;
  const fields = new Map(
    (match[1] ?? "")
      .split(/\r?\n/)
      .map((line) => /^([a-zA-Z]+):\s*(.*)$/.exec(line))
      .flatMap((entry) => (entry === null ? [] : [[entry[1], entry[2]]])),
  );
  const scalar = (value) => {
    const trimmed = value?.trim();
    return trimmed !== undefined &&
      trimmed.length >= 2 &&
      ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed;
  };
  const name = scalar(fields.get("name"));
  const description = scalar(fields.get("description"));
  const disable = scalar(
    fields.get("disableModelInvocation") ?? fields.get("disable-model-invocation"),
  );
  if (name === undefined || description === undefined) return undefined;
  return {
    name,
    description,
    disableModelInvocation: disable === "true",
  };
};

const walkFiles = (root) => {
  const status = lstatSync(root);
  if (status.isSymbolicLink()) fail(`catalog generator rejected symlink: ${root}`);
  if (status.isFile()) return [root];
  if (!status.isDirectory()) fail(`catalog generator rejected special file: ${root}`);
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (
      skipNames.has(entry.name) ||
      entry.name.endsWith(".test.ts") ||
      entry.name.startsWith(".")
    ) {
      return [];
    }
    return walkFiles(join(root, entry.name));
  });
};

const contain = (packagePath, declared) => {
  const resolved = resolve(packagePath, declared);
  const physicalPackage = realpathSync(packagePath);
  const physical = realpathSync(resolved);
  if (physical !== physicalPackage && !physical.startsWith(`${physicalPackage}${sep}`)) {
    fail(`declared path escapes package: ${declared}`);
  }
  return physical;
};

const skillFiles = (declaredPath) => {
  const status = lstatSync(declaredPath);
  if (status.isSymbolicLink()) fail(`catalog generator rejected symlink: ${declaredPath}`);
  if (status.isFile()) {
    return posix(basenameSkill(declaredPath)) === "SKILL.md" ? [declaredPath] : [];
  }
  return readdirSync(declaredPath, { withFileTypes: true }).flatMap((entry) => {
    const child = join(declaredPath, entry.name);
    if (entry.isDirectory()) {
      const skillFile = join(child, "SKILL.md");
      try {
        const skillStatus = lstatSync(skillFile);
        return skillStatus.isFile() && !skillStatus.isSymbolicLink() ? [skillFile] : [];
      } catch {
        return [];
      }
    }
    return [];
  });
};

const basenameSkill = (path) => path.split(sep).at(-1) ?? path;

const importAlias = (kind, id, index) =>
  `${kind}${id
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("")}${index === 0 ? "" : String(index)}`;

const catalogJson = await readJson(catalogJsonPath);
const approvedIds = catalogJson.extensions.map((entry) => entry.id);
if (!isSorted(approvedIds) || new Set(approvedIds).size !== approvedIds.length) {
  fail("catalog.json IDs must be unique and sorted");
}

const packages = [];
for (const id of approvedIds) {
  const packagePath = join(repositoryRoot, "extensions", id);
  const manifestPath = join(packagePath, "package.json");
  const packageStatus = lstatSync(packagePath);
  if (!packageStatus.isDirectory() || packageStatus.isSymbolicLink()) {
    fail(`extension '${id}' is not a physical shelf directory`);
  }
  const manifest = await readJson(manifestPath);
  if (!ID.test(id) || manifest.name !== `@ziggy/${id}`) {
    fail(`extension manifest name must be '@ziggy/${id}'`);
  }
  const declaredExtensions = [...(manifest.pi?.extensions ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
  const declaredSkills = [...(manifest.pi?.skills ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
  const declaredAutomations = [...(manifest.ziggy?.automations ?? [])].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (new Set(declaredAutomations.map((item) => item.id)).size !== declaredAutomations.length) {
    fail(`extension '${id}' declares duplicate automation IDs`);
  }
  const extensionPaths = declaredExtensions.map((declared) => contain(packagePath, declared));
  const skillRoots = declaredSkills.map((declared) => contain(packagePath, declared));
  const automations = declaredAutomations.map((declared) => ({
    id: declared.id,
    path: contain(packagePath, declared.path),
    logicalPath: posix(relative(repositoryRoot, contain(packagePath, declared.path))),
  }));
  const skills = skillRoots.flatMap((root) =>
    skillFiles(root).map((filePath) => {
      const metadata = parseFrontmatter(readFileSync(filePath, "utf8"));
      if (metadata === undefined) fail(`invalid skill frontmatter: ${filePath}`);
      const skillDir = dirname(filePath);
      const files = walkFiles(skillDir)
        .map((path) => posix(relative(repositoryRoot, path)))
        .sort((left, right) => left.localeCompare(right));
      return {
        ...metadata,
        filePath,
        logicalPath: posix(relative(repositoryRoot, filePath)),
        baseDirLogicalPath: posix(relative(repositoryRoot, skillDir)),
        files,
      };
    }),
  );
  skills.sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length) {
    fail(`extension '${id}' declares duplicate skill names`);
  }
  const description = (manifest.description?.trim() || skills[0]?.description)
    ?.replace(/\s+/g, " ")
    .trim();
  if (description === undefined) fail(`extension '${id}' has no description`);
  const hasSkills = skills.length > 0;
  const hasCode = extensionPaths.length > 0;
  if (!hasSkills && !hasCode) fail(`extension '${id}' declares no Pi resources`);
  const sourcePath = posix(relative(repositoryRoot, packagePath));
  const packageFiles = walkFiles(packagePath)
    .map((path) => posix(relative(repositoryRoot, path)))
    .sort((left, right) => left.localeCompare(right));
  if (!packageFiles.includes(`${sourcePath}/package.json`)) {
    fail(`extension '${id}' is missing package.json in the package tree`);
  }
  packages.push({
    id,
    version: manifest.version ?? "0.1.0",
    description,
    kind: hasSkills && hasCode ? "skill+code" : hasSkills ? "skill" : "code",
    required: id === "pi-packages",
    sourcePath,
    packageFiles,
    extensionLogicalPaths: extensionPaths.map((path) => posix(relative(repositoryRoot, path))),
    skills,
    automations,
  });
}

const authoringPath = join(repositoryRoot, "skills/extension-authoring/SKILL.md");
const authoringMeta = parseFrontmatter(readFileSync(authoringPath, "utf8"));
if (authoringMeta === undefined) fail("invalid extension-authoring skill");
const operationsPath = join(repositoryRoot, "skills/ziggy-operations/SKILL.md");
const operationsMeta = parseFrontmatter(readFileSync(operationsPath, "utf8"));
if (operationsMeta === undefined) fail("invalid ziggy-operations skill");

const extraSkills = [
  {
    id: "extension-authoring",
    ...authoringMeta,
    logicalPath: "skills/extension-authoring/SKILL.md",
    baseDirLogicalPath: "skills/extension-authoring",
    files: walkFiles(dirname(authoringPath))
      .map((path) => posix(relative(repositoryRoot, path)))
      .sort((left, right) => left.localeCompare(right)),
    required: true,
  },
  {
    id: "ziggy-operations",
    ...operationsMeta,
    logicalPath: "skills/ziggy-operations/SKILL.md",
    baseDirLogicalPath: "skills/ziggy-operations",
    files: walkFiles(dirname(operationsPath))
      .map((path) => posix(relative(repositoryRoot, path)))
      .sort((left, right) => left.localeCompare(right)),
    required: true,
  },
];

const skillsRoot = join(repositoryRoot, "skills");
const leftoverSkillDirs = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !extraSkills.some((skill) => skill.id === name))
  .sort((left, right) => left.localeCompare(right));
if (leftoverSkillDirs.length > 0) {
  fail(`repository skills/ contains leftover dirs: ${leftoverSkillDirs.join(", ")}`);
}

const fingerprintSource = JSON.stringify({
  packages: packages.map((item) => ({
    id: item.id,
    version: item.version,
    description: item.description,
    kind: item.kind,
    required: item.required,
    sourcePath: item.sourcePath,
    packageFiles: item.packageFiles,
    extensionLogicalPaths: item.extensionLogicalPaths,
    skills: item.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      logicalPath: skill.logicalPath,
      files: skill.files,
      disableModelInvocation: skill.disableModelInvocation,
    })),
    automations: item.automations.map((automation) => ({
      id: automation.id,
      logicalPath: automation.logicalPath,
    })),
  })),
  extraSkills: extraSkills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    logicalPath: skill.logicalPath,
    files: skill.files,
  })),
});
const fingerprint = createHash("sha256").update(fingerprintSource).digest("hex");

const filesPath = join(repositoryRoot, "src/generated/builtin-files.ts");
const embeddedRoot = join(repositoryRoot, "src/generated/embedded");
const fileImports = [];
const factoryImports = [];
const skillAlias = new Map();
const factoryAlias = new Map();
const embedBytes = new Map();
let fileIndex = 0;
const registerEmbed = (file) => {
  if (skillAlias.has(file)) return;
  const alias = importAlias("file", `${fileIndex}`, 0);
  fileIndex += 1;
  skillAlias.set(file, alias);
  embedBytes.set(`${alias}.embed`, readFileSync(join(repositoryRoot, file)));
  fileImports.push(`import ${alias} from "./embedded/${alias}.embed" with { type: "file" };`);
};
for (const pkg of packages) {
  for (const [index, logicalPath] of pkg.extensionLogicalPaths.entries()) {
    const alias = importAlias("factory", pkg.id, index);
    factoryAlias.set(`${pkg.id}:${logicalPath}`, alias);
    factoryImports.push(`import ${alias} from "../../../../${logicalPath}";`);
  }
  for (const file of pkg.packageFiles) registerEmbed(file);
}
for (const skill of extraSkills) {
  for (const file of skill.files) registerEmbed(file);
}

const quote = (value) => JSON.stringify(value);

const metadataSource = `// Generated by tooling/generate-builtin-catalog.mjs. Do not edit.

export const BUILTIN_CATALOG_FINGERPRINT = ${quote(fingerprint)};

export const BUILTIN_PACKAGE_METADATA = [
${packages
  .map(
    (pkg) => `  {
    id: ${quote(pkg.id)},
    version: ${quote(pkg.version)},
    description: ${quote(pkg.description)},
    kind: ${quote(pkg.kind)},
    required: ${pkg.required ? "true" : "false"},
    sourcePath: ${quote(pkg.sourcePath)},
    packageFiles: [${pkg.packageFiles.map(quote).join(", ")}],
    executables: [${pkg.extensionLogicalPaths.map(quote).join(", ")}],
    skills: [
${pkg.skills
  .map(
    (skill) => `      {
        name: ${quote(skill.name)},
        description: ${quote(skill.description)},
        logicalPath: ${quote(skill.logicalPath)},
        disableModelInvocation: ${skill.disableModelInvocation ? "true" : "false"},
        files: [${skill.files.map(quote).join(", ")}],
      }`,
  )
  .join(",\n")}
    ],
    automations: [
${pkg.automations
  .map(
    (automation) =>
      `      { id: ${quote(automation.id)}, logicalPath: ${quote(automation.logicalPath)} }`,
  )
  .join(",\n")}
    ],
  }`,
  )
  .join(",\n")}
] as const;

export const BUILTIN_CORE_SKILLS = [
${extraSkills
  .map(
    (skill) => `  {
    id: ${quote(skill.id)},
    name: ${quote(skill.name)},
    description: ${quote(skill.description)},
    logicalPath: ${quote(skill.logicalPath)},
    disableModelInvocation: ${skill.disableModelInvocation ? "true" : "false"},
    files: [${skill.files.map(quote).join(", ")}],
  }`,
  )
  .join(",\n")}
] as const;

export const APPROVED_BUNDLED_EXTENSION_IDS: ReadonlySet<string> = new Set(
  BUILTIN_PACKAGE_METADATA.map((entry) => entry.id),
);
`;

const sortedFileEntries = [...skillAlias.entries()].sort((left, right) =>
  left[0].localeCompare(right[0]),
);

const filesSource = `// Generated by tooling/generate-builtin-catalog.mjs. Do not edit.
${fileImports.join("\n")}

export const builtinFilePath = {
${sortedFileEntries.map(([file, alias]) => `  ${quote(file)}: ${alias},`).join("\n")}
} as const;

const bundledFiles = new Map<string, string>([
${sortedFileEntries.map(([file, alias]) => `  [${quote(file)}, ${alias}],`).join("\n")}
]);

export const bundledFilePath = (logicalPath: string): string | undefined =>
  bundledFiles.get(logicalPath);
`;

const resourcesSource = `// Generated by tooling/generate-builtin-catalog.mjs. Do not edit.
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
${factoryImports.join("\n")}

export const builtinFactories: ReadonlyArray<{
  readonly id: string;
  readonly factory: ExtensionFactory;
}> = [
${packages
  .flatMap((pkg) =>
    pkg.extensionLogicalPaths.map((logicalPath) => {
      const alias = factoryAlias.get(`${pkg.id}:${logicalPath}`);
      return `  { id: ${quote(pkg.id)}, factory: ${alias} },`;
    }),
  )
  .join("\n")}
];
`;

const writeIfNeeded = async (path, contents) => {
  const current = Bun.file(path);
  if ((await current.exists()) && (await current.text()) === contents) return false;
  if (process.argv.includes("--check")) fail(`generated catalog is stale: ${path}`);
  await Bun.write(path, contents);
  return true;
};

const syncEmbeds = (check) => {
  mkdirSync(embeddedRoot, { recursive: true });
  const existing = new Set(readdirSync(embeddedRoot));
  const expected = new Set(embedBytes.keys());
  for (const name of existing) {
    if (expected.has(name)) continue;
    if (check) fail(`generated builtin catalog is stale: extra ${join(embeddedRoot, name)}`);
    rmSync(join(embeddedRoot, name));
  }
  for (const [name, bytes] of embedBytes) {
    const path = join(embeddedRoot, name);
    if (check) {
      if (!existing.has(name) || Buffer.compare(readFileSync(path), bytes) !== 0) {
        fail(`generated builtin catalog is stale: ${path}`);
      }
      continue;
    }
    writeFileSync(path, bytes);
  }
};

const outputs = [
  [metadataPath, metadataSource],
  [filesPath, filesSource],
  [resourcesPath, resourcesSource],
];

if (process.argv.includes("--check")) {
  for (const [path, contents] of outputs) {
    const current = Bun.file(path);
    if (!(await current.exists()) || (await current.text()) !== contents) {
      fail(`generated builtin catalog is stale: ${path}`);
    }
  }
  syncEmbeds(true);
  console.log(`builtin catalog fingerprint ${fingerprint}`);
  process.exit(0);
}

for (const [path, contents] of outputs) {
  await writeIfNeeded(path, contents);
}
syncEmbeds(false);
console.log(`wrote builtin catalog fingerprint ${fingerprint}`);
