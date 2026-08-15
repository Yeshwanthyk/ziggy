import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  compiledAssetPath,
  compiledPiTuiPackageLayout,
  compiledPiTuiRuntime,
  leaseCompiledPiTuiAssets,
  materializeCompiledPiTuiPackageDir,
  piBuiltinDarkThemePath,
  piBuiltinLightThemePath,
} from "ziggy/adapters/pi/tui-themes";

const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
const originalOffline = process.env.PI_OFFLINE;
const originalVersionCheck = process.env.PI_SKIP_VERSION_CHECK;

const env = (name: "PI_PACKAGE_DIR" | "PI_OFFLINE" | "PI_SKIP_VERSION_CHECK"): string | undefined =>
  process.env[name];

afterEach(() => {
  if (originalPiPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
  else process.env.PI_PACKAGE_DIR = originalPiPackageDir;
  if (originalOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = originalOffline;
  if (originalVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
  else process.env.PI_SKIP_VERSION_CHECK = originalVersionCheck;
});

const decodeThemeName = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

describe("compiled Pi TUI package layout", () => {
  test("writes Pi 0.84.1 compiled sidecar files under the package root", async () => {
    const destRoot = await mkdtemp(join(tmpdir(), "ziggy-pi-tui-assets-"));
    try {
      expect(await materializeCompiledPiTuiPackageDir(destRoot)).toBe(destRoot);
      expect([...compiledPiTuiPackageLayout]).toEqual([
        "theme/dark.json",
        "theme/light.json",
        "assets/clankolas.png",
        "export-html/template.css",
        "export-html/template.html",
        "export-html/template.js",
        "export-html/vendor/highlight.min.js",
        "export-html/vendor/marked.min.js",
      ]);
      expect(decodeThemeName(await readFile(join(destRoot, "theme", "dark.json"), "utf8"))).toEqual(
        {
          name: "dark",
        },
      );
      expect(
        decodeThemeName(await readFile(join(destRoot, "theme", "light.json"), "utf8")),
      ).toEqual({
        name: "light",
      });
      expect(await readFile(join(destRoot, "assets", "clankolas.png"))).not.toHaveLength(0);
      expect(
        await readFile(join(destRoot, "export-html", "vendor", "marked.min.js")),
      ).not.toHaveLength(0);
    } finally {
      await rm(destRoot, { recursive: true });
    }
  });
});

describe("leaseCompiledPiTuiAssets", () => {
  test("leaves an already-set PI_PACKAGE_DIR unchanged", async () => {
    process.env.PI_PACKAGE_DIR = "/already/set";
    const lease = await leaseCompiledPiTuiAssets(true);
    expect(lease.packageDirectory).toBeUndefined();
    expect(process.env.PI_PACKAGE_DIR).toBe("/already/set");
    await lease.release();
    expect(process.env.PI_PACKAGE_DIR).toBe("/already/set");
  });

  test("does not set PI_PACKAGE_DIR from source-mode file paths", async () => {
    delete process.env.PI_PACKAGE_DIR;
    expect(piBuiltinDarkThemePath.endsWith("/theme/dark.json")).toBe(true);
    expect(piBuiltinLightThemePath.endsWith("/theme/light.json")).toBe(true);
    expect(compiledAssetPath(piBuiltinDarkThemePath)).toBe(false);
    expect(compiledAssetPath(piBuiltinLightThemePath)).toBe(false);
    expect(compiledPiTuiRuntime()).toBe(false);
    const lease = await leaseCompiledPiTuiAssets();
    expect(lease.packageDirectory).toBeUndefined();
    expect(process.env.PI_PACKAGE_DIR).toBeUndefined();
    await lease.release();
    expect(process.env.PI_PACKAGE_DIR).toBeUndefined();
  });

  test("compiled lease sets env, then restores it and removes the temp layout", async () => {
    delete process.env.PI_PACKAGE_DIR;
    delete process.env.PI_OFFLINE;
    delete process.env.PI_SKIP_VERSION_CHECK;
    const lease = await leaseCompiledPiTuiAssets(true);
    const packageDirectory = lease.packageDirectory;
    if (packageDirectory === undefined) {
      throw new Error("compiled lease did not materialize a package directory");
    }
    expect(env("PI_PACKAGE_DIR")).toBe(packageDirectory);
    expect(env("PI_OFFLINE")).toBe("1");
    expect(env("PI_SKIP_VERSION_CHECK")).toBe("1");
    expect(
      decodeThemeName(await readFile(join(packageDirectory, "theme", "dark.json"), "utf8")),
    ).toEqual({
      name: "dark",
    });
    await lease.release();
    expect(env("PI_PACKAGE_DIR")).toBeUndefined();
    expect(env("PI_OFFLINE")).toBeUndefined();
    expect(env("PI_SKIP_VERSION_CHECK")).toBeUndefined();
    await expect(access(packageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
