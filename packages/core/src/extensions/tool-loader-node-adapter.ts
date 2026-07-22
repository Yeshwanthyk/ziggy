/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: filesystem and dynamic import APIs are Promise-only */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: Node and imported code reject through native exceptions */
/* oxlint-disable ziggy-effect/no-error-constructor -- boundary: Node rejects through native Error values */
/* oxlint-disable ziggy-effect/no-unknown-shape-probing -- boundary: dynamic import namespaces are normalized before domain validation */
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { JsonObject } from "@ziggy/protocol";
import { Result, Schema } from "effect";
import type { ExtensionFileSnapshot } from "./skill-loader-node-adapter.ts";
import { isStrictJson } from "./strict-json.ts";
import type { ExtensionToolContext, ExtensionToolDefinition } from "./tool.ts";

interface ExtensionToolModuleImport {
  readonly kind: "import-statement" | "dynamic-import" | "require-call";
  readonly path: string;
}

interface ExtensionToolModuleScan {
  readonly classification: "module" | "data";
  readonly imports: ReadonlyArray<ExtensionToolModuleImport>;
}

const decodeUnknownJsonResult = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

export interface ExtensionToolExecutionSnapshot {
  readonly rootPath: string;
  readonly entryPath: string;
}

export async function createExtensionToolExecutionSnapshot(
  extensionId: string,
  toolId: string,
  files: ReadonlyArray<ExtensionFileSnapshot>,
): Promise<ExtensionToolExecutionSnapshot> {
  const rootPath = await mkdtemp(join(tmpdir(), `ziggy-tool-${extensionId}-${toolId}-`));
  await chmod(rootPath, 0o700);
  const rootStatus = await stat(rootPath);
  if ((rootStatus.mode & 0o777) !== 0o700) {
    throw new Error(`Tool snapshot root isn't private: ${rootPath}`);
  }
  for (const file of files) {
    const destination = join(rootPath, file.path);
    await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 });
  }
  return { rootPath, entryPath: join(rootPath, "tool.ts") };
}

export async function canonicalizeExtensionToolProfilePath(profilePath: string): Promise<string> {
  return realpath(profilePath);
}

export async function removeExtensionToolExecutionSnapshot(rootPath: string): Promise<void> {
  await rm(rootPath, { recursive: true, force: true });
}

export async function importExtensionToolModule(entryPath: string): Promise<unknown> {
  return import(entryPath);
}

export interface ImportedExtensionToolModule {
  readonly exportNames: ReadonlyArray<string>;
  readonly defaultExport: unknown;
}

export function inspectImportedExtensionToolModule(imported: unknown): ImportedExtensionToolModule {
  if (typeof imported !== "object" || imported === null) {
    return { exportNames: [], defaultExport: undefined };
  }
  return {
    exportNames: Object.keys(imported).sort(),
    defaultExport: Reflect.get(imported, "default"),
  };
}

export async function invokeExtensionTool(
  execute: ExtensionToolDefinition["execute"],
  input: JsonObject,
  context: ExtensionToolContext,
): Promise<unknown> {
  return await execute(input, context);
}

export function scanExtensionToolModuleImports(
  path: string,
  bytes: Uint8Array,
): ExtensionToolModuleScan {
  const loader = moduleLoader(path);
  if (loader === undefined) return { classification: "data", imports: [] };
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const imports = new Bun.Transpiler({ loader }).scanImports(source);
    return {
      classification: "module",
      imports: imports.flatMap((entry) =>
        entry.kind === "import-statement" ||
        entry.kind === "dynamic-import" ||
        entry.kind === "require-call"
          ? [{ kind: entry.kind, path: entry.path }]
          : [],
      ),
    };
  } catch (cause) {
    if (extname(path).length === 0) return { classification: "data", imports: [] };
    throw cause;
  }
}

export function isExtensionToolBuiltinModule(specifier: string): boolean {
  return isBuiltin(specifier) || specifier === "bun" || specifier.startsWith("bun:");
}

export function inspectExtensionToolPackageJson(bytes: Uint8Array):
  | {
      readonly valid: true;
      readonly targets: ReadonlyArray<{ readonly field: string; readonly path: string }>;
    }
  | { readonly valid: false; readonly message: string } {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!isStrictJson(text)) return { valid: false, message: "isn't strict JSON" };
  const result = decodeUnknownJsonResult(text);
  if (Result.isFailure(result)) return { valid: false, message: "is malformed JSON" };
  const decoded = result.success;
  if (!isUnknownRecord(decoded)) return { valid: false, message: "must contain a JSON object" };
  const targets: Array<{ readonly field: string; readonly path: string }> = [];
  const entryFields: ReadonlyArray<"module" | "main"> = ["module", "main"];
  for (const field of entryFields) {
    const value = decoded[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) {
      return { valid: false, message: `${field} must be a non-empty string` };
    }
    targets.push({ field, path: value });
  }
  const exportsResult = collectPackageMappingTargets(decoded.exports, "exports", targets);
  if (exportsResult !== undefined) return { valid: false, message: exportsResult };
  const imports = decoded.imports;
  if (imports !== undefined) {
    if (!isUnknownRecord(imports)) {
      return { valid: false, message: "imports must be an object" };
    }
    for (const [key, value] of Object.entries(imports)) {
      if (!key.startsWith("#") || key === "#" || key.startsWith("#/")) {
        return { valid: false, message: `imports has unsupported key ${key}` };
      }
      const error = collectPackageMappingTargets(value, `imports.${key}`, targets);
      if (error !== undefined) return { valid: false, message: error };
    }
  }
  return { valid: true, targets };
}

function collectPackageMappingTargets(
  value: unknown,
  field: string,
  targets: Array<{ readonly field: string; readonly path: string }>,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value.length === 0 || value.includes("*")) return `${field} has an unsupported target`;
    targets.push({ field, path: value });
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${field} has an unsupported empty target array`;
    for (const [index, item] of value.entries()) {
      const error = collectPackageMappingTargets(item, `${field}[${index}]`, targets);
      if (error !== undefined) return error;
    }
    return undefined;
  }
  if (!isUnknownRecord(value)) return `${field} has an unsupported target`;
  const entries = Object.entries(value);
  if (entries.length === 0) return `${field} has an unsupported empty target object`;
  for (const [key, item] of entries) {
    if (key.length === 0 || key.includes("\\") || key.includes("..")) {
      return `${field} has unsupported key ${key}`;
    }
    const error = collectPackageMappingTargets(item, `${field}.${key}`, targets);
    if (error !== undefined) return error;
  }
  return undefined;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function moduleLoader(path: string): "js" | "jsx" | "ts" | "tsx" | undefined {
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "js";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "ts";
  if (path.endsWith(".tsx")) return "tsx";
  return extname(path).length === 0 ? "js" : undefined;
}
