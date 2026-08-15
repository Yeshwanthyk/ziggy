import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapPiStandaloneRuntime,
  installCompiledPhotonWasmFallback,
} from "ziggy/adapters/pi/standalone-runtime";

describe("bootstrapPiStandaloneRuntime", () => {
  test("source-mode URLs do not register providers", () => {
    let registered = 0;
    bootstrapPiStandaloneRuntime("file:///Users/yesh/code/personal/ziggy/src/main.ts", () => {
      registered += 1;
    });
    expect(registered).toBe(0);
  });

  test("compiled Bun URLs register OAuth and Bedrock", () => {
    let registered = 0;
    bootstrapPiStandaloneRuntime("/$bunfs/root/src/main.ts", () => {
      registered += 1;
    });
    expect(registered).toBe(1);
  });
});

test("compiled Photon reads fall back to the embedded WASM only on ENOENT", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-photon-fallback-"));
  const embeddedWasm = join(root, "embedded.wasm");
  const fileSystem = process.getBuiltinModule("fs");
  const originalReadFileSync = fileSystem.readFileSync;
  try {
    await writeFile(embeddedWasm, "embedded-photon");
    installCompiledPhotonWasmFallback(fileSystem, embeddedWasm);

    expect(fileSystem.readFileSync(join(root, "missing", "photon_rs_bg.wasm"), "utf8")).toBe(
      "embedded-photon",
    );
    expect(() => fileSystem.readFileSync(join(root, "missing.txt"), "utf8")).toThrow();
    expect(() => fileSystem.readFileSync(root, "utf8")).toThrow();
  } finally {
    Object.defineProperty(fileSystem, "readFileSync", {
      configurable: true,
      value: originalReadFileSync,
      writable: true,
    });
    await rm(root, { force: true, recursive: true });
  }
});
