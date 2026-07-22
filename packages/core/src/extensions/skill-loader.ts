import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Effect, Schema } from "effect";
import {
  readInstalledExtensionManifests,
  type InstalledExtensionManifestFile,
} from "../provider-node-adapter.ts";
import { decodeExtensionManifestJson, type ExtensionManifest } from "./manifest.ts";
import {
  decodeExtensionProvenanceJson,
  type ExtensionProvenance,
  type ExtensionProvenanceFile,
} from "./provenance.ts";
import {
  decodeUriComponentMaybe,
  decodeUtf8Maybe,
  readExtensionAuthorityFiles,
  readImmutableExtensionTree,
  type ExtensionFileSnapshot,
  type ExtensionTreeSnapshot,
} from "./skill-loader-node-adapter.ts";
import { decodeExtensionEnabledStateJson } from "./state.ts";
import { isZiggyVersionCompatible } from "./semver.ts";

export interface LoadedExtensionSkill {
  readonly extensionId: string;
  readonly id: string;
  readonly content: string;
}

export class ExtensionSkillLoadError extends Schema.TaggedErrorClass<ExtensionSkillLoadError>()(
  "ExtensionSkillLoadError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export function loadInstalledExtensionSkills(
  profilePath: string,
  runningZiggyVersion: string,
): Effect.Effect<ReadonlyArray<LoadedExtensionSkill>, ExtensionSkillLoadError> {
  return Effect.gen(function* () {
    const manifestFiles = yield* Effect.tryPromise({
      try: () => readInstalledExtensionManifests(profilePath),
      catch: loadFailure("Failed to discover installed Extensions"),
    });
    const loaded = yield* Effect.forEach(manifestFiles, (file) =>
      loadExtensionSkills(profilePath, file, runningZiggyVersion),
    );
    return loaded.flat();
  });
}

function loadExtensionSkills(
  profilePath: string,
  file: InstalledExtensionManifestFile,
  runningZiggyVersion: string,
): Effect.Effect<ReadonlyArray<LoadedExtensionSkill>, ExtensionSkillLoadError> {
  return Effect.gen(function* () {
    const manifestText = decodeUtf8Maybe(file.contents);
    if (manifestText === undefined) return yield* fail("Extension manifest is not valid UTF-8");
    const manifest = yield* decodeExtensionManifestJson(manifestText).pipe(
      Effect.mapError(loadFailure("Failed to decode installed Extension manifest")),
    );
    if (file.directoryName !== manifest.id) {
      return yield* fail(`Extension directory basename must match manifest id ${manifest.id}`);
    }
    if (!isZiggyVersionCompatible(manifest.ziggy.requires, runningZiggyVersion)) {
      return yield* fail(
        `Extension ${manifest.id} requires Ziggy ${manifest.ziggy.requires}; running ${runningZiggyVersion}`,
      );
    }

    const authority = yield* Effect.tryPromise({
      try: () => readExtensionAuthorityFiles(profilePath, manifest.id),
      catch: loadFailure(`Failed to read daemon-owned authority for Extension ${manifest.id}`),
    });
    const state = yield* decodeExtensionEnabledStateJson(authority.stateJson).pipe(
      Effect.mapError(loadFailure(`Failed to decode enabled state for Extension ${manifest.id}`)),
    );
    if (state.extensionId !== manifest.id) {
      return yield* fail(`Enabled state identity mismatch for Extension ${manifest.id}`);
    }
    if (!state.enabled) return [];

    const provenance = yield* decodeExtensionProvenanceJson(authority.provenanceJson).pipe(
      Effect.mapError(loadFailure(`Failed to decode provenance for Extension ${manifest.id}`)),
    );
    if (
      provenance.extensionId !== manifest.id ||
      provenance.extensionVersion !== manifest.version
    ) {
      return yield* fail(`Provenance identity mismatch for Extension ${manifest.id}`);
    }
    const tree = yield* Effect.tryPromise({
      try: () => readImmutableExtensionTree(file.rootPath),
      catch: loadFailure(`Failed to read immutable tree for Extension ${manifest.id}`),
    });
    return yield* validateAndLoadSkills(manifest, provenance, tree, file.contents);
  });
}

function validateAndLoadSkills(
  manifest: ExtensionManifest,
  provenance: ExtensionProvenance,
  tree: ExtensionTreeSnapshot,
  discoveredManifestBytes: Uint8Array,
): Effect.Effect<ReadonlyArray<LoadedExtensionSkill>, ExtensionSkillLoadError> {
  const sealed = validateSeal(manifest, provenance, tree.files);
  if (sealed !== undefined) return fail(sealed);
  const sealedManifest = tree.files.find((file) => file.path === "extension.json");
  if (
    sealedManifest === undefined ||
    !Buffer.from(sealedManifest.bytes).equals(Buffer.from(discoveredManifestBytes))
  ) {
    return fail("Extension manifest changed between discovery and sealed-tree validation");
  }
  const validation = validateExtensionPackageContent(manifest, tree);
  if (!validation.valid) return fail(validation.message);
  return Effect.succeed(validation.skills);
}

type ExtensionPackageContentValidation =
  | {
      readonly valid: true;
      readonly skills: ReadonlyArray<LoadedExtensionSkill>;
    }
  | {
      readonly valid: false;
      readonly message: string;
    };

export function validateExtensionPackageContent(
  manifest: ExtensionManifest,
  tree: ExtensionTreeSnapshot,
): ExtensionPackageContentValidation {
  const directoryError = validateDirectoryLayout(manifest, tree.directories);
  if (directoryError !== undefined) return invalidPackage(directoryError);
  for (const file of tree.files) {
    if (deriveFileKind(manifest, file.path) === undefined) {
      return invalidPackage(`Unknown immutable Extension file: ${file.path}`);
    }
  }

  const filesByPath = new Map(tree.files.map((file) => [file.path, file]));
  if (!filesByPath.has("extension.json")) return invalidPackage("Missing immediate extension.json");
  const loaded: LoadedExtensionSkill[] = [];
  for (const skill of manifest.skills) {
    const root = skill.path;
    if (posix.basename(root) !== skill.id) {
      return invalidPackage(`Skill root basename must match Skill id ${skill.id}`);
    }
    const skillPath = `${root}/SKILL.md`;
    const skillFile = filesByPath.get(skillPath);
    if (skillFile === undefined) return invalidPackage(`Missing immediate ${skillPath}`);
    const content = decodeUtf8Maybe(skillFile.bytes);
    if (content === undefined)
      return invalidPackage(`Skill content is not valid UTF-8: ${skillPath}`);
    const frontmatter = readSkillFrontmatter(content);
    if (frontmatter === undefined || frontmatter.name !== skill.id) {
      return invalidPackage(`Skill frontmatter name must match Skill id ${skill.id}`);
    }
    const reachabilityError = validateSkillReachability(root, skillPath, content, filesByPath);
    if (reachabilityError !== undefined) return invalidPackage(reachabilityError);
    loaded.push({ extensionId: manifest.id, id: skill.id, content });
  }
  for (const tool of manifest.tools ?? []) {
    const toolPath = `${tool.path}/tool.ts`;
    if (!filesByPath.has(toolPath)) return invalidPackage(`Missing immediate ${toolPath}`);
  }
  return { valid: true, skills: loaded };
}

function invalidPackage(message: string): ExtensionPackageContentValidation {
  return { valid: false, message };
}

function validateSeal(
  manifest: ExtensionManifest,
  provenance: ExtensionProvenance,
  files: ReadonlyArray<ExtensionFileSnapshot>,
): string | undefined {
  if (files.length !== provenance.files.length) return "Provenance file catalog is not exact";
  for (let index = 0; index < files.length; index += 1) {
    const actual = files[index];
    const expected = provenance.files[index];
    if (actual === undefined || expected === undefined || actual.path !== expected.path) {
      return "Provenance file catalog path mismatch";
    }
    const kind = deriveFileKind(manifest, actual.path);
    if (kind === undefined) return `Unknown immutable Extension file: ${actual.path}`;
    if (expected.kind !== kind) return `Provenance file kind mismatch: ${actual.path}`;
    if (actual.bytes.byteLength !== expected.bytes || sha256(actual.bytes) !== expected.sha256) {
      return `Sealed Extension file mutated: ${actual.path}`;
    }
  }
  if (computeTreeDigest(provenance.files) !== provenance.treeDigest) {
    return "Provenance tree digest mismatch";
  }
  return undefined;
}

function deriveFileKind(manifest: ExtensionManifest, path: string): string | undefined {
  if (path === "extension.json") return "manifest";
  for (const skill of manifest.skills) {
    if (path === `${skill.path}/SKILL.md`) return "skill";
    if (path.startsWith(`${skill.path}/`)) {
      const relative = path.slice(skill.path.length + 1);
      const supportRoot = relative.split("/")[0];
      return supportRoot === "references" || supportRoot === "scripts" || supportRoot === "assets"
        ? "support"
        : undefined;
    }
  }
  for (const tool of manifest.tools ?? []) {
    if (path === `${tool.path}/tool.ts`) return "tool";
    if (path.startsWith(`${tool.path}/`)) return "tool-dependency";
  }
  if (manifest.setup !== undefined && path.startsWith("setup/")) return "setup";
  return undefined;
}

function validateDirectoryLayout(
  manifest: ExtensionManifest,
  directories: ReadonlyArray<string>,
): string | undefined {
  const skillRoots = new Set(manifest.skills.map((skill) => skill.path));
  const toolRoots = new Set((manifest.tools ?? []).map((tool) => tool.path));
  for (const directory of directories) {
    if (directory === "skills" && manifest.skills.length > 0) continue;
    if (directory === "tools" && manifest.tools !== undefined) continue;
    if (directory === "setup" && manifest.setup !== undefined) continue;
    if (skillRoots.has(directory) || toolRoots.has(directory)) continue;
    const skill = manifest.skills.find((entry) => directory.startsWith(`${entry.path}/`));
    if (skill !== undefined) {
      const supportRoot = directory.slice(skill.path.length + 1).split("/")[0];
      if (supportRoot === "references" || supportRoot === "scripts" || supportRoot === "assets") {
        continue;
      }
      return `Unknown directory in Skill ${skill.id}: ${directory}`;
    }
    if ((manifest.tools ?? []).some((tool) => directory.startsWith(`${tool.path}/`))) continue;
    return `Unknown immutable Extension directory: ${directory}`;
  }
  return undefined;
}

function validateSkillReachability(
  root: string,
  skillPath: string,
  skillContent: string,
  filesByPath: ReadonlyMap<string, ExtensionFileSnapshot>,
): string | undefined {
  const supportPaths = [...filesByPath.keys()].filter((path) => path.startsWith(`${root}/`));
  for (const path of supportPaths) {
    if (path === skillPath) continue;
    const relative = path.slice(root.length + 1);
    const supportRoot = relative.split("/")[0];
    if (supportRoot !== "references" && supportRoot !== "scripts" && supportRoot !== "assets") {
      return `Unsupported Skill file: ${path}`;
    }
  }

  const reachable = new Set<string>([skillPath]);
  const active = new Set<string>();
  const visit = (path: string, content: string): string | undefined => {
    active.add(path);
    for (const destination of markdownDestinations(content, path === skillPath)) {
      if (isExternalDestination(destination)) continue;
      const resolved = resolveLocalDestination(root, path, destination);
      if (resolved === undefined) return `Unsupported local Skill link in ${path}: ${destination}`;
      const target = filesByPath.get(resolved);
      if (target === undefined) return `Dangling Skill link in ${path}: ${destination}`;
      if (active.has(resolved)) return `Cyclic Skill link: ${path} -> ${resolved}`;
      if (reachable.has(resolved)) continue;
      reachable.add(resolved);
      if (resolved.endsWith(".md")) {
        const targetContent = decodeUtf8Maybe(target.bytes);
        if (targetContent === undefined) return `Skill Markdown is not valid UTF-8: ${resolved}`;
        const error = visit(resolved, targetContent);
        if (error !== undefined) return error;
      }
    }
    active.delete(path);
    return undefined;
  };
  const traversalError = visit(skillPath, skillContent);
  if (traversalError !== undefined) return traversalError;
  const orphan = supportPaths.find((path) => !reachable.has(path));
  return orphan === undefined ? undefined : `Orphan Skill support file: ${orphan}`;
}

function markdownDestinations(markdown: string, hasFrontmatter: boolean): ReadonlyArray<string> {
  let body = hasFrontmatter ? stripFrontmatter(markdown) : markdown;
  body = body.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
  body = body.replace(/`[^`\n]*`/g, "");
  const destinations: string[] = [];
  for (const match of body.matchAll(/!?\[[^\]\r\n]*\]\(([^()\s]+)\)/g)) {
    const destination = match[1];
    if (destination !== undefined) destinations.push(destination);
  }
  return destinations;
}

function stripFrontmatter(content: string): string {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const end = normalized.indexOf("\n---\n", 4);
  return end === -1 ? normalized : normalized.slice(end + 5);
}

function readSkillFrontmatter(content: string): { readonly name: string } | undefined {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return undefined;
  const lines = normalized.slice(4, end).split("\n");
  const names = lines.flatMap((line) => {
    const match = /^name:\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === undefined) return [];
    return [unquoteYamlScalar(match[1])];
  });
  const descriptions = lines.filter((line) => /^description:\s*\S/.test(line));
  if (names.length !== 1 || names[0] === "" || descriptions.length !== 1) return undefined;
  return { name: names[0] ?? "" };
}

function unquoteYamlScalar(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isExternalDestination(destination: string): boolean {
  if (/^[A-Za-z]:/.test(destination)) return false;
  return destination.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination);
}

function resolveLocalDestination(
  root: string,
  sourcePath: string,
  destination: string,
): string | undefined {
  if (
    destination === "" ||
    destination.includes("?") ||
    destination.includes("#") ||
    destination.includes("\\") ||
    destination.includes("\0") ||
    destination.startsWith("/") ||
    /^[A-Za-z]:/.test(destination)
  ) {
    return undefined;
  }
  const encodedComponents = destination.split("/");
  if (encodedComponents.some((component) => component === "")) return undefined;
  const decodedComponents: string[] = [];
  for (const component of encodedComponents) {
    const decoded = decodeUriComponentMaybe(component);
    if (decoded === undefined) return undefined;
    if (
      decoded === "" ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("?") ||
      decoded.includes("#") ||
      decoded.includes("\0") ||
      (decodedComponents.length === 0 && /^[A-Za-z]:/.test(decoded)) ||
      decoded !== decoded.normalize("NFC")
    ) {
      return undefined;
    }
    decodedComponents.push(decoded);
  }
  const resolved = posix.join(posix.dirname(sourcePath), ...decodedComponents);
  return resolved === root || resolved.startsWith(`${root}/`) ? resolved : undefined;
}

export function computeTreeDigest(files: ReadonlyArray<ExtensionProvenanceFile>): string {
  const hash = createHash("sha256");
  hash.update("ziggy-extension-tree-v1\0");
  for (const file of files) {
    const path = Buffer.from(file.path);
    const kind = Buffer.from(file.kind);
    hash.update(unsignedInteger(path.byteLength, 4));
    hash.update(path);
    hash.update(unsignedInteger(kind.byteLength, 4));
    hash.update(kind);
    hash.update(unsignedInteger(file.bytes, 8));
    hash.update(Buffer.from(file.sha256, "hex"));
  }
  return hash.digest("hex");
}

function unsignedInteger(value: number, bytes: 4 | 8): Uint8Array {
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  if (bytes === 4) view.setUint32(0, value, false);
  else view.setBigUint64(0, BigInt(value), false);
  return new Uint8Array(buffer);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message: string): Effect.Effect<never, ExtensionSkillLoadError> {
  return Effect.fail(new ExtensionSkillLoadError({ message, cause: message }));
}

function loadFailure(message: string): (cause: unknown) => ExtensionSkillLoadError {
  return (cause) => new ExtensionSkillLoadError({ message, cause });
}
