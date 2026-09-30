import path from "node:path";
import { toRepoRelative } from "../../effect/utils.mjs";

/** Folders whose files are private: code outside a folder imports only its `index.ts`. */
const conceptFolders = ["profile", "session", "extensions", "agents", "memory"];

/** Files outside `src/adapters/pi/` that may import Pi (the `[Pi]` files in the tight-core plan). */
const piFiles = new Set([
  "src/session/runtime.ts",
  "src/session/handle.ts",
  "src/session/agent.ts",
  "src/session/tools.ts",
  "src/extensions/loader.ts",
  "src/extensions/tool.ts",
  "src/agents/run.ts",
  "src/agents/tools.ts",
  "src/memory/tool.ts",
]);

const isPiPackage = (specifier) => specifier.startsWith("@earendil-works/");

const mayImportPi = (file) => file.startsWith("src/adapters/pi/") || piFiles.has(file);

/** `src/...` path an import points at, or undefined for packages. */
const importedSourcePath = (file, specifier) => {
  if (specifier.startsWith("ziggy/")) return `src/${specifier.slice("ziggy/".length)}`;

  if (!specifier.startsWith(".")) return undefined;

  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
};

const topFolder = (sourcePath) => sourcePath.split("/")[1];

const isPlatformDependency = (specifier, target) =>
  target === undefined
    ? specifier === "effect" || specifier.startsWith("node:") || specifier.startsWith("bun:")
    : target.startsWith("src/platform/");

const isFolderEntry = (target, folder) =>
  target === `src/${folder}` ||
  target === `src/${folder}/index` ||
  target === `src/${folder}/index.ts`;

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep Pi behind the [Pi] files, keep platform/ free of Ziggy code, and reach a concept folder only through its index.ts.",
    },
    messages: {
      pi: "Only src/adapters/pi/** and the [Pi] files may import Pi packages.",
      platform:
        "src/platform/ holds shared low-level pieces: import only effect, node:*, bun:* and other platform files.",
      folder: "Import {{folder}}/ through its index.ts, not {{target}}.",
    },
  },
  create(context) {
    const file = toRepoRelative(context.filename);

    if (!file.startsWith("src/") || file.startsWith("src/generated/")) return {};

    const check = (node, source) => {
      if (source?.type !== "Literal" || source.value !== String(source.value)) return;
      const specifier = source.value;
      const target = importedSourcePath(file, specifier);

      if (isPiPackage(specifier) && !mayImportPi(file)) {
        context.report({ node, messageId: "pi" });
      }

      if (file.startsWith("src/platform/") && !isPlatformDependency(specifier, target)) {
        context.report({ node, messageId: "platform" });
      }

      if (target === undefined) return;
      const folder = topFolder(target);

      if (
        conceptFolders.includes(folder) &&
        topFolder(file) !== folder &&
        !isFolderEntry(target, folder)
      ) {
        context.report({ node, messageId: "folder", data: { folder, target } });
      }
    };

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
    };
  },
};
