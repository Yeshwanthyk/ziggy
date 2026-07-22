import { readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parseSync, Visitor, type Argument, type Expression } from "oxc-parser";
import { isCanonicalSemVer } from "../../packages/core/src/extensions/semver.ts";

const expectedPackageNames: Readonly<Record<string, string>> = {
  core: "@ziggy/core",
  protocol: "@ziggy/protocol",
  tui: "@ziggy/tui",
  ziggy: "@ziggy/ziggy",
};
const allowedEdges: Readonly<Record<string, ReadonlyArray<string>>> = {
  "@ziggy/core": ["@ziggy/protocol"],
  "@ziggy/protocol": [],
  "@ziggy/tui": ["@ziggy/protocol"],
  "@ziggy/ziggy": ["@ziggy/core", "@ziggy/protocol", "@ziggy/tui"],
};
const expectedBunVersion = "1.3.13";
const forbiddenDependencies = new Set(["@effect/platform", "@effect/schema"]);
const nodeBuiltins = new Set(builtinModules.map(normalizeNodeBuiltin));
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
type DependencyField = (typeof dependencyFields)[number];

export interface ImportReference {
  readonly sourceFile: string;
  readonly specifier: string;
}

export interface PackageDescription {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly dependencyGroups: Readonly<Record<DependencyField, Readonly<Record<string, string>>>>;
  readonly imports: ReadonlyArray<ImportReference>;
}

export interface PackageGraph {
  readonly root: string;
  readonly rootVersion: string;
  readonly rootWorkspaces: ReadonlyArray<string>;
  readonly rootDependencyGroups: Readonly<
    Record<DependencyField, Readonly<Record<string, string>>>
  >;
  readonly packageManager: string;
  readonly bunEngine: string;
  readonly runtimeBunVersion: string;
  readonly packages: ReadonlyArray<PackageDescription>;
  readonly hasPackagesTestkit: boolean;
}

export async function loadPackageGraph(root: string): Promise<PackageGraph> {
  const rootManifest = requireRecord(
    JSON.parse(await Bun.file(join(root, "package.json")).text()),
    "root package.json",
  );
  const packagesRoot = join(root, "packages");
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const packages: PackageDescription[] = [];
  for (const directory of directories) {
    const packageRoot = join(packagesRoot, directory);
    const manifest = decodePackageManifest(
      JSON.parse(await Bun.file(join(packageRoot, "package.json")).text()),
      directory,
    );
    packages.push({
      directory,
      name: manifest.name,
      version: manifest.version,
      dependencyGroups: manifest.dependencyGroups,
      imports: await collectImports(join(packageRoot, "src"), root),
    });
  }
  const engines = requireRecord(rootManifest.engines, "root engines");
  return {
    root,
    rootVersion: requireString(rootManifest.version, "root version"),
    rootWorkspaces: decodeStringArray(rootManifest.workspaces, "root workspaces"),
    rootDependencyGroups: decodeDependencyGroups(rootManifest, "root"),
    packageManager: requireString(rootManifest.packageManager, "root packageManager"),
    bunEngine: requireString(engines.bun, "root engines.bun"),
    runtimeBunVersion: Bun.version,
    packages,
    hasPackagesTestkit: directories.includes("testkit"),
  };
}

export function validatePackageGraph(graph: PackageGraph): void {
  validateBunToolchain(graph);
  if (!isCanonicalSemVer(graph.rootVersion)) {
    throw new Error(`root package version must be canonical SemVer, got ${graph.rootVersion}`);
  }
  if (graph.rootWorkspaces.length !== 1 || graph.rootWorkspaces[0] !== "packages/*") {
    throw new Error("root workspaces must be exactly packages/*");
  }
  const expectedDirectories = Object.keys(expectedPackageNames).sort();
  const actualDirectories = graph.packages.map((item) => item.directory).sort();
  if (
    actualDirectories.length !== expectedDirectories.length ||
    actualDirectories.some((directory, index) => directory !== expectedDirectories[index])
  ) {
    throw new Error(`workspace directories must be exactly ${expectedDirectories.join(", ")}`);
  }
  if (graph.hasPackagesTestkit) {
    throw new Error("packages/testkit is forbidden");
  }

  validateDependencyGroups("root", graph.rootDependencyGroups, []);
  for (const item of graph.packages) {
    const expectedName = expectedPackageNames[item.directory];
    if (expectedName === undefined || item.name !== expectedName) {
      throw new Error(`${item.directory}: package name must be ${expectedName ?? "known"}`);
    }
    if (item.version !== graph.rootVersion) {
      throw new Error(
        `${item.name}: workspace version must mirror root version ${graph.rootVersion}`,
      );
    }
    const allowed = allowedEdges[item.name];
    if (allowed === undefined) {
      throw new Error(`unknown package ${item.name}`);
    }
    validateDependencyGroups(item.name, item.dependencyGroups, allowed);
    const declared = mergeDependencyGroups(item.dependencyGroups);

    for (const reference of item.imports) {
      validateImport(graph, item, reference, declared, allowed);
    }
  }
}

export async function collectTypeScriptImports(
  root: string,
  files: ReadonlyArray<string>,
): Promise<ReadonlyArray<ImportReference>> {
  const references: ImportReference[] = [];
  for (const file of files) {
    const sourceFile = relative(root, file);
    const result = parseSync(file, await Bun.file(file).text(), {
      lang: extname(file) === ".tsx" ? "tsx" : "ts",
      sourceType: "unambiguous",
    });
    if (result.errors.length > 0) {
      const diagnostics = result.errors.map((diagnostic) => diagnostic.message).join("; ");
      throw new Error(`${sourceFile}: Oxc parser diagnostic: ${diagnostics}`);
    }
    references.push(...collectModuleSpecifiers(result.program, sourceFile));
  }
  return references;
}

function collectModuleSpecifiers(
  program: ReturnType<typeof parseSync>["program"],
  sourceFile: string,
): ReadonlyArray<ImportReference> {
  const references: ImportReference[] = [];
  const addStaticSpecifier = (node: Expression | Argument, syntax: "import" | "require"): void => {
    if (node.type === "Literal" && typeof node.value === "string") {
      references.push({ sourceFile, specifier: node.value });
      return;
    }
    if (
      node.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      node.quasis.length === 1
    ) {
      const quasi = node.quasis[0];
      if (quasi !== undefined && quasi.value.cooked !== null) {
        references.push({ sourceFile, specifier: quasi.value.cooked });
        return;
      }
    }
    throw new Error(`${sourceFile}: ${syntax} specifier must be a static string literal`);
  };
  new Visitor({
    ImportDeclaration(node) {
      addStaticSpecifier(node.source, "import");
    },
    ExportNamedDeclaration(node) {
      if (node.source !== null) {
        addStaticSpecifier(node.source, "import");
      }
    },
    ExportAllDeclaration(node) {
      addStaticSpecifier(node.source, "import");
    },
    TSImportEqualsDeclaration(node) {
      if (node.moduleReference.type === "TSExternalModuleReference") {
        addStaticSpecifier(node.moduleReference.expression, "require");
      }
    },
    ImportExpression(node) {
      if (isApprovedExtensionToolRuntimeImport(sourceFile, node.source)) return;
      addStaticSpecifier(node.source, "import");
    },
    CallExpression(node) {
      const callee = node.callee;
      const isBareRequire = callee.type === "Identifier" && callee.name === "require";
      const isCommonJsMember =
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        callee.property.type === "Identifier" &&
        ((callee.object.name === "module" && callee.property.name === "require") ||
          (callee.object.name === "require" && callee.property.name === "resolve"));
      if (!isBareRequire && !isCommonJsMember) {
        return;
      }
      if (node.arguments.length !== 1) {
        throw new Error(`${sourceFile}: require must have exactly one specifier argument`);
      }
      const argument = node.arguments[0];
      if (argument === undefined) {
        throw new Error(`${sourceFile}: module specifier argument is required`);
      }
      addStaticSpecifier(argument, "require");
    },
  }).visit(program);
  return references;
}

function isApprovedExtensionToolRuntimeImport(sourceFile: string, source: Expression): boolean {
  return (
    sourceFile === "packages/core/src/extensions/tool-loader-node-adapter.ts" &&
    source.type === "Identifier" &&
    source.name === "entryPath"
  );
}

export function isExactVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

function validateBunToolchain(graph: PackageGraph): void {
  const authorities: ReadonlyArray<readonly [string, string | undefined, string]> = [
    ["packageManager", graph.packageManager, `bun@${expectedBunVersion}`],
    ["engines.bun", graph.bunEngine, expectedBunVersion],
    [
      "devDependencies.@types/bun",
      graph.rootDependencyGroups.devDependencies["@types/bun"],
      expectedBunVersion,
    ],
    ["runtime", graph.runtimeBunVersion, expectedBunVersion],
  ];
  for (const [source, actual, expected] of authorities) {
    if (actual !== expected) {
      throw new Error(
        `Bun toolchain mismatch: ${source} must be ${expected}, got ${actual ?? "missing"}`,
      );
    }
  }
}

async function collectImports(
  directory: string,
  root: string,
): Promise<ReadonlyArray<ImportReference>> {
  return collectTypeScriptImports(root, await walkTypeScript(directory));
}

function validateDependencyGroups(
  owner: string,
  groups: Readonly<Record<DependencyField, Readonly<Record<string, string>>>>,
  allowedInternal: ReadonlyArray<string>,
): void {
  const seen = new Set<string>();
  for (const field of dependencyFields) {
    for (const [dependency, version] of Object.entries(groups[field])) {
      if (seen.has(dependency)) {
        throw new Error(`${owner}: dependency ${dependency} is declared in multiple fields`);
      }
      seen.add(dependency);
      if (forbiddenDependencies.has(dependency)) {
        throw new Error(`${owner}: forbidden dependency ${dependency}`);
      }
      if (dependency.startsWith("@ziggy/")) {
        if (!allowedInternal.includes(dependency)) {
          throw new Error(`${owner}: forbidden internal edge to ${dependency}`);
        }
        if (version !== "workspace:*") {
          throw new Error(`${owner}: workspace dependency ${dependency} must use workspace:*`);
        }
      } else if (!isExactVersion(version)) {
        throw new Error(`${owner}: external dependency ${dependency} must be exact`);
      }
    }
  }
}

function validateImport(
  graph: PackageGraph,
  item: PackageDescription,
  reference: ImportReference,
  declared: Readonly<Record<string, string>>,
  allowed: ReadonlyArray<string>,
): void {
  const specifier = reference.specifier;
  if (specifier.startsWith(".")) {
    const target = normalize(resolve(graph.root, dirname(reference.sourceFile), specifier));
    if (!pathIsWithin(graph.root, target)) {
      throw new Error(
        `${item.name}: production relative import escapes repository (${reference.specifier})`,
      );
    }
    rejectProductionBoundaryImport(graph.root, item, target, reference);
    if (isRootProductVersionImport(graph, item, target, reference)) return;
    const targetPackage = packageContaining(graph, target);
    if (targetPackage === undefined) {
      throw new Error(
        `${item.name}: relative production import must target a known workspace package (${reference.specifier})`,
      );
    }
    if (targetPackage.name !== item.name) {
      if (!allowed.includes(targetPackage.name)) {
        throw new Error(
          `${item.name}: forbidden relative cross-package import to ${targetPackage.name}`,
        );
      }
      if (!(targetPackage.name in declared)) {
        throw new Error(
          `${item.name}: relative workspace import ${targetPackage.name} is undeclared`,
        );
      }
    }
    return;
  }
  if (isAbsolute(specifier)) {
    throw new Error(`${item.name}: absolute production import is forbidden`);
  }
  const internal = internalPackageName(specifier);
  if (internal !== undefined) {
    if (!(internal in declared)) {
      throw new Error(`${item.name}: workspace import ${internal} is undeclared`);
    }
    if (!allowed.includes(internal)) {
      throw new Error(`${item.name}: forbidden internal import ${internal}`);
    }
    return;
  }
  if (isNodeBuiltin(specifier)) {
    return;
  }
  const external = externalPackageName(specifier);
  if (!(external in declared)) {
    throw new Error(`${item.name}: external import ${external} is undeclared`);
  }
}

function isRootProductVersionImport(
  graph: PackageGraph,
  item: PackageDescription,
  target: string,
  reference: ImportReference,
): boolean {
  return (
    item.name === "@ziggy/core" &&
    reference.sourceFile === "packages/core/src/product-version.ts" &&
    reference.specifier === "../../../package.json" &&
    target === normalize(join(graph.root, "package.json"))
  );
}

function rejectProductionBoundaryImport(
  root: string,
  item: PackageDescription,
  target: string,
  reference: ImportReference,
): void {
  for (const directory of ["tests", "tooling", "verification"]) {
    const boundary = join(root, directory);
    const contained = relative(boundary, target);
    if (
      contained === "" ||
      (!contained.startsWith(`..${sep}`) && contained !== ".." && !isAbsolute(contained))
    ) {
      throw new Error(
        `${item.name}: production import from ${directory} is forbidden (${reference.specifier})`,
      );
    }
  }
}

function packageContaining(graph: PackageGraph, target: string): PackageDescription | undefined {
  for (const candidate of graph.packages) {
    const packageRoot = join(graph.root, "packages", candidate.directory);
    if (pathIsWithin(packageRoot, target)) {
      return candidate;
    }
  }
  return undefined;
}

function pathIsWithin(parent: string, target: string): boolean {
  const contained = relative(parent, target);
  return (
    contained === "" ||
    (!contained.startsWith(`..${sep}`) && contained !== ".." && !isAbsolute(contained))
  );
}

function internalPackageName(specifier: string): string | undefined {
  if (!specifier.startsWith("@ziggy/")) {
    return undefined;
  }
  return specifier.split("/").slice(0, 2).join("/");
}

function externalPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0] ?? specifier;
}

function isNodeBuiltin(specifier: string): boolean {
  return nodeBuiltins.has(normalizeNodeBuiltin(specifier));
}

function normalizeNodeBuiltin(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

async function walkTypeScript(directory: string): Promise<ReadonlyArray<string>> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTypeScript(path)));
    } else if (entry.isFile() && [".ts", ".tsx", ".mts", ".cts"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function decodePackageManifest(
  value: unknown,
  source: string,
): {
  name: string;
  version: string;
  dependencyGroups: Readonly<Record<DependencyField, Readonly<Record<string, string>>>>;
} {
  const record = requireRecord(value, `${source} package.json`);
  if (typeof record.name !== "string") {
    throw new Error(`${source}: package name is required`);
  }
  return {
    name: record.name,
    version: requireString(record.version, `${source} version`),
    dependencyGroups: decodeDependencyGroups(record, source),
  };
}

function decodeDependencyGroups(
  record: Record<string, unknown>,
  source: string,
): Readonly<Record<DependencyField, Readonly<Record<string, string>>>> {
  return {
    dependencies: decodeDependencies(record.dependencies, `${source} dependencies`),
    devDependencies: decodeDependencies(record.devDependencies, `${source} devDependencies`),
    peerDependencies: decodeDependencies(record.peerDependencies, `${source} peerDependencies`),
    optionalDependencies: decodeDependencies(
      record.optionalDependencies,
      `${source} optionalDependencies`,
    ),
  };
}

function mergeDependencyGroups(
  groups: Readonly<Record<DependencyField, Readonly<Record<string, string>>>>,
): Readonly<Record<string, string>> {
  return {
    ...groups.dependencies,
    ...groups.devDependencies,
    ...groups.peerDependencies,
    ...groups.optionalDependencies,
  };
}

function decodeDependencies(value: unknown, source: string): Readonly<Record<string, string>> {
  if (value === undefined) {
    return {};
  }
  const record = requireRecord(value, source);
  const decoded: Record<string, string> = {};
  for (const [name, version] of Object.entries(record)) {
    if (typeof version !== "string") {
      throw new Error(`${source}: dependency ${name} must have a string version`);
    }
    decoded[name] = version;
  }
  return decoded;
}

function decodeStringArray(value: unknown, source: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${source} must be a string array`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      result.push(item);
    }
  }
  return result;
}

function requireRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requireString(value: unknown, source: string): string {
  if (typeof value !== "string") {
    throw new Error(`${source} must be a string`);
  }
  return value;
}

if (import.meta.main) {
  const root = new URL("../..", import.meta.url).pathname;
  validatePackageGraph(await loadPackageGraph(root));
  console.log("package graph: ok");
}
