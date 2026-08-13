import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import darkThemeFile from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json" with { type: "file" };
import lightThemeFile from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json" with { type: "file" };
import clankolasFile from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/assets/clankolas.png" with { type: "file" };
import exportCssFile from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.css" with { type: "file" };
import exportHtmlFile from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.html" with { type: "file" };
import exportJsFile from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.js" with { type: "file" };
import highlightJsFile from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/vendor/highlight.min.js" with { type: "file" };
import markedJsFile from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/vendor/marked.min.js" with { type: "file" };
import photonWasmFile from "../../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" };

// Bun `{ type: "file" }` yields a path string. TypeScript types resolved `.json` files as
// parsed objects and does not honor ambient `*theme/*.json` modules for those specifiers.
export const piBuiltinDarkThemePath: string = `${darkThemeFile}`;
export const piBuiltinLightThemePath: string = `${lightThemeFile}`;
export const piBuiltinClankolasPath: string = `${clankolasFile}`;
export const piBuiltinExportCssPath: string = `${exportCssFile}`;
export const piBuiltinExportHtmlPath: string = `${exportHtmlFile}`;
export const piBuiltinExportJsPath: string = `${exportJsFile}`;
export const piBuiltinHighlightJsPath: string = `${highlightJsFile}`;
export const piBuiltinMarkedJsPath: string = `${markedJsFile}`;
export const piBuiltinPhotonWasmPath: string = `${photonWasmFile}`;

/** Compiled Bun TUI layout under `PI_PACKAGE_DIR` (`isBunBinary` in Pi 0.84.1). */
export const compiledPiTuiPackageLayout = [
  "theme/dark.json",
  "theme/light.json",
  "assets/clankolas.png",
  "export-html/template.css",
  "export-html/template.html",
  "export-html/template.js",
  "export-html/vendor/highlight.min.js",
  "export-html/vendor/marked.min.js",
] as const;

const compiledPiTuiAssets = [
  [piBuiltinDarkThemePath, "theme/dark.json"],
  [piBuiltinLightThemePath, "theme/light.json"],
  [piBuiltinClankolasPath, "assets/clankolas.png"],
  [piBuiltinExportCssPath, "export-html/template.css"],
  [piBuiltinExportHtmlPath, "export-html/template.html"],
  [piBuiltinExportJsPath, "export-html/template.js"],
  [piBuiltinHighlightJsPath, "export-html/vendor/highlight.min.js"],
  [piBuiltinMarkedJsPath, "export-html/vendor/marked.min.js"],
] as const;

/** True when Bun compiled the asset into the virtual filesystem. */
export const compiledAssetPath = (path: string): boolean =>
  path.includes("$bunfs") || path.includes("~BUN") || path.includes("%7EBUN");

export const compiledPiTuiRuntime = (
  darkPath: string = piBuiltinDarkThemePath,
  lightPath: string = piBuiltinLightThemePath,
): boolean => compiledAssetPath(darkPath) || compiledAssetPath(lightPath);

export interface CompiledPiTuiAssetsLease {
  readonly packageDirectory: string | undefined;
  readonly release: () => Promise<void>;
}

const noopLease: CompiledPiTuiAssetsLease = {
  packageDirectory: undefined,
  release: async () => undefined,
};

const restoreProcessEnv = (
  name: "PI_PACKAGE_DIR" | "PI_OFFLINE" | "PI_SKIP_VERSION_CHECK",
  previous: string | undefined,
): void => {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
};

/** Write embedded TUI/runtime files into Pi's compiled sidecar layout. */
export const materializeCompiledPiTuiPackageDir = async (destRoot: string): Promise<string> => {
  for (const [embeddedPath, relativePath] of compiledPiTuiAssets) {
    const destinationPath = join(destRoot, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    // copyFileSync cannot read Bun's compiled `$bunfs` file embeds; read/write can.
    await writeFile(destinationPath, await readFile(embeddedPath), { flag: "wx" });
  }
  return destRoot;
};

/**
 * Point Pi's compiled package lookup at builtin TUI/runtime files for this `openTui` call.
 * Source mode must leave `PI_PACKAGE_DIR` unset so Pi keeps its npm layout.
 * Compiled Bun flattens `type: "file"` embeds under `/$bunfs/root`, so those bytes are
 * copied into a physical `theme/` / `assets/` / `export-html/` tree Pi can
 * `readFileSync`. Release restores env and removes the temp layout.
 */
export const leaseCompiledPiTuiAssets = async (
  compiled: boolean = compiledPiTuiRuntime(),
): Promise<CompiledPiTuiAssetsLease> => {
  const existing = process.env.PI_PACKAGE_DIR;
  if ((existing !== undefined && existing !== "") || !compiled) {
    return noopLease;
  }

  const packageDirectory = await mkdtemp(join(tmpdir(), "ziggy-pi-tui-assets-"));
  const previousPackageDirectory = process.env.PI_PACKAGE_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  const previousVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
  const restoreEnvironment = () => {
    restoreProcessEnv("PI_PACKAGE_DIR", previousPackageDirectory);
    restoreProcessEnv("PI_OFFLINE", previousOffline);
    restoreProcessEnv("PI_SKIP_VERSION_CHECK", previousVersionCheck);
  };

  try {
    await materializeCompiledPiTuiPackageDir(packageDirectory);
    process.env.PI_PACKAGE_DIR = packageDirectory;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    return {
      packageDirectory,
      release: async () => {
        restoreEnvironment();
        await rm(packageDirectory, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    restoreEnvironment();
    await rm(packageDirectory, { recursive: true, force: true });
    throw cause;
  }
};
